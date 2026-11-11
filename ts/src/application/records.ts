import { Data, Effect } from "effect";
import { canonicalHandle, validP2tr } from "../recipient.ts";
import type { Json } from "../storage/codec.ts";
import { policy, type RefundPolicy } from "../refunds/policy.ts";
import { account, group } from "../refunds/records.ts";
import type { RefundAccount, RefundAttempt, RefundGroup, RefundObservation, RefundPause, RefundSend } from "../refunds/types.ts";
import { observation, sendRecord } from "../refunds/observations.ts";
import { allMembers, attempt, evidenceKey, members } from "../refunds/families.ts";

export class ApplicationError extends Data.TaggedError("ApplicationError")<{
  readonly code: "invalid" | "refused" | "unavailable" | "not_found";
  readonly message: string;
}> {}
export function fail(message: string, code: ApplicationError["code"] = "refused"): never {
  throw new ApplicationError({ code, message });
}
export function checked<A>(work: () => A): Effect.Effect<A, ApplicationError> {
  return Effect.try({ try: work, catch: error => error instanceof ApplicationError ? error :
    new ApplicationError({ code: "unavailable", message: "application state validation failed" }) });
}
export function verified<A>(work: () => A): Effect.Effect<A, ApplicationError> {
  return checked(work).pipe(Effect.mapError(error => new ApplicationError({ code: "unavailable", message: error.message })));
}
export function whole(value: unknown, minimum = 0): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) fail("invalid integer", "invalid");
}
export const MAX_MONEY = 2_100_000_000_000_000;
export function sats(value: unknown): asserts value is number {
  whole(value, 1); if (value > MAX_MONEY) fail("invalid amount", "invalid");
}
export interface Destination { address: string; script: string }
export type Status = "requested" | "quoted" | "unpaid" | "converted" | "issuing" | "cancelled" | "refund_due";
export interface Grant { at: number; until: number; seenHeight: number | null;
  acquiredHeight: number | null; released: boolean; converted: boolean }
export interface Order {
  id: string; sequence: number; handle: string; space: string; recipient: string; tokenHash: string;
  status: Status; quotedAt: number | null; quotedPrice: number | null; price: number | null;
  destination: Destination | null; payFirst: boolean; grants: Grant[]; everConverted: boolean;
  paymentHistory: "none" | "detected"; lateEvaluated: boolean;
}
export interface Listing { handle: string; space: string; price: number }
export interface Output { outpoint: string; script: string; sats: number; confirmations: number }
export interface Snapshot { tip: number; tipHash?: string; outputs: readonly Output[] }
export interface Payment extends Output { active: boolean }
export interface Settings { version: 1; riskBudget: number; paused: boolean; conversions: string[];
  lastTime: number; tip: number; nextOrder: number }
export interface RefundSettings { version: 1; policy: RefundPolicy; merchantDestinations: Destination[] }
export interface State { settings: Settings; listings: Listing[]; orders: Order[]; payments: Payment[];
  refunds: RefundSettings; accounts: RefundAccount[]; groups: RefundGroup[];
  refundObservations: RefundObservation[]; refundSends: RefundSend[]; refundAttempts: RefundAttempt[]; refundPauses: RefundPause[] }
