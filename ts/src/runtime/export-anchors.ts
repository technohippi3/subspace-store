import { Effect } from "effect";
import type { CoreAdapter } from "../bitcoin/core.ts";
import { BitcoinRpc, type RpcConfig } from "../bitcoin/rpc.ts";
import type { ExportContext } from "../application/certificate-export.ts";
import { ExportError } from "../application/certificate-export.ts";
interface RootAnchor { spaces_root:string; nums_root:string; block:{height:number;hash:string} }
function exact(value:unknown,keys:string):asserts value is {[key:string]:unknown}{
  if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).sort().join()!==keys.split(',').sort().join())throw Error("invalid anchors");
}
function anchors(value:unknown):RootAnchor[]{
  if(!Array.isArray(value)||!value.length||value.length>512)throw Error("bounded anchors required");
  const seen=new Set<number>();let previous=Number.MAX_SAFE_INTEGER;
  for(const row of value){exact(row,"spaces_root,nums_root,block");exact(row.block,"height,hash");
    if(![row.spaces_root,row.nums_root,row.block.hash].every(h=>typeof h==="string"&&/^[0-9a-f]{64}$/.test(h))||
      !Number.isSafeInteger(row.block.height)||(row.block.height as number)<0||(row.block.height as number)>=previous||seen.has(row.block.height as number))throw Error("invalid anchors");
    previous=row.block.height as number;seen.add(previous);
  }
  return value as RootAnchor[];
}
/** Trust only the operator-configured, bounded local spaced RPC and configured
 * Core identity. Neither the Message nor an HTTP request supplies an anchor. */
export function trustedRootAnchors(config:RpcConfig,core:Pick<CoreAdapter,"checkReady"|"containsBlock">){
  if(config.wallet!==undefined)throw new ExportError(503,"spaced node endpoint required");
  const rpc=new BitcoinRpc({...config,maximumBytes:1048576,timeoutMs:10000});
  return async(context:ExportContext):Promise<RootAnchor[]>=>{
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
    try{return await Effect.runPromise(Effect.gen(function*(){
      const start=yield*core.checkReady();
      const rows=anchors(yield*rpc.call("getrootanchors"));
      if(start.height-context.height<150||rows[0]!.block.height-context.height<144)throw Error("anchor coverage insufficient");
      for(const a of rows)if(a.block.height>start.height||!(yield*core.containsBlock({tipHash:start.hash,height:a.block.height,hash:a.block.hash})))throw Error("anchor is not active");
      const end=yield*core.checkReady();if(end.hash!==start.hash||end.height!==start.height)throw Error("chain moved during anchors");return rows;
    }),{signal:controller.signal});}
    catch{throw new ExportError(503,"trusted anchor observation unavailable");}finally{clearTimeout(timer);}
  };
}
