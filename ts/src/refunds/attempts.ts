import { fail, whole, type State } from "../application/records.ts";
import { fundingClaims, heldScripts, recordBuilt } from "./book.ts";
import { allMembers, attempt, members, preferred, reservation } from "./families.ts";
import { balance, settled } from "./observations.ts";
import { rate } from "./policy.ts";
import type { BuildRequest, PreparedRefund, RebuildFunding, RebuildRequest, RefundAttempt } from "./types.ts";

function group(state: State, id: string) {
  const g = state.groups.find(g => g.id === id) ?? fail("no such refund", "not_found");
  if (!g.transaction || settled(state, g)) fail("refund is not open for a further attempt");
  if (state.refundAttempts.some(a => a.group === id && a.phase === "reserved")) fail("an unbuilt refund attempt already reserves this group");
  if (members(state, g).some(m => state.refundObservations.some(o => o.txid === m.transaction?.txid && o.confirmations > 0))) fail("a refund member is already mined");
  return g;
}
export function rebuildRequest(state: State, id: string): RebuildRequest {
  const g = group(state, id), prior = members(state, g).filter(m => m.transaction).map(m => m.transaction!);
  const peerIds = new Set(prior.map(t => t.txid));
  const facts = state.refundObservations.filter(o => o.group === id), conflicts = [...new Set(facts.flatMap(o => o.conflicts.filter(c => c.confirmations >= 6 && !peerIds.has(c.txid)).map(c => c.txid)))];
  if (!conflicts.length) fail("no currently settled input conflict permits a rebuild");
  const first = facts[0]!;
  return { members: structuredClone(prior), ...{ orderCoins: fundingClaims(state, g.order).orderCoins },
    forbiddenInputs: allMembers(state).filter(m => m.group !== id).flatMap(m => m.transaction?.inputs.map(c => c.outpoint) ?? []),
    conflicts, tip: first.tip, tipHash: first.tipHash };
}
export function reserveAttempt(state: State, id: string, feeRate: number, charged?: number, absorb = false, funding?: RebuildFunding): RefundAttempt {
  const g = group(state, id), prior = members(state, g).filter(m => m.transaction), source = preferred(state, g), parent = source.transaction!;
  const amount = charged ?? source.charged; whole(amount, 1);
  const available = balance(state, state.orders.find(o => o.id === g.order)!).available;
  if (Math.max(0, amount - reservation(state, g)) > available) fail("additional refund charge exceeds available credit");
  const policy = { ...g.policy, buyerFeeCeiling: g.cause === "merchant" ? 0 : absorb ? parent.buyerFee : g.policy.buyerFeeCeiling };
  const selectedRate = rate(feeRate, policy);
  if (funding) rebuildRequest(state, id);
  else if (state.refundObservations.some(o => o.txid === parent.txid && o.needsRebuild)) fail("refund needs a conflict rebuild");
  const requiredInputs = structuredClone(funding?.requiredInputs ?? parent.inputs);
  const proofs = funding?.proofs ?? prior.map(m => {
    const shared = requiredInputs.find(c => m.transaction!.inputs.some(i => i.outpoint === c.outpoint));
    if (shared) return { earlier: m.transaction!.txid, input: shared.outpoint, via: null };
    const inherited = source.replacement?.proofs.find(p => p.earlier === m.transaction!.txid && requiredInputs.some(c => c.outpoint === p.input));
    return inherited ? structuredClone(inherited) : fail("fee bump cannot prove exclusivity with every earlier member");
  });
  const ordinal = Math.max(0, ...members(state, g).map(m => m.ordinal)) + 1;
  const result: RefundAttempt = { id: `${id}.a${ordinal}`, group: id, ordinal, parent: parent.txid, mode: funding ? "rebuild" : "bump",
    charged: amount, createdAt: state.settings.lastTime, rate: selectedRate, policy, phase: "reserved", transaction: null,
    replacement: { requiredInputs, members: prior.map(m => structuredClone(m.transaction!)), proofs,
      minimumFee: funding ? 0 : Math.max(...prior.map(m => m.transaction!.fee)) } };
  attempt(result); state.refundAttempts.push(result); return result;
}
export function attemptRequest(state: State, a: RefundAttempt): BuildRequest {
  const g = state.groups.find(g => g.id === a.group)!;
  if (a.phase !== "reserved" || settled(state, g) || balance(state, state.orders.find(o => o.id === g.order)!, g.id).available < reservation(state, g)) fail("refund attempt credit is unavailable");
  if (a.mode === "rebuild") rebuildRequestForRetry(state, a);
  const claims = fundingClaims(state, g.order), required = new Set(a.replacement.requiredInputs.map(c => c.outpoint));
  const observation = state.refundObservations.find(o => o.group === g.id) ?? fail("refund observations are required");
  for (const c of a.replacement.requiredInputs) {
    if (c.owner === "order" && !claims.orderCoins.some(i => i.outpoint === c.outpoint)) claims.orderCoins.push({ outpoint: c.outpoint, script: c.script, sats: c.sats });
    if (c.owner === "merchant" && !claims.merchantScripts.includes(c.script)) claims.merchantScripts.push(c.script);
  }
  return { group: { ...g, phase: "reserved", transaction: null, charged: a.charged, rate: a.rate, policy: { ...a.policy } },
    destination: { ...state.accounts.find(v => v.order === g.order)!.destination! }, ...claims,
    forbiddenInputs: allMembers(state).flatMap(m => m.transaction?.inputs.filter(c => !required.has(c.outpoint) || m.group !== g.id).map(c => c.outpoint) ?? []),
    forbiddenScripts: heldScripts(state), replacement: structuredClone(a.replacement), expectedTip: { tip: observation.tip, tipHash: observation.tipHash } };
}
function rebuildRequestForRetry(state: State, a: RefundAttempt): void {
  const peers = new Set(a.replacement.members.map(t => t.txid));
  if (!state.refundObservations.some(o => o.group === a.group && o.conflicts.some(c => c.confirmations >= 6 && !peers.has(c.txid))))
    fail("the conflict is no longer settled; rebuild remains reserved");
}
export function finishAttempt(state: State, a: RefundAttempt, request: BuildRequest, tx: PreparedRefund): void {
  const virtual = { ...request.group };
  recordBuilt(virtual, request, tx); attempt({ ...a, phase: "built", transaction: tx });
  const older = members(state, state.groups.find(g => g.id === a.group)!).filter(m => m.ordinal < a.ordinal && m.transaction);
  if (older.length !== a.replacement.members.length) fail("refund history changed while signing");
  a.transaction = structuredClone(tx); a.phase = "built";
}
