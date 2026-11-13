import { createHash } from "node:crypto";
import { canonicalHandle } from "../recipient.ts";
import { claims, fail, request, sats, whole, type Order, type State } from "./records.ts";

export interface AdmissionLimits { windowSeconds: number; maximumRequests: number; maximumOrders: number }
export interface SellerSettings { version: 1; revision: number; configured: boolean; limits: AdmissionLimits;
  requestWindow: { startedAt: number; created: number } }
export interface SpacePolicy { version: 1; space: string; paused: boolean; catalog: "listed" }
export interface NamePolicy { version: 1; handle: string; reserved: boolean; withdrawn: boolean }
export interface InvoiceWithdrawal { version: 1; order: string; at: number }
export interface OwnerAuthorization { version: 1; operation: string; order: string; handle: string; recipient: string;
  price: number; review: string; authorizedAt: number }
export const defaultSeller = (): SellerSettings => ({ version: 1, revision: 0, configured: false,
  limits: { windowSeconds: 3600, maximumRequests: 120, maximumOrders: 10000 }, requestWindow: { startedAt: 0, created: 0 } });
export function fields(value: unknown, keys: string): asserts value is { [key: string]: unknown } {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== keys.split(",").sort().join()) fail("invalid seller fields", "invalid");
}
export function spaceLabel(value: unknown): asserts value is string {
  if (typeof value !== "string" || !canonicalHandle("name@" + value)) fail("invalid space", "invalid");
}
export function limits(value: unknown): asserts value is AdmissionLimits {
  fields(value, "windowSeconds,maximumRequests,maximumOrders");
  whole(value.windowSeconds, 1); whole(value.maximumRequests, 1); whole(value.maximumOrders, 1);
}
export function sellerRecord(kind: string, value: unknown) {
  switch (kind) {
    case "seller_settings": {
      fields(value, "version,revision,configured,limits,requestWindow"); whole(value.revision); limits(value.limits);
      fields(value.requestWindow, "startedAt,created"); whole(value.requestWindow.startedAt); whole(value.requestWindow.created);
      if (value.version !== 1 || typeof value.configured !== "boolean") fail("invalid seller settings"); break;
    }
    case "space_policy": {
      fields(value, "version,space,paused,catalog"); spaceLabel(value.space);
      if (value.version !== 1 || typeof value.paused !== "boolean" || value.catalog !== "listed") fail("invalid space policy"); break;
    }
    case "name_policy": {
      fields(value, "version,handle,reserved,withdrawn");
      if (value.version !== 1 || !canonicalHandle(value.handle) || typeof value.reserved !== "boolean" || typeof value.withdrawn !== "boolean") fail("invalid name policy"); break;
    }
    case "invoice_withdrawal": {
      fields(value, "version,order,at"); whole(value.at);
      if (value.version !== 1 || typeof value.order !== "string") fail("invalid invoice restriction"); break;
    }
    case "owner_authorization": {
      fields(value, "version,operation,order,handle,recipient,price,review,authorizedAt");
      request({ handle: value.handle, script_pubkey: value.recipient }); sats(value.price); whole(value.authorizedAt);
      if (value.version !== 1 || typeof value.order !== "string" || typeof value.operation !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(value.operation) ||
          typeof value.review !== "string" || !/^[0-9a-f]{64}$/.test(value.review)) fail("invalid owner authorization"); break;
    }
    default: fail("unknown seller record");
  }
}
export function validateSeller(state: State): void {
  for(const [rows,key] of [[state.spaces,"space"],[state.namePolicies,"handle"],[state.withdrawals,"order"],[state.ownerAuthorizations,"order"]] as const){
    const ids=rows.map(row=>(row as unknown as {[key:string]:unknown})[key]);if(new Set(ids).size!==ids.length)fail("duplicate seller identity");
  }
  for (const n of state.listings) if (!state.spaces.some(s => s.space === n.space))
    state.spaces.push({ version: 1, space: n.space, paused: false, catalog: "listed" });
  for (const n of state.namePolicies) if (!state.listings.some(l => l.handle === n.handle)) fail("name policy without listing");
  for (const w of state.withdrawals) if (!state.orders.some(o => o.id === w.order && o.destination !== null) || w.at > state.settings.lastTime) fail("invalid withdrawal binding");
  const operations = new Set<string>();
  for (const a of state.ownerAuthorizations) {
    const o = state.orders.find(o => o.id === a.order);
    if (!o || o.handle !== a.handle || o.recipient !== a.recipient || (o.quotedPrice !== null && o.quotedPrice !== a.price) ||
        a.authorizedAt > state.settings.lastTime || operations.has(a.operation)) fail("invalid owner authorization binding");
    operations.add(a.operation);
  }
}
export const namePolicy = (state: State, handle: string) => state.namePolicies.find(n => n.handle === handle);
export function ownerAuthorized(state: State, order: Order): boolean {
  return state.ownerAuthorizations.some(a => a.order === order.id && a.handle === order.handle && a.recipient === order.recipient &&
    a.price === (order.quotedPrice ?? state.listings.find(n => n.handle === order.handle)?.price));
}
export function invoiceRestricted(state: State, order: Order, held: boolean): boolean {
  return !claims(order) && !held && state.withdrawals.some(w => w.order === order.id) &&
    (!order.payFirst || state.settings.lastTime >= order.quotedAt! + 900);
}
export function unavailable(state: State, order: Order, initialWindow = false): boolean {
  const n = namePolicy(state, order.handle);
  const grace = initialWindow && order.payFirst && state.withdrawals.some(w => w.order === order.id) && state.settings.lastTime < order.quotedAt! + 900;
  return !!((n?.reserved && !ownerAuthorized(state, order)) || (n?.withdrawn && !grace));
}
export function createRequested(state: State, input: { handle: string; script: string }, tokenHash: string, now: number): Order {
  whole(now); if (now < state.settings.lastTime) fail("clock moved backwards", "unavailable");
  if (!state.listings.some(n => n.handle === input.handle)) fail("not for sale");
  if (state.orders.some(o => o.destination?.script === input.script || (o.handle !== input.handle && claims(o) && o.recipient === input.script))) fail("script already used");
  const window = state.seller.requestWindow, limit = state.seller.limits;
  if (state.orders.length >= limit.maximumOrders) fail("request capacity reached; operator review required", "throttled");
  const expired = now - window.startedAt >= limit.windowSeconds;
  if (!expired && window.created >= limit.maximumRequests) fail("request rate exceeded; retry after the admission window", "throttled");
  if (expired) { window.startedAt = now; window.created = 0; } window.created++;
  const sequence = state.settings.nextOrder++;
  const o: Order = { id: `o${sequence}`, sequence, handle: input.handle, space: input.handle.split("@")[1]!, recipient: input.script,
    tokenHash, status: "requested", quotedAt: null, quotedPrice: null, price: null, destination: null, payFirst: false,
    grants: [], everConverted: false, paymentHistory: "none", lateEvaluated: false };
  state.orders.push(o); state.accounts.push({ order: o.id, destination: null, ceiling: null }); return o;
}
export function digest(value: unknown): string {
  const canonical=(v:unknown):unknown=>Array.isArray(v)?v.map(canonical):v&&typeof v==="object"?
    Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,value])=>[k,canonical(value)])):v;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
