/**
 * The op types that send orders to Webull. They travel on their own queue to
 * `orders watch` (src/orders/), never through `ops pull`, which refuses them.
 * Kept apart from src/orders/ so apply.ts can list them without importing the
 * order code.
 */
export const ORDER_OP_TYPES = [
  "stop.place",
  "stop.replace",
  "stop.cancel",
  "cash.cover",
  "cash.park",
  "order.buy",
  "order.sell",
  "order.replace",
  "order.cancel",
  // Not an order: a quote for the ticket, answered by the watcher in seconds
  // (src/orders/watch.ts). It rides this queue because only the watcher is
  // always on. No code, no op log, and nothing is sent to Webull.
  "quote.read",
] as const;
export type OrderOpType = (typeof ORDER_OP_TYPES)[number];

export function isOrderOp(type: string): type is OrderOpType {
  return (ORDER_OP_TYPES as readonly string[]).includes(type);
}
