import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Effect } from 'effect';
import { DurableStore } from './src/storage/store.ts';
import { restoreApplication } from './src/application/recovery.ts';
import { refundPolicy } from './test/production/application-fixture.ts';
import { SshJournal, RecoveryCommand } from './src/storage/ssh-journal.ts';

const [configFile, root] = process.argv.slice(2); mkdirSync(join(root,'journal'),{mode:0o700});
const command = new RecoveryCommand(process.execPath,process.env.SUBSPACE_PACKAGE_CLIENT_DIRECTORY+'/client.mjs',configFile);
const began=performance.now();
const receipt=await Effect.runPromise(Effect.scoped(restoreApplication({database:join(root,'restored.db'),journalDirectory:join(root,'journal'),
  riskBudgetSats:1_000_000,refundPolicy,makeJournal:()=>new SshJournal(command)})));
assert.equal(receipt.acknowledged,true);assert.equal(receipt.orders.total,10000);assert.equal(receipt.orders.unknown_payment_history,7995);
assert.equal(receipt.sales_paused,true);assert.equal(receipt.restore_required,true);
console.log(JSON.stringify({phase:'restore',receipt,applicationMilliseconds:Math.round(performance.now()-began)}));
const measurements=await Effect.runPromise(Effect.scoped(Effect.gen(function*(){
  const storage=yield* DurableStore.open({database:join(root,'restored.db'),journalDirectory:join(root,'journal'),requireRestore:true,makeJournal:()=>new SshJournal(command)});
  const position=yield* storage.checkpoint();let started=performance.now();yield* storage.status();const statusMilliseconds=performance.now()-started;
  started=performance.now();const acknowledged=yield* storage.confirm(position.sequence);const liveGuardMilliseconds=performance.now()-started;
  assert.equal(acknowledged,true);return {phase:'guard',statusMilliseconds:Math.round(statusMilliseconds),liveGuardMilliseconds:Math.round(liveGuardMilliseconds),
    scope:'actual DurableStore.confirm current-head full-live-prefix guard; lower bound for a guarded request, not an HTTP latency claim'};
})));
console.log(JSON.stringify(measurements));