export interface Record { kind: string; key: string; value: Json }
export const claims = (order: Order): boolean => order.status === "converted" || order.status === "issuing";
export function request(body: unknown): { handle: string; script: string } {
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).sort().join() !== "handle,script_pubkey") fail("invalid recipient request", "invalid");
  const value = body as { handle: unknown; script_pubkey: unknown };
  if (!canonicalHandle(value.handle) || !validP2tr(value.script_pubkey))
    fail("invalid recipient request", "invalid");
  return { handle: value.handle, script: value.script_pubkey };
}
function object(value: unknown, fields: string): asserts value is { [key: string]: unknown } {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join() !== fields.split(",").sort().join()) fail("invalid stored fields");
}
function bool(value: unknown): void { if (typeof value !== "boolean") fail("invalid boolean"); }
function text(value: unknown): asserts value is string { if (typeof value !== "string") fail("invalid text"); }
function nullableWhole(value: unknown): void { if (value !== null) whole(value); }
export function destination(value: unknown): asserts value is Destination {
  object(value, "address,script"); text(value.address);
  if (!value.address || value.address.length > 256 || typeof value.script !== "string" ||
      !/^(?:[0-9a-f]{2}){1,10000}$/.test(value.script)) fail("invalid wallet destination");
}
function listing(value: unknown): asserts value is Listing {
  object(value, "handle,space,price");
  if (!canonicalHandle(value.handle) || value.handle.split("@")[1] !== value.space) fail("invalid listing");
  sats(value.price);
}
function order(value: unknown): asserts value is Order {
  object(value, "id,sequence,handle,space,recipient,tokenHash,status,quotedAt,quotedPrice,price,destination,payFirst,grants,everConverted,paymentHistory,lateEvaluated");
  whole(value.sequence, 1);
  if (value.id !== `o${value.sequence}` || !canonicalHandle(value.handle) ||
      value.handle.split("@")[1] !== value.space || !validP2tr(value.recipient) ||
      typeof value.tokenHash !== "string" || !/^[0-9a-f]{64}$/.test(value.tokenHash) ||
      !["requested", "quoted", "unpaid", "converted", "issuing", "cancelled", "refund_due"].includes(String(value.status)) ||
      !["none", "detected"].includes(String(value.paymentHistory))) fail("invalid stored order");
  nullableWhole(value.quotedAt);
  for (const amount of [value.quotedPrice, value.price]) if (amount !== null) sats(amount);
  if (value.destination !== null) destination(value.destination);
  for (const v of [value.payFirst, value.everConverted, value.lateEvaluated]) bool(v);
  if (!Array.isArray(value.grants)) fail("invalid hold history");
  for (const grant of value.grants) {
    object(grant, "at,until,seenHeight,acquiredHeight,released,converted");
    whole(grant.at); whole(grant.until); nullableWhole(grant.seenHeight); nullableWhole(grant.acquiredHeight);
    bool(grant.released); bool(grant.converted);
    if ((grant.until as number) !== (grant.at as number) + 900) fail("invalid hold duration");
  }
  if ((value.destination === null) !== (value.quotedAt === null) ||
      (value.destination === null) !== (value.quotedPrice === null) ||
      (value.destination === null) !== (value.price === null)) fail("incomplete invoice");
}
function payment(value: unknown): asserts value is Payment {
  object(value, "outpoint,script,sats,confirmations,active");
  text(value.outpoint); text(value.script); sats(value.sats); whole(value.confirmations); bool(value.active);
  if (!value.outpoint || value.outpoint.length > 256) fail("invalid outpoint");
}
export function encode(state: State): Record[] {
  return [ { kind: "sales_settings", key: "global", value: state.settings as unknown as Json },
    { kind: "refund_settings", key: "global", value: state.refunds as unknown as Json },
    ...state.accounts.map(value => ({ kind: "refund_account", key: value.order, value: value as unknown as Json })),
    ...state.groups.map(value => ({ kind: "refund_group", key: value.id, value: value as unknown as Json })),
    ...state.refundAttempts.map(value => ({ kind: "refund_attempt", key: value.id, value: value as unknown as Json })),
    ...state.refundPauses.map(value => ({ kind: "refund_pause", key: value.group, value: value as unknown as Json })),
    ...state.refundObservations.map(value => ({ kind: "refund_observation", key: evidenceKey(state, value), value: value as unknown as Json })),
    ...state.refundSends.map(value => ({ kind: "refund_send", key: evidenceKey(state, value), value: value as unknown as Json })),
    ...state.listings.map(value => ({ kind: "listing", key: value.handle, value: value as unknown as Json })),
    ...state.orders.map(value => ({ kind: "sales_order", key: value.id, value: value as unknown as Json })),
    ...state.payments.map(value => ({ kind: "payment", key: value.outpoint, value: value as unknown as Json })) ];
}
export function decode(records: readonly Record[], riskBudget: number, refunds: RefundSettings): State {
  policy(refunds.policy);
  for (const d of refunds.merchantDestinations) destination(d);
  const state: State = { settings: { version: 1, riskBudget, paused: true, conversions: [],
    lastTime: 0, tip: 0, nextOrder: 1 }, listings: [], orders: [], payments: [],
    refunds: structuredClone(refunds), accounts: [], groups: [], refundObservations: [], refundSends: [], refundAttempts: [], refundPauses: [] };
  for (const record of records) {
    // Commands mutate a working copy. The original records remain the
    // immutable comparison point for the atomic changed-record commit.
    const v: unknown = structuredClone(record.value);
    switch (record.kind) {
      case "refund_settings":
        object(v, "version,policy,merchantDestinations");
        if (record.key !== "global" || JSON.stringify(v) !== JSON.stringify(refunds)) fail("refund configuration differs from the journal");
        break;
      case "refund_account": account(v); if (v.order !== record.key) fail("refund account differs"); state.accounts.push(v); break;
      case "refund_group": group(v); if (v.id !== record.key) fail("refund group differs"); state.groups.push(v); break;
      case "refund_attempt": attempt(v); if (v.id !== record.key) fail("refund attempt differs"); state.refundAttempts.push(v); break;
      case "refund_pause":
        object(v, "group,firstAt,lastAt,active"); whole(v.firstAt); whole(v.lastAt); bool(v.active);
        if (v.group !== record.key || v.lastAt < v.firstAt) fail("invalid rebuild pause");
        state.refundPauses.push(v as unknown as RefundPause); break;
      case "refund_observation": observation(v); state.refundObservations.push(v); break;
      case "refund_send": sendRecord(v); state.refundSends.push(v); break;
      case "sales_settings":
        object(v, "version,riskBudget,paused,conversions,lastTime,tip,nextOrder");
        if (record.key !== "global" || v.version !== 1 || v.riskBudget !== riskBudget) fail("unsupported application settings");
        sats(v.riskBudget); bool(v.paused); whole(v.lastTime); whole(v.tip); whole(v.nextOrder, 1);
        if (!Array.isArray(v.conversions) || new Set(v.conversions).size !== v.conversions.length ||
            v.conversions.some(id => typeof id !== "string")) fail("invalid conversion history");
        state.settings = v as unknown as Settings; break;
      case "listing": listing(v); if (v.handle !== record.key) fail("listing identity differs"); state.listings.push(v); break;
      case "sales_order": order(v); if (v.id !== record.key) fail("order identity differs"); state.orders.push(v); break;
      case "payment": payment(v); if (v.outpoint !== record.key) fail("payment identity differs"); state.payments.push(v); break;
      default: fail("unknown application record");
    }
  }
  if (records.length && !records.some(r => r.kind === "sales_settings")) fail("missing application settings");
  if (records.length && !records.some(r => r.kind === "refund_settings")) fail("missing refund settings; explicit import required");
  const tokens = new Set<string>(), destinations = new Set<string>();
  for (const o of state.orders) {
    if (!state.listings.some(n => n.handle === o.handle) || o.sequence >= state.settings.nextOrder ||
        tokens.has(o.tokenHash)) fail("invalid order relationship");
    tokens.add(o.tokenHash);
    if (o.destination) {
      if (destinations.has(o.destination.script)) fail("duplicate payment destination");
      destinations.add(o.destination.script);
    }
    if (o.everConverted !== state.settings.conversions.includes(o.id) || (claims(o) && !o.everConverted))
      fail("invalid conversion relationship");
    if ((o.status === "requested" && o.destination !== null) ||
        (!["requested", "cancelled"].includes(o.status) && o.destination === null) ||
        (claims(o) && (!o.grants.at(-1)?.converted || o.grants.at(-1)!.released))) fail("invalid invoice state");
    let previous = -1;
    for (const hold of o.grants) {
      if (hold.at < previous || hold.at > state.settings.lastTime || (hold.converted && !o.everConverted))
        fail("invalid grant history");
      previous = hold.at;
    }
  }
  if (state.settings.conversions.some(id => !state.orders.some(o => o.id === id))) fail("missing converted order");
  if (state.payments.some(p => !destinations.has(p.script))) fail("payment has no invoice");
  if (state.payments.filter(p => p.active).reduce((sum, p) => sum + p.sats, 0) > MAX_MONEY)
    fail("stored payments exceed money supply");
  const accountIds = new Set<string>(), groupIds = new Set<string>();
  const inputs = new Map<string, { group: string; script: string; sats: number; owner: string }>(), txids = new Set<string>();
  const merchant = new Set<string>();
  for (const d of state.refunds.merchantDestinations) {
    if (merchant.has(d.script) || destinations.has(d.script)) fail("ambiguous merchant funding destination");
    merchant.add(d.script);
  }
  for (const a of state.accounts) {
    const o = state.orders.find(o => o.id === a.order);
    if (!o || accountIds.has(a.order) || (o.destination !== null) !== (a.ceiling !== null) ||
        (a.destination && (destinations.has(a.destination.script) || merchant.has(a.destination.script)))) fail("invalid refund account relationship");
    accountIds.add(a.order);
  }
  if (state.orders.some(o => !accountIds.has(o.id))) fail("order has no refund account");
  for (const g of state.groups) {
    const a = state.accounts.find(a => a.order === g.order);
    if (!a?.destination || a.ceiling !== g.policy.buyerFeeCeiling || groupIds.has(g.id)) fail("invalid refund group relationship");
    groupIds.add(g.id);
    for (const m of members(state, g)) {
      if (!m.transaction) continue;
      if (txids.has(m.transaction.txid)) fail("duplicate refund transaction"); txids.add(m.transaction.txid);
      if (m.transaction.outputs.find(o => o.role === "buyer")?.script !== a.destination.script) fail("refund destination differs");
      for (const c of m.transaction.inputs) {
        const previous = inputs.get(c.outpoint);
        if (previous && (previous.group !== g.id || previous.script !== c.script || previous.sats !== c.sats || previous.owner !== c.owner)) fail("refund input used by another obligation");
        inputs.set(c.outpoint, { group: g.id, ...c });
      }
      for (const o of m.transaction.outputs.filter(o => o.role !== "buyer")) {
      if (destinations.has(o.script) || merchant.has(o.script) || state.accounts.some(a => a.destination?.script === o.script))
        fail("refund change destination reused");
      }
    }
  }
  const attemptIds = new Set<string>();
  for (const a of state.refundAttempts) {
    const g = state.groups.find(g => g.id === a.group);
    if (!g?.transaction || attemptIds.has(a.id) || a.createdAt > state.settings.lastTime) fail("invalid attempt relationship"); attemptIds.add(a.id);
    group({ ...g, charged: a.charged, rate: a.rate, policy: a.policy, phase: a.phase, transaction: a.transaction });
    const earlier = members(state, g).filter(m => m.ordinal < a.ordinal && m.transaction).map(m => m.transaction!);
    if (a.replacement.members.length !== earlier.length || earlier.some(t => !a.replacement.members.some(v => JSON.stringify(v) === JSON.stringify(t)))) fail("attempt omits earlier family history");
    for (const key of Object.keys(g.policy) as (keyof RefundPolicy)[]) {
      if (key === "buyerFeeCeiling" ? a.policy[key] > g.policy[key] : a.policy[key] !== g.policy[key]) fail("attempt changed operator limits");
    }
  }
  const known = allMembers(state);
  for (const collection of [state.refundObservations, state.refundSends]) {
    const ids = new Set<string>();
    for (const value of collection) {
      if (ids.has(value.txid) || !known.some(m => m.group === value.group && m.transaction?.txid === value.txid)) fail("invalid refund evidence relationship");
      ids.add(value.txid);
    }
  }
  for (const r of records.filter(r => r.kind === "refund_observation" || r.kind === "refund_send")) {
    if (evidenceKey(state, r.value as unknown as { group: string; txid: string }) !== r.key) fail("refund evidence key differs");
  }
  for (const s of state.refundSends) if (s.lastIntentAt > state.settings.lastTime) fail("refund intent is in the future");
  for (const p of state.refundPauses) if (!state.groups.some(g => g.id === p.group && g.transaction) || p.lastAt > state.settings.lastTime) fail("invalid rebuild pause relationship");
  return state;
}
