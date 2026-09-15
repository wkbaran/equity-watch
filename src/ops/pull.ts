/**
 * Drains the ops queue: the browser dashboard's queued changes, applied locally.
 *
 * Runs at the start of each scheduled check (scripts/check-and-publish.ps1), so
 * there is no separate watcher. A message is deleted only after its result is
 * logged. A crash in between redelivers it, and the op log turns the repeat
 * into a no-op (see src/ops/apply.ts).
 */

import { DeleteMessageCommand, ReceiveMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { applyOp, parseOp, type ApplyContext } from "./apply.js";

export interface QueueMessage {
  body: string;
  receiptHandle: string;
}

export interface OpsQueue {
  receive(max: number, waitSeconds: number): Promise<QueueMessage[]>;
  remove(receiptHandle: string): Promise<void>;
}

export function sqsOpsQueue(queueUrl: string, region: string): OpsQueue {
  const client = new SQSClient({ region });
  return {
    async receive(max, waitSeconds) {
      const resp = await client.send(
        new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: Math.min(10, max), WaitTimeSeconds: waitSeconds })
      );
      return (resp.Messages ?? []).flatMap((m) => (m.Body !== undefined && m.ReceiptHandle !== undefined ? [{ body: m.Body, receiptHandle: m.ReceiptHandle }] : []));
    },
    async remove(receiptHandle) {
      await client.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle }));
    },
  };
}

export interface PullSummary {
  applied: number;
  rejected: number;
  duplicates: number;
  malformed: number;
  /** Set when an op threw; it and everything after it stay queued. */
  error: string | null;
}

export async function pullOps(
  queue: OpsQueue,
  ctx: ApplyContext,
  opts: { max: number; waitSeconds: number; log: (line: string) => void }
): Promise<PullSummary> {
  const summary: PullSummary = { applied: 0, rejected: 0, duplicates: 0, malformed: 0, error: null };
  let seen = 0;
  let wait = opts.waitSeconds;
  while (seen < opts.max) {
    const batch = await queue.receive(opts.max - seen, wait);
    // Only the first receive waits: after that an empty queue means done.
    wait = 0;
    if (batch.length === 0) {
      break;
    }
    for (const message of batch) {
      seen++;
      let body: unknown;
      try {
        body = JSON.parse(message.body);
      } catch {
        body = undefined;
      }
      const parsed = parseOp(body);
      if (!parsed.ok) {
        // The Lambda checks shape before queueing, so this is rare. Retrying
        // can't fix it, and leaving it would park it at the head of the queue.
        opts.log(`  ! dropped a malformed op: ${parsed.error}`);
        summary.malformed++;
        await queue.remove(message.receiptHandle);
        continue;
      }
      try {
        const { result, duplicate } = await applyOp(parsed.op, ctx);
        if (duplicate) {
          summary.duplicates++;
          opts.log(`  = ${result.id} already applied: ${result.message}`);
        } else if (result.ok) {
          summary.applied++;
          opts.log(`  + ${result.id} ${result.message}`);
        } else {
          summary.rejected++;
          opts.log(`  - ${result.id} ${result.message}`);
        }
      } catch (err) {
        // Stop here. Later ops in a FIFO group may depend on this one (an edit
        // of an alert this add creates), so they must not jump ahead of it.
        summary.error = `${parsed.op.id}: ${(err as Error).message}`;
        return summary;
      }
      await queue.remove(message.receiptHandle);
    }
  }
  return summary;
}
