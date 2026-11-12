import { command, ownerInput, type SellerCommand } from "./application/seller-service.ts";
import { request } from "./application/records.ts";

export interface SellerClient {
  call(method:"GET"|"POST",path:string,value?:unknown):Promise<{[key:string]:unknown}>;
  readNomination(path:string):Promise<unknown>;
  reserveLink(path:string,intent:{[key:string]:unknown}):Promise<void>;
  saveLink(path:string,value:{order:string;order_link:string|null}):Promise<void>;
}
const usage="seller <config> status|diagnose|space add <space>|space pause/resume <space>|name list/price <handle> <sats>|name reserve/unreserve/withdraw/reopen <handle>|pause|resume|admission set <window-seconds> <maximum-requests> <maximum-orders>|owner retry <private-operation-record> --save-link <new-private-path> [--apply]|owner invoice <request.json> --operation <id> --confirm <handle> --save-link <private-path> [--apply]";
export async function sellerCommand(args:readonly string[],client:SellerClient):Promise<unknown>{
  const positional:string[]=[],flags=new Map<string,string|boolean>();
  for(let i=0;i<args.length;i++){
    const arg=args[i]!;if(!arg.startsWith("--")){positional.push(arg);continue;}
    if(flags.has(arg))throw Error(usage);
    if(arg==="--apply")flags.set(arg,true);
    else if(["--operation","--confirm","--save-link"].includes(arg)&&args[i+1]&&!args[i+1]!.startsWith("--"))flags.set(arg,args[++i]!);
    else throw Error(usage);
  }
  const [group,action,name,amount,extra]=positional;
  if(group==="status"||group==="diagnose"){
    if(positional.length!==1||flags.size)throw Error(usage);
    const status=await client.call("GET","/operator/status");
    if(group==="status")return status;
    const seller=status.seller as {[key:string]:unknown}|undefined;
    return {status,waiting:[...(!status.chain?["live_chain_readiness"]:[]),...(!status.acknowledged?["journal_acknowledgment"]:[]),
      ...((status.application_recovery as {required?:boolean}|null)?.required?["offline_controller_reconciliation"]:[]),
      ...(!seller?.explicit_limits?["explicit_admission_limits"]:[]),
      ...((seller?.uncertain_refund_sends as unknown[]|undefined)?.length?["attended_refund_inspection"]:[])],
      recovery:"Stop and fence the old instance before the documented restore/recover/reconcile commands. Never clear recovery flags by hand."};
  }
  if(group==="owner"){
    if(!["invoice","retry"].includes(action!)||positional.length!==3)throw Error(usage);
    const file=flags.get("--save-link");if(typeof file!=="string")throw Error(usage);
    let input:{[key:string]:unknown};let preview:{[key:string]:unknown};
    if(action==="retry"){
      if([...flags.keys()].some(k=>!["--save-link","--apply"].includes(k)))throw Error(usage);
      const saved=await client.readNomination(name!) as {request?:unknown};
      input={...ownerInput(saved?.request)};preview={retry_operation:input.operation,handle:input.handle};
    }else{
      const operation=flags.get("--operation"),confirm=flags.get("--confirm");
      if(typeof operation!=="string"||!/^[A-Za-z0-9_-]{32}$/.test(operation)||typeof confirm!=="string")throw Error(usage);
      const raw=await client.readNomination(name!);request(raw);const nomination=raw as {handle:string;script_pubkey:string};
      if(confirm!==nomination.handle)throw Error("exact owner handle confirmation required");
      preview=await client.call("POST","/operator/owner-orders/preview",nomination);
      input={...nomination,operation,confirm,review:preview.review};ownerInput(input);
    }
    if(!flags.has("--apply"))return {applied:false,...preview};
    await client.reserveLink(file,input);
    const result=await client.call("POST","/operator/owner-orders",input);
    if(typeof result.order!=="string"||typeof result.created!=="boolean")throw Error("invalid owner receipt");
    const link=result.created&&typeof result.order_link==="string"?result.order_link:null;
    await client.saveLink(file,{order:result.order,order_link:link});
    const {order_link:_link,...receipt}=result;
    return {...receipt,link_saved:link!==null};
  }
  if([...flags.keys()].some(k=>k!=="--apply"))throw Error(usage);
  let change:SellerCommand;
  if(group==="space"&&positional.length===3&&action==="add")change={action:"space",space:name!};
  else if(group==="space"&&positional.length===3&&["pause","resume"].includes(action!))change={action:"pause",space:name!,paused:action==="pause"};
  else if(group==="name"&&["list","price"].includes(action!)&&positional.length===4)change={action:"listing",handle:name!,price_sats:Number(amount)};
  else if(group==="name"&&["reserve","unreserve"].includes(action!)&&positional.length===3)change={action:"reservation",handle:name!,reserved:action==="reserve"};
  else if(group==="name"&&["withdraw","reopen"].includes(action!)&&positional.length===3)change={action:"withdrawal",handle:name!,withdrawn:action==="withdraw"};
  else if(["pause","resume"].includes(group!)&&positional.length===1)change={action:"pause",paused:group==="pause"};
  else if(group==="admission"&&action==="set"&&positional.length===5)change={action:"admission",window_seconds:Number(name),maximum_requests:Number(amount),maximum_orders:Number(extra)};
  else throw Error(usage);
  command(change);
  const preview=await client.call("POST","/operator/seller/preview",change);
  if(!flags.has("--apply"))return{applied:false,...preview};
  return{applied:true,...await client.call("POST","/operator/seller/apply",{...change,review:preview.review})};
}
