import { Effect } from "effect";
import { DurableStore, type StorageError } from "../storage/store.ts";
import { prepareStoredRecovery, readOnly } from "./recovery.ts";
import { ApplicationError, checked, fail, type State } from "./records.ts";
import { inventory, statement, type ControllerReceipt, type RecoveryInventory } from "./reconciliation-records.ts";
import { allMembers } from "../refunds/families.ts";
import { persist } from "./persistence.ts";
import { usableEntry } from "./supersession-records.ts";
import type { Adapters, Config } from "./store.ts";

export interface RecoveryController {
  run: (inventory: RecoveryInventory) => Effect.Effect<unknown,ApplicationError>;
  verify: (receipt: ControllerReceipt) => Effect.Effect<void,ApplicationError>;
  confirm: (receipt: ControllerReceipt) => Effect.Effect<void,ApplicationError>;
}
type Observation = { state: State; records: readonly import("./records.ts").Record[]; tipHash?: string | undefined };
export function reconcileRecovered(config: Config, adapters: Adapters, controller: RecoveryController,
  observe: (storage: DurableStore, readOnly: Adapters) => Effect.Effect<Observation,ApplicationError|StorageError>) {
  return Effect.gen(function*(){
    const storage=yield* DurableStore.open({...config,restore:false,requireRestore:true});
    const prepared=yield* prepareStoredRecovery(storage,config);
    yield* checked(()=>{if(allMembers(prepared).some(m=>m.transaction)&&!adapters.refunds?.sender)fail("refund observation adapter required","unavailable");});
    const current=yield* observe(storage,readOnly(adapters)), checkpoint=yield* storage.checkpoint();
    yield* checked(()=>{if(!current.tipHash)fail("coherent recovery tip required");});
    if(!(yield* storage.confirm(checkpoint.sequence)))return {ready:false,acknowledged:false,sales_paused:true,waiting:["store_journal"]};
    const input=yield* checked(()=>inventory(current.state,checkpoint.store,checkpoint.sequence,current.tipHash!));
    const raw=yield* controller.run(input), proof=yield* checked(()=>statement(raw,input));
    yield* controller.verify(proof);yield* controller.confirm(proof);
    const latest=yield* observe(storage,readOnly(adapters)), now=yield* storage.checkpoint();
    yield* checked(()=>{
      const a={...input,sequence:0},b={...inventory(latest.state,now.store,now.sequence,latest.tipHash!),sequence:0};
      if(JSON.stringify(a)!==JSON.stringify(b))fail("recovery inventory or tip changed; retry");
      for(const row of proof.statement.entries){
        if(row.mode==="closed"||row.mode==="superseded")continue;
        if(!usableEntry(latest.state,row.entry))fail("recovery entry is conflicted");
        if(row.observation){
          const old=latest.state.commitments.find(c=>c.entry===row.entry);
          if(old){old.revision++;old.observation=structuredClone(row.observation);}
          else latest.state.commitments.push({version:1,entry:row.entry,revision:1,observation:structuredClone(row.observation)});
        }
      }
      latest.state.settings.paused=true;
      latest.state.recovery={version:2,required:false,sourceSequence:input.sourceSequence,proofHash:proof.proofHash,
        controllerSequence:proof.position,tipHeight:input.tipHeight,tipHash:input.tipHash};
    });
    yield* controller.confirm(proof);
    yield* persist(storage,latest.records,latest.state,config.riskBudgetSats,latest.state.refunds);
    yield* storage.flush();const completed=yield* storage.status();
    if(!(yield* storage.confirm(completed.seq)))return {ready:false,acknowledged:false,sales_paused:true,waiting:["store_journal"]};
    yield* controller.confirm(proof);yield* storage.clearRestoreRequired(completed.seq);
    return {ready:true,acknowledged:true,sales_paused:true,waiting:[],proof_hash:proof.proofHash,controller_sequence:proof.position};
  });
}
