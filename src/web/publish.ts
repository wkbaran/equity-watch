/**
 * Sync the static site to S3, fronted by CloudFront (see infra/cloudformation.yaml).
 *
 * Adapted from uniquetrades-congress's publisher, with one deliberate
 * difference: no CloudFront invalidation. That site publishes weekly; this one
 * can publish every few minutes, and invalidations past 1,000 paths a month
 * are billed. Every object is uploaded with `Cache-Control: no-cache` instead,
 * so CloudFront revalidates against S3 on each request and a fresh
 * dashboard.json is visible on the page's next poll.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { DeleteObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

export interface SyncPlan {
  upload: string[];
  remove: string[];
  unchanged: number;
}

/**
 * Local key -> md5, remote key -> ETag. A single-part PutObject's ETag is the
 * body's md5, which is all this publisher ever writes.
 */
export function planSync(local: Map<string, string>, remote: Map<string, string>): SyncPlan {
  const upload = [...local].filter(([key, md5]) => remote.get(key) !== md5).map(([key]) => key);
  const remove = [...remote.keys()].filter((key) => !local.has(key));
  return { upload, remove, unchanged: local.size - upload.length };
}

export interface PublishOptions {
  localDir: string;
  bucket?: string;
  region?: string;
  prefix?: string;
}

export async function publishSite(opts: PublishOptions): Promise<SyncPlan> {
  const bucket = opts.bucket ?? process.env.S3_BUCKET;
  if (!bucket) {
    throw new Error("S3 bucket is required. Set S3_BUCKET in .env (see infra/cloudformation.yaml outputs).");
  }
  const region = opts.region ?? process.env.AWS_REGION ?? "us-east-1";
  const prefix = opts.prefix ?? process.env.S3_PREFIX ?? "";
  const localDir = resolve(opts.localDir);
  const client = new S3Client({ region });

  const paths = new Map<string, string>();
  const local = new Map<string, string>();
  for (const file of walk(localDir)) {
    const rel = relative(localDir, file).replace(/\\/g, "/");
    const key = prefix ? `${prefix}/${rel}` : rel;
    paths.set(key, file);
    local.set(key, createHash("md5").update(readFileSync(file)).digest("hex"));
  }

  const remote = new Map<string, string>();
  let token: string | undefined;
  do {
    const resp = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix || undefined, ContinuationToken: token })
    );
    for (const obj of resp.Contents ?? []) {
      if (obj.Key && obj.ETag) {
        remote.set(obj.Key, obj.ETag.replace(/"/g, ""));
      }
    }
    token = resp.NextContinuationToken;
  } while (token);

  const plan = planSync(local, remote);
  for (const key of plan.upload) {
    const file = paths.get(key)!;
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: readFileSync(file),
        ContentType: MIME_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
        CacheControl: "no-cache",
      })
    );
  }
  for (const key of plan.remove) {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }
  return plan;
}
