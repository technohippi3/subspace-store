import { createHash, randomBytes } from "node:crypto";
import { Effect } from "effect";
import { checked, claims, fail, request, sats, type State } from "./records.ts";
import { canonicalHandle } from "../recipient.ts";
import type { RegistryContext } from "./registry.ts";
import { active, admission, total } from "./sales.ts";
import { refunded } from "../refunds/observations.ts";
import { createRequested, digest, fields, invoiceRestricted, limits, namePolicy, spaceLabel } from "./seller-records.ts";
import { summary as commitmentSummary } from "./commitment-records.ts";

export type SellerCommand = { action: "space"; space: string } | { action: "listing"; handle: string; price_sats: number } |
  { action: "reservation"; handle: string; reserved: boolean } | { action: "withdrawal"; handle: string; withdrawn: boolean } |
  { action: "pause"; paused: boolean; space?: string } |
  { action: "admission"; window_seconds: number; maximum_requests: number; maximum_orders: number };
export interface OwnerNomination { handle: string; script_pubkey: string }
export interface OwnerInput extends OwnerNomination { operation: string; confirm: string; review: string }
export function command(value: unknown): SellerCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid seller command", "invalid");
  const v = value as { [key: string]: unknown };
  switch(v.action) {
    case "space": fields(v,"action,space"); spaceLabel(v.space); break;
    case "listing": fields(v,"action,handle,price_sats"); if(!canonicalHandle(v.handle))fail("invalid handle","invalid"); sats(v.price_sats); break;
    case "reservation": case "withdrawal": {
      const key=v.action==="reservation"?"reserved":"withdrawn"; fields(v,`action,handle,${key}`);
      if(!canonicalHandle(v.handle)||typeof v[key]!=="boolean") fail("invalid name command","invalid"); break;
    }
    case "pause": fields(v,v.space===undefined?"action,paused":"action,paused,space"); if(typeof v.paused!=="boolean")fail("invalid pause","invalid"); if(v.space!==undefined)spaceLabel(v.space); break;
    case "admission": fields(v,"action,window_seconds,maximum_requests,maximum_orders");
      limits({windowSeconds:v.window_seconds,maximumRequests:v.maximum_requests,maximumOrders:v.maximum_orders}); break;
    default: fail("invalid seller command","invalid");
  }
  return structuredClone(v) as SellerCommand;
}
function nomination(value: unknown): OwnerNomination {
  fields(value,"handle,script_pubkey"); request(value); return value as unknown as OwnerNomination;
}
export function ownerInput(value: unknown): OwnerInput {
  fields(value,"operation,handle,script_pubkey,confirm,review"); request({handle:value.handle,script_pubkey:value.script_pubkey});
  if(typeof value.operation!=="string"||!/^[A-Za-z0-9_-]{32}$/.test(value.operation)||value.confirm!==value.handle||
      typeof value.review!=="string"||!/^[0-9a-f]{64}$/.test(value.review))fail("exact owner confirmation required","invalid");
  return value as unknown as OwnerInput;
}
interface Context extends Pick<RegistryContext,"storage"|"queue"|"load"|"refresh"|"save"> {
  clock:()=>number;
  loadRecovery:RegistryContext["load"];
  quote:(id:string)=>Effect.Effect<{acknowledged:boolean;address:string|null;price_sats:number|null}, import("./records.ts").ApplicationError|import("../storage/store.ts").StorageError>;
}
export class SellerOperations {
  private readonly context: Context;
  constructor(context: Context) { this.context=context; }
  maintenance() {
    const c=this.context;
    return c.queue.withPermit(Effect.gen(function*(){
      const initial=yield* c.loadRecovery();
      const observed=yield* c.refresh().pipe(Effect.match({onSuccess:value=>value,onFailure:()=>null}));
      const state=observed?.state??initial.state,blockers:{kind:string;id:string}[]=[];
      const chain=observed?.tipHash?{height:state.settings.tip,hash:observed.tipHash}:null;
      if(!chain)blockers.push({kind:"chain_unavailable",id:"global"});
      if(!state.settings.paused)blockers.push({kind:"admission_open",id:"global"});
      if(state.recovery?.required)blockers.push({kind:"restore_quarantine",id:"global"});
      for(const o of state.orders){
        if(active(state,o))blockers.push({kind:"active_hold",id:o.id});
        if(o.status==="issuing")blockers.push({kind:"issuing_order",id:o.id});
      }
      for(const e of state.entries){
        if(state.closures.some(v=>v.id===e.id))continue;
        // refresh revalidates every active conflict proof against this exact
        // current chain. A retained historical arm is then a closed disposition.
        if(observed&&state.supersessions.some(s=>s.entry===e.id&&s.active))continue;
        const commitment=state.commitments.find(v=>v.entry===e.id);
        const settled=commitment&&commitmentSummary(commitment.observation).phase==="final"&&commitmentSummary(commitment.observation).covered&&
          e.bindings.every(b=>state.orders.some(o=>o.id===b.id&&o.status==="fulfilled")&&state.fulfillments.some(f=>f.oid===b.id&&f.entry===e.id)&&
            !state.incidents.some(i=>i.oid===b.id&&i.resolution===null));
        if(!settled)blockers.push({kind:state.arms.some(a=>a.id===e.id)?"armed_entry":"issuance_entry",id:e.id});
      }
      for(const send of state.refundSends){const fact=state.refundObservations.find(o=>o.txid===send.txid);
        if(!fact||fact.seen==="absent")blockers.push({kind:"uncertain_refund_send",id:send.txid});}
      const flushed=yield* c.storage.flush().pipe(Effect.match({onSuccess:value=>value,onFailure:()=>false}));
      const position=yield* c.storage.status();
      const acknowledged=flushed&&(yield* c.storage.confirm(position.seq));
      if(!acknowledged)blockers.push({kind:"journal_unavailable",id:"global"});
      blockers.sort((a,b)=>a.kind.localeCompare(b.kind)||a.id.localeCompare(b.id));
      return{paused:state.settings.paused,reviewCount:state.settings.conversions.length,blockers,
        ready:state.settings.paused&&blockers.length===0,acknowledged,chain};
    }));
  }
  inspect(state: State) {
    const held=state.orders.filter(o=>active(state,o));
    const confirmed=state.payments.filter(p=>p.active&&p.confirmations>=1).reduce((sum,p)=>sum+p.sats,0)-refunded(state);
    const exposure=confirmed+held.reduce((sum,o)=>sum+Math.max(0,o.price!-total(state,o,1)),0);
    return { revision:state.seller.revision, explicit_limits:state.seller.configured, admission_limits:structuredClone(state.seller.limits),
      request_window:structuredClone(state.seller.requestWindow), retained_orders:state.orders.length,
      spaces:structuredClone(state.spaces), names:state.listings.map(n=>({...n, reserved:namePolicy(state,n.handle)?.reserved??false,withdrawn:namePolicy(state,n.handle)?.withdrawn??false})),
      converted_count:state.settings.conversions.length, active_holds:held.length, exposure_sats:exposure,
      exposure_limit_sats:Math.min(state.settings.riskBudget,10*state.listings.reduce((max,n)=>Math.max(max,n.price),0)),
      uncertain_refund_sends:state.refundSends.filter(s=>s.result==="uncertain").map(s=>({group:s.group,txid:s.txid})) };
  }
  private reviewed(state: State, input: SellerCommand|OwnerNomination) {
    const handle="handle" in input?input.handle:undefined;
    const space="space" in input?input.space:undefined;
    const affected=state.orders.filter(o=>(!handle||o.handle===handle)&&(!space||o.space===space)).map(o=>({
      order:o.id, handle:o.handle, status:o.status, invoice:o.destination!==null, price_sats:o.price,
      active_hold:active(state,o), hold_expires_at:active(state,o)?o.grants.at(-1)!.until:null,
      detected_sats:total(state,o,0), confirmed_sats:total(state,o,1), payment_history:o.paymentHistory,
      hold_seen_height:o.grants.at(-1)?.seenHeight??null, hold_acquired_height:o.grants.at(-1)?.acquiredHeight??null,
      fulfillment_reserved:claims(o), withdrawn_invoice:state.withdrawals.some(w=>w.order===o.id),
      refund_only:invoiceRestricted(state,o,active(state,o))||["cancelled","refund_due"].includes(o.status),
      entries:state.entries.filter(e=>e.bindings.some(b=>b.id===o.id)).map(e=>e.id).sort() }));
    const material={input,revision:state.seller.revision,affected,paused:state.settings.paused,
      spaces:state.spaces.filter(s=>!space||s.space===space), names:state.listings.filter(n=>!handle||n.handle===handle),
      policies:state.namePolicies.filter(n=>!handle||n.handle===handle),
      recovery:state.recovery, exposure_sats:this.inspect(state).exposure_sats, active_holds:this.inspect(state).active_holds};
    return {review:digest(material),affected,policy:this.inspect(state)};
  }
  preview(value: unknown) {
    const c=this.context,self=this;
    return Effect.gen(function*(){const input=yield* checked(()=>command(value));return yield* c.queue.withPermit(Effect.gen(function*(){
      const {state}=yield* c.refresh(); return self.reviewed(state,input);
    }));});
  }
  apply(value: unknown, review: string) {
    const c=this.context,self=this;
    return Effect.gen(function*(){const input=yield* checked(()=>command(value));return yield* c.queue.withPermit(Effect.gen(function*(){
      const {records,state}=yield* c.refresh(); const preview=self.reviewed(state,input);
      yield* checked(()=>{if(review!==preview.review)fail("seller effects changed; preview again");self.mutate(state,input);});
      yield* c.save(records,state); yield* c.storage.flush(); const position=yield* c.storage.status();
      return {...self.reviewed(state,input),acknowledged:yield* c.storage.confirm(position.seq)};
    }));});
  }
  private mutate(state: State, input: SellerCommand) {
    const policy=()=>{let n=state.namePolicies.find(n=>n.handle===(input as {handle:string}).handle);
      if(!n){n={version:1,handle:(input as {handle:string}).handle,reserved:false,withdrawn:false};state.namePolicies.push(n);}return n;};
    const before=digest([state.spaces,state.namePolicies,state.withdrawals,state.listings,state.settings.paused,state.seller.limits,state.seller.configured]);
    switch(input.action){
      case "space": if(!state.spaces.some(s=>s.space===input.space))state.spaces.push({version:1,space:input.space,paused:false,catalog:"listed"});break;
      case "listing": {
        const space=input.handle.split("@")[1]!;if(!state.spaces.some(s=>s.space===space))fail("set up the space first");
        const n=state.listings.find(n=>n.handle===input.handle);if(n)n.price=input.price_sats;else state.listings.push({handle:input.handle,space,price:input.price_sats});break;
      }
      case "reservation": case "withdrawal": {
        if(!state.listings.some(n=>n.handle===input.handle))fail("not listed");const n=policy();
        if(input.action==="reservation")n.reserved=input.reserved;
        else {n.withdrawn=input.withdrawn;if(input.withdrawn)for(const o of state.orders.filter(o=>o.handle===input.handle&&o.destination&&!claims(o)&&!["cancelled","refund_due"].includes(o.status)))
          if(!state.withdrawals.some(w=>w.order===o.id))state.withdrawals.push({version:1,order:o.id,at:state.settings.lastTime});}break;
      }
      case "pause": if(input.space){const s=state.spaces.find(s=>s.space===input.space);if(!s)fail("unknown space");s.paused=input.paused;}else state.settings.paused=input.paused;break;
      case "admission": state.seller.limits={windowSeconds:input.window_seconds,maximumRequests:input.maximum_requests,maximumOrders:input.maximum_orders};state.seller.configured=true;break;
    }
    if(before!==digest([state.spaces,state.namePolicies,state.withdrawals,state.listings,state.settings.paused,state.seller.limits,state.seller.configured]))state.seller.revision++;
  }
  ownerPreview(value: unknown) {
    const c=this.context,self=this;
    return Effect.gen(function*(){const input=yield* checked(()=>nomination(value));return yield* c.queue.withPermit(Effect.gen(function*(){
      const {state}=yield* c.refresh();return self.reviewed(state,input);
    }));});
  }
  ownerInvoice(value: unknown) {
    const c=this.context,self=this;
    return Effect.gen(function*(){const input=yield* checked(()=>ownerInput(value));return yield* c.queue.withPermit(Effect.gen(function*(){
      const initial=yield* c.load(), previous=initial.state.ownerAuthorizations.find(a=>a.operation===input.operation);
      if(previous){
        yield* checked(()=>{if(previous.handle!==input.handle||previous.recipient!==input.script_pubkey||previous.review!==input.review)fail("owner operation binding differs");});
        let o=initial.state.orders.find(o=>o.id===previous.order)!;
        if(o.status==="requested")yield* c.quote(o.id);
        o=(yield* c.load()).state.orders.find(o=>o.id===previous.order)!;
        return {created:false,order:o.id,status:o.status};
      }
      const {records,state}=yield* c.refresh();
      const n={handle:input.handle,script_pubkey:input.script_pubkey};
      yield* checked(()=>{if(input.review!==self.reviewed(state,n).review)fail("owner effects changed; preview again");});
      const token=randomBytes(24).toString("base64url");
      const o=yield* checked(()=>{
        const price=state.listings.find(n=>n.handle===input.handle)?.price;if(price===undefined)fail("not listed");
        const o=createRequested(state,request(n),createHash("sha256").update(token).digest("hex"),c.clock());
        state.ownerAuthorizations.push({version:1,operation:input.operation,order:o.id,handle:o.handle,recipient:o.recipient,price,
          review:input.review,authorizedAt:state.settings.lastTime});
        admission(state,o);return o;
      });
      yield* c.storage.flush();const position=yield* c.storage.status();
      if(!(yield* c.storage.confirm(position.seq)))return yield* checked(()=>fail("owner authorization journal unavailable","unavailable"));
      yield* c.save(records,state);
      const invoice=yield* c.quote(o.id);
      return {created:true,order:o.id,status:"quoted",invoice,order_link:invoice.acknowledged?`/o/${token}`:null};
    }));});
  }
}
