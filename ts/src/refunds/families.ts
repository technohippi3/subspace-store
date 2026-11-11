import { fail, whole, type State } from "../application/records.ts";
import { group as validateGroup, prepared } from "./records.ts";
import type { Coin, PreparedRefund, RefundAttempt, RefundGroup, Replacement } from "./types.ts";

export interface Member { id: string; group: string; ordinal: number; charged: number; rate: number;
  phase: "reserved" | "built" | "void"; transaction: PreparedRefund | null; replacement?: Replacement }
const sameCoin = (a: Coin, b: Coin) => a.outpoint === b.outpoint && a.script === b.script && a.sats === b.sats && a.owner === b.owner;
export function members(state: State, g: RefundGroup): Member[] {
  return [{ id: g.id, group: g.id, ordinal: 0, charged: g.charged, rate: g.rate, phase: g.phase, transaction: g.transaction },
    ...state.refundAttempts.filter(a => a.group === g.id)].sort((a, b) => a.ordinal - b.ordinal);
}
export function allMembers(state: State): Member[] { return state.groups.flatMap(g => members(state, g)); }
export function evidenceKey(state: State, value: { group: string; txid: string }): string {
  return state.groups.find(g => g.id === value.group)?.transaction?.txid === value.txid ? value.group : value.txid;
}
export function reservation(state: State, g: RefundGroup): number {
  return Math.max(...members(state, g).filter(a => a.phase !== "void").map(a => a.charged), 0);
}
export function preferred(state: State, g: RefundGroup): Member {
  return members(state, g).filter(a => a.transaction).at(-1) ?? members(state, g)[0]!;
}
function coin(value: Coin): void {
  if (!value || Object.keys(value).sort().join() !== "outpoint,owner,sats,script") fail("invalid replacement input");
  const script = value.script;
  if (typeof value.outpoint !== "string" || !/^[0-9a-f]{64}:(0|[1-9][0-9]*)$/.test(value.outpoint) ||
      Number(value.outpoint.split(":")[1]) > 0xffff_ffff || !["order", "merchant"].includes(value.owner) ||
      typeof script !== "string" || !/^(?:[0-9a-f]{2}){1,10000}$/.test(script)) fail("invalid replacement funding");
  whole(value.sats, 1);
}
/** Structural proof. Core independently binds any ancestor's bytes to its txid. */
export function replacement(value: Replacement): void {
  if (!value || Object.keys(value).sort().join() !== "members,minimumFee,proofs,requiredInputs" ||
      !Array.isArray(value.members) || !value.members.length || !Array.isArray(value.proofs) ||
      !Array.isArray(value.requiredInputs) || !value.requiredInputs.length) fail("invalid replacement plan");
  value.members.forEach(prepared); whole(value.minimumFee);
  const ids = new Set(value.members.map(t => t.txid)), inputs = new Set(value.requiredInputs.map(c => c.outpoint));
  if (ids.size !== value.members.length || inputs.size !== value.requiredInputs.length || value.proofs.length !== ids.size) fail("duplicate replacement evidence");
  value.requiredInputs.forEach(coin);
  const proven = new Set<string>();
  for (const p of value.proofs) {
    if (!p || Object.keys(p).sort().join() !== "earlier,input,via" || !ids.has(p.earlier) || proven.has(p.earlier) || !inputs.has(p.input)) fail("incomplete exclusivity proof");
    const earlier = value.members.find(t => t.txid === p.earlier)!;
    if (p.via === null) {
      if (!earlier.inputs.some(c => c.outpoint === p.input)) fail("replacement has no shared input");
    } else {
      if (Object.keys(p.via).sort().join() !== "inputs,raw,txid" || !/^[0-9a-f]{64}$/.test(p.via.txid) || ids.has(p.via.txid) ||
          !p.input.startsWith(p.via.txid + ":") || typeof p.via.raw !== "string" ||
          !/^(?:[0-9a-f]{2})+$/.test(p.via.raw) || p.via.raw.length > 800_000 || !Array.isArray(p.via.inputs) ||
          !p.via.inputs.some(i => earlier.inputs.some(c => c.outpoint === i))) fail("replacement lacks a conflicting ancestor");
      for (const id of p.via.inputs) if (typeof id !== "string" || !/^[0-9a-f]{64}:(0|[1-9][0-9]*)$/.test(id)) fail("invalid ancestor input");
      if (new Set(p.via.inputs).size !== p.via.inputs.length) fail("duplicate ancestor input");
    }
    proven.add(p.earlier);
  }
}
export function attempt(value: unknown): asserts value is RefundAttempt {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid refund attempt");
  const a = value as RefundAttempt;
  if (Object.keys(a).sort().join() !== "charged,createdAt,group,id,mode,ordinal,parent,phase,policy,rate,replacement,transaction" ||
      !["bump", "rebuild"].includes(a.mode) || !/^[0-9a-f]{64}$/.test(a.parent)) fail("invalid attempt fields");
  whole(a.ordinal, 1); if (a.id !== `${a.group}.a${a.ordinal}`) fail("invalid attempt identity");
  validateGroup({ id: a.group, order: "attempt", charged: a.charged, createdAt: a.createdAt, kind: "cancellation", cause: "buyer",
    rate: a.rate, policy: a.policy, phase: a.phase, transaction: a.transaction });
  replacement(a.replacement);
  if (!a.replacement.members.some(t => t.txid === a.parent)) fail("missing attempt parent");
  if (a.transaction) {
    if (a.replacement.members.some(t => t.txid === a.transaction!.txid) || a.transaction.fee <= a.replacement.minimumFee) fail("invalid replacement fee or identity");
    for (const c of a.replacement.requiredInputs) if (!a.transaction.inputs.some(i => sameCoin(i, c))) fail("replacement dropped a required input");
  }
  if (a.mode === "bump") {
    const parent = a.replacement.members.find(t => t.txid === a.parent)!;
    for (const c of parent.inputs) if (!a.replacement.requiredInputs.some(i => sameCoin(i, c))) fail("fee bump dropped a family input");
  }
}
