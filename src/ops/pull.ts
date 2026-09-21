/**
 * Drains the ops queue: the browser dashboard's queued changes, applied locally.
 *
 * Runs at the start of each scheduled check (scripts/check-and-publish.ps1), so
 * there is no separate watcher. A message is deleted only after its result is
 * logged. A crash in between redelivers it, and the op log turns the repeat
 * into a no-op (see src/ops/apply.ts).
 *
 * It drains until the queue is empty; `max` is an opt-in valve, not a default.
 * The work is local and cheap, and the publish that follows is one document
 * however many ops were applied. The scheduled task is killed at ten minutes,
 * but that is safe for the same reason a crash is: whatever was applied is
 * logged and deleted, and the next run finishes the rest.
 */

import { ChangeMessageVisibilityCommand, DeleteMessageCommand, ReceiveMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { applyOp, parseOp, type ApplyContext } from "./apply.js";

export interface QueueMessage {
  body: string;
  receiptHandle: string;
}

export interface OpsQueue {
  receive(max: number, waitSeconds: number): Promise<QueueMessage[]>;
  remove(receiptHandle: string): Promise<void>;
  /**
   * Hand a received message straight back, instead of letting it serve out the
   * queue's visibility timeout invisible.
   *
   * Without this, a drain that stops partway leaves everything it had already
   * received hidden for the timeout (120s on this queue). The scheduled task
   * never notices - it runs every 15 minutes - but a person retrying by hand
   * right after fixing the cause gets "No queued ops", which is
   * indistinguishable from a successful drain. That happened on 2026-09-19.
   */
  release(receiptHandle: string): Promise<void>;
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
    async release(receiptHandle) {
      await client.send(new ChangeMessageVisibilityCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle, VisibilityTimeout: 0 }));
    },
  };
}

export interface PullSummary {
  applied: number;
  rejected: number;
  duplicates: number;
  malformed: number;
  /**
   * When the drain began. With no error, every op queued before this was
   * received and applied, which is what lets the page stop waiting on one
   * whose result is no longer published.
   */
  startedAt: string;
  /** Set when an op threw; it and everything after it stay queued. */
  error: string | null;
  /**
   * Set when the drain never started, because a precondition failed. The queue
   * is untouched - not one message was received - so nothing is invisible and
   * nothing is half-applied.
   */
  blocked: string | null;
}

/**
 * Best-effort: a release that fails changes nothing that matters, since the
 * message reappears on its own when the visibility timeout runs out. Never let
 * it mask the error that stopped the drain.
 */
async function releaseAll(queue: OpsQueue, messages: QueueMessage[], log: (line: string) => void): Promise<void> {
  for (const message of messages) {
    try {
      await queue.release(message.receiptHandle);
    } catch (err) {
      log(`  ! couldn't return a message to the queue (${(err as Error).message}); it reappears when its visibility timeout ends.`);
    }
  }
}

export async function pullOps(
  queue: OpsQueue,
  ctx: ApplyContext,
  opts: {
    max: number;
    waitSeconds: number;
    log: (line: string) => void;
    /**
     * Checked BEFORE the first receive, and the reason it exists: the Schwab
     * login expires weekly, and an add or a level edit cannot be applied
     * without a live quote. Discovering that mid-drain means messages already
     * received go invisible for the visibility timeout while nothing has been
     * accomplished. Returns null when the drain may proceed, or a sentence
     * saying why it may not.
     */
    preflight?: () => Promise<string | null>;
  }
): Promise<PullSummary> {
  const summary: PullSummary = { applied: 0, rejected: 0, duplicates: 0, malformed: 0, startedAt: new Date().toISOString(), error: null, blocked: null };

  // Nothing above this line touches the queue, and nothing below it runs if
  // the check fails. Receiving is not free to undo: a message handed out is
  // invisible until it is deleted or released.
  const blocked = opts.preflight === undefined ? null : await opts.preflight();
  if (blocked !== null) {
    summary.blocked = blocked;
    return summary;
  }

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
        // Put back what this run received but never applied - this message and
        // the rest of its batch - so a retry sees them immediately instead of
        // an empty queue for the length of the visibility timeout.
        await releaseAll(queue, [message, ...batch.slice(batch.indexOf(message) + 1)], opts.log);
        return summary;
      }
      await queue.remove(message.receiptHandle);
    }
  }
  return summary;
}
