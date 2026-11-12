// Independent deterministic recovery oracle. No production imports or reducers.
import {Seller,type Payment as SellerPayment} from "./seller.ts";
import {RefundFamilies} from "./refund-families.ts";
import {Deficits} from "./obligations.ts";
import {refundPlan} from "./refunds.ts";
export class RecoveryTwin {
 seller=new Seller({riskBudget:1_000_000,requestWindowSeconds:3600,requestsPerWindow:120,maximumOrders:10000});
 readonly funds=new RefundFamilies();
 readonly groups:{id:string;order:number;charged:number;rate:number;txid:string;raw:string;fee:number;buyerFee:number;merchantFee:number;toBuyer:number}[]=[];
 readonly attempts:{id:string;group:string;ordinal:number;parent:string;charged:number;rate:number;txid:string;raw:string;fee:number;buyerFee:number;merchantFee:number;toBuyer:number}[]=[];
 readonly sends=new Map<string,{group:string;txid:string;calls:number}>();
 readonly alerts:{order:string;kind:string;amount:number;at:number;deadline:null}[]=[];
 readonly detected=new Set<number>();
 readonly unknown=new Set<number>();
 readonly deficits=new Map<number,Deficits>();
 private durable=this.seller.snapshot();
 private build=0;
 constructor(){this.seller.setup("space");for(let i=0;i<4;i++)this.seller.list(`n${i}@space`,1000);this.seller.pause(false);this.acknowledge();}
 acknowledge(){this.durable=this.seller.snapshot();}
 restore(){this.seller=Seller.restore(this.durable);for(const o of this.seller.snapshot().orders)if(o.destination&&!this.detected.has(o.id))this.unknown.add(o.id);}
 observe(now:number,tip:number,payments:SellerPayment[]){
  this.seller.observe(now,tip,payments);
  for(const o of this.seller.snapshot().orders){
   if(payments.some(p=>p.order===o.id)){this.detected.add(o.id);this.unknown.delete(o.id);}
   const key=`o${o.id}`,settled=payments.filter(p=>p.order===o.id&&p.confirmations>=6).reduce((s,p)=>s+p.sats,0);
   this.funds.receipts.set(key,settled);this.funds.prices.set(key,["cancelled","refund_due"].includes(o.state)?0:o.price??0);
   const deficit=this.deficits.get(o.id)??new Deficits();this.deficits.set(o.id,deficit);
   const before=deficit.alerts.length,batchable=payments.filter(p=>p.order===o.id&&p.confirmations>=3).reduce((s,p)=>s+p.sats,0);
   deficit.evaluate(new Map([["issuance",o.state==="converted"?Math.max(0,o.price!-batchable):0]]));
   for(const event of deficit.alerts.slice(before))this.alerts.push({order:key,kind:event.reason,amount:event.amount,at:now,deadline:null});
  }
 }
 private tx(principal:number,rate:number,inputs:string[]){
  const n=++this.build,txid=n.toString(16).padStart(64,"a"),raw="ab"+n.toString(16).padStart(2,"0");
  const plan=refundPlan(principal,100,rate,false,{minimumRate:1000,maximumRate:100000,fallbackRate:2000,buyerFeeCeiling:200});
  this.funds.transaction(txid,inputs);return{txid,raw,...plan};
 }
 open(group:string,order:number,principal:number,inputs:string[]){
  const tx=this.tx(principal,2000,inputs);this.funds.open(group,`o${order}`,tx.txid,principal);
  const row={id:group,order,charged:principal,rate:2000,txid:tx.txid,raw:tx.raw,fee:tx.fee,buyerFee:tx.buyerFee,merchantFee:tx.merchantFee,toBuyer:tx.toBuyer};this.groups.push(row);return row;
 }
 bump(group:string,rate:number,inputs:string[]){
  const g=this.groups.find(g=>g.id===group)!;const tx=this.tx(g.charged,rate,inputs);this.funds.add(group,tx.txid,g.charged);
  const row={id:group+".a1",group,ordinal:1,parent:g.txid,charged:g.charged,rate,txid:tx.txid,raw:tx.raw,fee:tx.fee,buyerFee:tx.buyerFee,merchantFee:tx.merchantFee,toBuyer:tx.toBuyer};this.attempts.push(row);return row;
 }
 send(group:string,txid:string){const previous=this.sends.get(txid);this.sends.set(txid,{group,txid,calls:(previous?.calls??0)+1});}
}
