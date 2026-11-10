/**
 * What the store-wide rules read: a summary of every order and name, and
 * the store's refunded total.
 *
 * Where it comes from, and when. The store acts on one command at a time,
 * through a serialized queue, as the Python service does with its lock.
 * For a command it reads the chain and asks the wallet first, outside any
 * SQLite write transaction, so no RPC holds the write lock; nothing else
 * writes in between, because the queue lets nothing else run. It then
 * builds this view from its database and those readings, runs the rules,
 * and writes their result in one transaction. The rules only read the
 * view, and never wait on the chain or the wallet.
 */

import type { OrderStatus } from "./order.ts";

export interface OrderSummary {
  readonly oid: string;
  /** Creation order, which conflict lists follow. */
  readonly seq: number;
  readonly name: string;
  readonly status: OrderStatus;
  readonly price: number | null;
  /** The buyer's `script_pubkey`, locked to the order at its request. */
  readonly recipientScript: string;
  /** The order's payment script, once quoted. */
  readonly destinationScript: string | null;
  readonly refundScript: string | null;
  /** Why the recipient may not be issued to, as the start-up audit found. */
  readonly recipientProblem: string | null;
  /** Sats the node sees paying the order now, mempool included. */
  readonly seen: number;
}

export interface NameSummary {
  readonly name: string;
  readonly price: number;
  readonly holdOrder: string | null;
  readonly fulfillmentOrder: string | null;
}

export interface StoreView {
  /** In creation order. */
  readonly orders: readonly OrderSummary[];
  readonly names: Readonly<Record<string, NameSummary>>;
  /** What closed refund groups have charged, store-wide. */
  readonly refundedTotal: number;
}

export function orderIn(view: StoreView, oid: string): OrderSummary | undefined {
  return view.orders.find((o) => o.oid === oid);
}
