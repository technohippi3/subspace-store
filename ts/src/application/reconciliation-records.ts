import { createHash } from "node:crypto";
import { fail, whole, type State } from "./records.ts";
import { observation, type CommitmentObservation } from "./commitment-records.ts";

export interface RecoveryInventory {
  version: 1; store: string; sourceSequence: number; sequence: number; tipHeight: number; tipHash: string;
  orders: { id: string; handle: string; recipient: string; status: string }[];
  spaces: string[];
  entries: { entry: string; root: string; space: string; oids: string[]; delegate: string | null; closed: boolean; superseded: boolean;
    txid: string | null; conflictTxid: string | null; revision: number }[];
}
export interface RecoveryStatement {
  version: 1; store: string; sourceSequence: number; sequence: number; tipHeight: number; tipHash: string;
  entries: { entry: string; root: string; space: string; oids: string[]; delegate: string | null;
    mode: "closed" | "superseded" | "unsent" | "observed"; walletTxid: string | null; observation: CommitmentObservation | null }[];
  spaces: { space: string; subsRoot: string | null; chainRoot: string | null; subsTxid: string | null; ahead: string | null }[];
}
export interface ControllerReceipt { statement: RecoveryStatement; position: number; proofHash: string }
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.entries(value).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key,v]) => JSON.stringify(key)+":"+canonical(v)).join(",") + "}";
  return JSON.stringify(value);
}
export const proofHash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
export function fields(v: unknown, keys: string): asserts v is { [key: string]: unknown } {
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).sort().join() !== keys.split(",").sort().join()) fail("invalid recovery statement fields");
}
export function hash(v: unknown): asserts v is string { if (typeof v !== "string" || !/^[0-9a-f]{64}$/.test(v)) fail("invalid recovery hash"); }
export function inventory(state: State, store: string, sequence: number, tipHash: string): RecoveryInventory {
  if (!state.recovery) fail("application has no recovery history");
  return { version: 1, store, sequence, sourceSequence: state.recovery.sourceSequence, tipHeight: state.settings.tip, tipHash,
    spaces: [...new Set(state.listings.map(n => "@" + n.space))].sort(),
    orders: state.orders.map(o => ({ id: o.id, handle: o.handle, recipient: o.recipient, status: o.status })).sort((a,b)=>a.id.localeCompare(b.id)),
    entries: state.entries.map(e => { const arm=state.arms.find(a=>a.id===e.id), c=state.commitments.find(c=>c.entry===e.id);
      return { entry:e.id, root:e.root, space:"@"+e.bindings[0]!.handle.split("@")[1],oids:e.bindings.map(b=>b.id), delegate:arm?.delegate??null,
        closed:state.closures.some(c=>c.id===e.id), superseded:state.supersessions.some(s=>s.entry===e.id&&s.active),
        txid:c?.observation.txid??null, conflictTxid:state.supersessions.find(s=>s.entry===e.id&&s.active)?.conflictTxid??null,
        revision:c?.revision??0 }; }).sort((a,b)=>a.entry.localeCompare(b.entry)) };
}
export function statement(value: unknown, input: RecoveryInventory): ControllerReceipt {
  fields(value,"statement,position,proofHash"); whole(value.position,1); hash(value.proofHash);
  const v=value.statement;fields(v,"version,store,sourceSequence,sequence,tipHeight,tipHash,entries,spaces");
  for (const key of ["version","store","sourceSequence","sequence","tipHeight","tipHash"] as const) if (v[key]!==input[key]) fail("recovery inventory changed");
  if (!Array.isArray(v.entries)||!Array.isArray(v.spaces)||v.entries.length!==input.entries.length||v.spaces.length!==input.spaces.length) fail("incomplete recovery statement");
  const seen=new Set<string>();
  for(const row of v.entries){
    fields(row,"entry,root,space,oids,delegate,mode,walletTxid,observation");
    const e=input.entries.find(e=>e.entry===row.entry);
    if(!e||seen.has(e.entry)||row.root!==e.root||row.space!==e.space||row.delegate!==e.delegate||JSON.stringify(row.oids)!==JSON.stringify(e.oids))fail("recovery entry binding differs");seen.add(e.entry);
    const mode=e.closed?"closed":e.superseded?"superseded":e.delegate===null?"unsent":"observed";
    if(row.mode!==mode)fail("recovery cannot change issuance permission");
    if(mode==="observed"){
      observation(row.observation);if(row.observation.tipHash!==input.tipHash||row.observation.tipHeight!==input.tipHeight||e.txid&&e.txid!==row.observation.txid)fail("recovery observation differs");
      if(row.walletTxid!==row.observation.txid||row.observation.minedHeight!==null&&row.observation.rootHeight!==row.observation.minedHeight)fail("recovery transaction is not accepted by Spaces or wallet");
    }else if(row.observation!==null)fail("unexpected recovery observation");
    if(mode==="superseded"?row.walletTxid!==e.conflictTxid||row.walletTxid===null:mode!=="observed"&&row.walletTxid!==null)fail("recovery wallet history differs");
  }
  const spaces=new Set<string>();
  for(const row of v.spaces){
    fields(row,"space,subsRoot,chainRoot,subsTxid,ahead");
    if(typeof row.space!=="string"||!input.spaces.includes(row.space)||spaces.has(row.space))fail("invalid recovery space");spaces.add(row.space);
    for(const k of ["subsRoot","chainRoot","subsTxid"])if(row[k]!==null)hash(row[k]);
    if(row.ahead!==null&&(typeof row.ahead!=="string"||!input.entries.some(e=>e.entry===row.ahead&&!e.closed&&!e.superseded&&e.root===row.subsRoot)))fail("unbound local tree ahead of chain");
    if(row.subsRoot!==row.chainRoot&&row.ahead===null)fail("restored subs root differs from chain");
    if(row.ahead!==null){const e=(v.entries as RecoveryStatement["entries"]).find(e=>e.entry===row.ahead)!;
      if(row.subsRoot===row.chainRoot||e.mode==="observed"&&e.observation?.minedHeight!==null)fail("local tree is not a pending commitment");}
  }
  for(const e of input.entries)for(const oid of e.oids){const o=input.orders.find(o=>o.id===oid)!;if(!spaces.has("@"+o.handle.split("@")[1]))fail("missing recovery space");}
  if(proofHash(v)!==value.proofHash)fail("controller recovery digest differs");
  return value as unknown as ControllerReceipt;
}
