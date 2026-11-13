import {createHash} from "node:crypto";
import {JOURNAL_PAGE_ENTRIES,JOURNAL_PAGE_BYTES,type RecoveryCommand} from "../storage/ssh-journal.ts";
import {decodeRecord} from "../controller/journal-protocol.ts";
/** Live full-prefix verification. A local controller mirror is never authority. */
export function confirmControllerReceipt(command:RecoveryCommand,receipt:{position:number;proofHash:string},proofHash:(value:unknown)=>string):void {
 const invalid=()=>Error("controller journal proof unavailable or changed");
 let after=0,bytes=0,last:string|null=null,row:Record<string,unknown>|undefined;
 while(true){
  const page=command.request<{head:number;entries:{sequence:number;sha256:string;data:string}[]}>({op:"journal-read",stream:"controller",after,limit:JOURNAL_PAGE_ENTRIES});
  if(page.head!==receipt.position||!Array.isArray(page.entries)||page.entries.length>JOURNAL_PAGE_ENTRIES||!Number.isSafeInteger(receipt.position)||receipt.position<1||receipt.position>1000000)throw invalid();
  let pageBytes=0;
  for(const item of page.entries){
   if(item.sequence!==after+1||typeof item.data!=="string"||typeof item.sha256!=="string")throw invalid();
   const raw=Buffer.from(item.data,"base64");bytes+=raw.length;pageBytes+=raw.length;
   if(raw.toString("base64")!==item.data||pageBytes>JOURNAL_PAGE_BYTES||bytes>512*1024*1024||createHash("sha256").update(raw).digest("hex")!==item.sha256)throw invalid();
   const value=decodeRecord(raw.toString()) as Record<string,unknown>;
   if(!value||Array.isArray(value)||value.seq!==item.sequence)throw invalid();
   row=value;last=item.sha256;after++;
  }
  if(after===page.head)break;
  if(!page.entries.length||after>page.head)throw invalid();
 }
 const head=command.request<{sequence:number;sha256:string|null}>({op:"journal-head",stream:"controller"});
 if(head.sequence!==receipt.position||head.sha256!==last||!row||Object.keys(row).sort().join()!=="kind,proofHash,seq,statement"||row.seq!==receipt.position||row.kind!=="store_reconciliation"||row.proofHash!==receipt.proofHash||proofHash(row.statement)!==receipt.proofHash)throw invalid();
}
