import type { IncomingMessage } from "node:http";
import { Effect } from "effect";
import { ApplicationError, checked, fail } from "./records.ts";
import { body } from "./http.ts";
import { command } from "./seller-service.ts";
/** Flat operator inputs use unescaped field names and string values. Duplicate
 * keys are rejected before JSON.parse can discard them. No extra body fields. */
export function sellerBody(request: IncomingMessage) {
  return Effect.tryPromise({try:async()=>{
    const raw=await body(request,4096);if(raw.includes("\\"))throw Error("escaped operator input");
    const value:unknown=JSON.parse(raw);if(!value||typeof value!=="object"||Array.isArray(value))throw Error("object required");
    const keys=[...raw.matchAll(/"([^"\\]*)"\s*:/g)].map(m=>m[1]);if(new Set(keys).size!==keys.length)throw Error("repeated field");
    return value as {[key:string]:unknown};
  },catch:()=>new ApplicationError({code:"invalid",message:"invalid seller request"})});
}
export function sellerApplyBody(request: IncomingMessage){return Effect.gen(function*(){const v=yield* sellerBody(request);
  return yield* checked(()=>{const {review,...input}=v;if(typeof review!=="string"||!/^[0-9a-f]{64}$/.test(review))fail("invalid review","invalid");return{command:command(input),review};});});}
