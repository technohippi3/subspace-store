import {configuration} from '../../src/runtime/config.ts';
import {restoreBoundary} from './controller-recovery-fixture.mjs';
// Scenarios are called by unconditional, typed Node test entry points.
const cases = new Map();
function test(title, callback) { const id = title.split(':')[0]; if (cases.has(id)) throw Error('duplicate scenario'); cases.set(id, callback); }
export async function runCase(id, context) { const scenario = cases.get(id); if (!scenario) throw Error('unknown scenario'); await scenario(context); }
import {readFileSync,copyFileSync,writeFileSync,mkdirSync,existsSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {within,assert,run,scoped,b,sent,assertError,cancelled,rejectCancel,supersede,Effect} from './controller-case-fixture.mjs';
import {SalesStore} from '../../src/application/store.ts';
import {restoreApplication} from '../../src/application/recovery.ts';
import {recovered} from './recovery-fixture.ts';
import {DurableStore} from '../../src/storage/store.ts';
import {inventory} from '../../src/application/reconciliation-records.ts';

// These are boundary qualification, with recording upstream RPCs and verifier.
// They do not establish Bitcoin consensus, real proof verification or host backups.
test('B1: payment depth lost after checkpoint rebuilds one member out and preserves its reserve',async(t)=>within(t,async w=>{
 await w.prepare();w.f.node.outputs[0].confirmations=2;const out=await w.command('issue');assert.equal(out.error,null);assert.equal(b(out).state,'rebuilt');assert.deepEqual(b(out,'b2').members,['o2']);assert.equal(sent(out),0);
 const failed=await run(w.store.inspectionOrder('o1'));assert(failed.reasons.includes('issuance'));assert.equal(failed.status,'converted');assert.equal(failed.price_reserve,10000);assert.equal((await run(w.store.registry.entry('o1'))).batch_entry,false);
 const child=await w.command('prepare-child','b2');assert.equal(child.error,null);const sentChild=await w.command('issue','b2');assert.equal(sent(sentChild),1);assert.equal(b(sentChild,'b2').state,'broadcast');
}));
test('B2: pilot refuses unsupported proof inputs and freshly rechecks actual recipient binding',async(t)=>within(t,async w=>{
 // Explicit pilot equivalent, not a fabricated eligibility/quota implementation.
 const before=(await run(w.store.inspectionOrders())).orders.length;
 const config={version:1,network:'regtest',database:w.f.config.database,journalDirectory:w.f.config.journalDirectory,listen:{buyer:10001,operator:10002,subs:10003},core:{url:'http://127.0.0.1:1',cookiePath:join(w.f.root,'mock-cookie'),wallet:'mock'},credentials:{operator:join(w.f.root,'mock-operator'),subs:join(w.f.root,'mock-subs')},riskBudgetSats:1000000,refundPolicy:w.f.config.refundPolicy,merchantDestinations:[],pollMilliseconds:100};
 configuration(config);assert.throws(()=>configuration({...config,eligibility:{quota:1}}),/invalid.*runtime configuration/);
 await assert.rejects(run(w.store.request({handle:'n4@space',script_pubkey:'5120'+'1'.padStart(64,'0')})),/script already used/);
 await assert.rejects(run(w.store.request({handle:'n4@space',script_pubkey:'5120'+'3'.padStart(64,'0'),eligibility:{quota:1}})),/invalid recipient request/);
 assert.equal((await run(w.store.inspectionOrders())).orders.length,before);
 await w.prepare();await cancelled(w,0);const out=await w.command('issue');assert.deepEqual(b(out,'b2').members,['o2']);assert.equal(sent(out),0);
}));
test('B3: all passing members are atomically issuing before the sole controller send',async(t)=>within(t,async w=>{
 const out=await w.issued();assert.equal(sent(out),1);for(const id of ['o1','o2']){const o=await run(w.store.inspectionOrder(id));assert.equal(o.status,'issuing');assert.equal(o.journaled_status,'issuing');}
 const ack=out.journal.filter(e=>e.kind==='batch'&&e.batch.intent).at(-1);assert.equal(ack.batch.delegate_in,w.chain.delegate);assert.equal(b(out).attempted,1);
}));
test('B4: reopening a checkpointed controller repeats the binding check before issuance',async(t)=>within(t,async w=>{
 await w.prepare(); // separate process exits after the actual checkpoint command
 w.f.node.outputs[1].confirmations=2;const out=await w.command('issue');assert.equal(out.error,null);assert.deepEqual(b(out,'b2').members,['o1']);assert.equal(sent(out),0);assert.equal((await run(w.store.inspectionOrder('o2'))).price_reserve,10000);
}));
test('B5: three successive failed rebuilds pause until the next block and alert the operator',async(t)=>within(t,async w=>{
 let id='b1';await w.prepare();
 for(let victim=0;victim<2;victim++){w.f.node.outputs[victim].confirmations=2;if(victim===0){assert.equal((await w.command('crash-after-rebuild-guard',id)).crashed,9);const retained=await w.command('status');assert.equal(retained.journal.filter(e=>e.kind==='rebuild_guard').at(-1).count,1);}const out=await w.command('issue',id);assert.equal(out.error,null);id=out.result.bid??out.result;await w.command('prepare-child',id);}
 w.f.node.outputs[2].confirmations=2;const out=await w.command('issue',id);
 assertError(out,/three rebuilds|next block/);assert.equal(sent(out),0);assert(out.alerts.some(a=>a.kind==='rebuilds'));
 const frozen=await w.command('freeze');assertError(frozen,/next block|rebuild/);w.f.node.tip++;const resumed=await w.command('freeze');assert.equal(resumed.error,null);const next=b(resumed,'b4');assert.deepEqual(next.members,['o4']);await w.command('prepare-child','b4');const successful=await w.command('issue','b4');assert.equal(successful.error,null);assert.equal(sent(successful),1);assert.equal(successful.journal.filter(e=>e.kind==='rebuild_guard').at(-1).count,0);
 const late=await w.command('retry-release',id);assertError(late,/three rebuilds/);assert(!late.batches.some(batch=>batch.supersedes===id));assert.equal(late.journal.filter(e=>e.kind==='rebuild_guard').at(-1).count,0);
 const journalFile=join(w.f.root,'controller-journal','runner.jsonl');const lines=readFileSync(journalFile,'utf8').trim().split('\n');writeFileSync(journalFile,lines.join('\n')+'\n'+JSON.stringify({seq:lines.length+1,kind:'rebuild_guard',version:99,count:0,last_bid:null,paused_at:null,paused_bid:null})+'\n');await assert.rejects(w.command('status'),/invalid rebuild guard history/);
},4));
test('B6: an open batch excludes a second freeze until finality, rebuilding or supersession',async(t)=>within(t,async w=>{
 await w.prepare();let out=await w.command('freeze');assertError(out,/another batch is open/);await w.command('issue');out=await w.command('freeze');assertError(out,/another batch is open/);assert.equal(sent(out),1);
 w.chain.minedHeight=50;w.chain.roots[w.chain.root]=50;w.chain.latestRoot=w.chain.root;await w.command('watch');await run(w.store.listName('n2@space',10000));const link=await run(w.store.request({handle:'n2@space',script_pubkey:'5120'+'3'.padStart(64,'0')}));await run(w.store.quote(link.token));w.f.node.outputs.push({outpoint:'3'.repeat(64)+':0',script:'0014'+'3'.padStart(40,'0'),sats:10000,confirmations:3});
 out=await w.command('freeze');assert.equal(out.error,null);assert.deepEqual(b(out,'b2').members,['o3']);assert.equal(sent(out),1);
}));
test('B7: a settled delegate move after freeze is read into the intent at issuance',async(t)=>within(t,async w=>{
 await w.prepare();w.chain.delegate='e'.repeat(64)+':1';const out=await w.command('issue');assert.equal(out.error,null);assert.equal(b(out).delegate_in,w.chain.delegate);assert.equal(out.subs.broadcasts[0].delegate,w.chain.delegate);
 assert.equal(out.journal.filter(e=>e.kind==='batch'&&e.batch.intent).at(-1).batch.delegate_in,w.chain.delegate);
 // Actual native commitment construction/spend remains a separate regtest obligation.
}));
test('X1: cancelled orders are excluded by the shipped controller freeze',async(t)=>within(t,async w=>{
 await cancelled(w);const out=await w.command('freeze');assert.equal(out.error,null);assert.deepEqual(b(out).members,['o2']);assert.equal(sent(out),0);
}));
test('X2: cancellation during the proved checkpoint interval rebuilds and the actual refund flow proceeds',async(t)=>within(t,async w=>{
 w.f.node.outputs.forEach(o=>o.confirmations=6);await run(w.store.setRefundDestination(w.tokens[0],'buyer-refund'));
 const proving=w.command('prepare-wait-prove');const deadline=Date.now()+5000;while(!existsSync(join(w.f.root,'prove-entered'))){assert(Date.now()<deadline,'controller never reached proving');await new Promise(resolve=>setTimeout(resolve,10));}
 await cancelled(w);writeFileSync(join(w.f.root,'allow-proof'),'');const prepared=await proving;assert.equal(prepared.error,null);
 const out=await w.command('issue');assert.equal(out.error,null);assert.deepEqual(b(out,'b2').members,['o2']);assert.equal(sent(out),0);
 const refund=await run(w.store.prepareOperatorRefund('o1','cancellation','buyer'));await run(w.store.broadcastOperatorRefund(refund.id,refund.txid));assert.equal(w.f.sent.length,1);assert.equal((await run(w.store.order(w.tokens[0]))).status,'cancelled');
}));
test('X3: cancellation and bound entry serialize with exactly one winner',async(t)=>{
 for(const winner of ['cancel','issue'])await within(t,async w=>{
  await w.prepare();if(winner==='cancel'){await cancelled(w);const out=await w.command('issue');assert.equal(sent(out),0);assert(!b(out,'b2')?.members.includes('o1'));}
  else{await w.command('issue');await rejectCancel(w);assert.equal((await run(w.store.order(w.tokens[0]))).status,'issuing');}
 });
 await within(t,async w=>{await w.prepare();const [issuance,cancellation]=await Promise.allSettled([w.command('issue'),cancelled(w)]);assert.equal(issuance.status,'fulfilled');const order=await run(w.store.order(w.tokens[0]));assert(['cancelled','issuing'].includes(order.status));if(order.status==='issuing'){assert.equal(cancellation.status,'rejected');assert.equal(sent(issuance.value),1);}else{assert.equal(cancellation.status,'fulfilled');assert.equal(sent(issuance.value),0);}});
});
test('X4: lost commitment broadcast response keeps cancellation locked',async(t)=>within(t,async w=>{
 await w.prepare();const out=await w.command('lost-answer');assert.equal(b(out).state,'broadcast_uncertain');assert.equal(sent(out),1);await rejectCancel(w);assertError(await w.command('resume'),/uncertain|nothing to resume/);
}));
test('X5: days without a transaction in any recorded mempool do not authorize cancellation or supersession',async(t)=>within(t,async w=>{
 await w.prepare();await w.command('lost-answer');w.chain.known=false;w.chain.mempool=false;w.f.node.now+=3*86400;w.f.node.tip+=300;const out=await w.command('readback');assert.equal(out.result.adopted,false);assert.equal(b(out).state,'broadcast_uncertain');await rejectCancel(w);
}));
test('X6: a mined commitment reorged out keeps issuance non-cancellable',async(t)=>within(t,async w=>{
 await w.issued();w.chain.minedHeight=100;w.chain.roots[w.chain.root]=100;assert.equal(b(await w.command('watch')).state,'mined');w.chain.minedHeight=null;w.chain.roots[w.chain.root]=null;const out=await w.command('watch');assert.equal(b(out).state,'broadcast');await rejectCancel(w);
}));
test('X7: confirmed bound delegate conflict plus root absence restores paid state before cancellation',async(t)=>within(t,async w=>{
 await w.issued();const out=await supersede(w);assert.equal(b(out).state,'superseded');assert.equal((await run(w.store.order(w.tokens[0]))).status,'converted');assert.equal((await cancelled(w)).cancellation,'final');
}));
test('X8: a genuinely published and confirmed fulfilled order cannot be cancelled',async(t)=>within(t,async w=>{
 await w.ready();const out=await w.command('publish');assert.equal(out.error,null);assert.equal((await run(w.store.order(w.tokens[0]))).status,'fulfilled');await rejectCancel(w);assert.equal(out.subs.publishes,1);
}));
test('X9: an issuing order can refund excess while preserving the price reserve',async(t)=>within(t,async w=>{
 w.f.node.outputs[0]={...w.f.node.outputs[0],outpoint:'9'.repeat(64)+':0',sats:13000};w.f.node.outputs.forEach(o=>o.confirmations=6);await w.issued();await run(w.store.setRefundDestination(w.tokens[0],'buyer-refund'));
 const refund=await run(w.store.prepareOperatorRefund('o1','excess','buyer'));assert.equal(refund.charged_sats,3000);await run(w.store.broadcastOperatorRefund(refund.id,refund.txid));assert.equal((await run(w.store.inspectionOrder('o1'))).price_reserve,10000);assert.equal(w.f.sent.length,1);await rejectCancel(w);
}));
test('X10: reversed supersession relocks paid members and records an incident for a cancelled member',async(t)=>{
 for(const cancel of [false,true])await within(t,async w=>{
  await w.issued();await supersede(w);if(cancel)await cancelled(w);w.control.valid=false;w.chain.conflictActive=false;const out=await w.command('watch');assert.equal(b(out).state,'broadcast');assert(out.alerts.some(a=>a.kind==='supersession_reversed'));
  const order=await run(w.store.order(w.tokens[0]));assert.equal(order.status,cancel?'cancelled':'issuing');if(cancel)assert.equal(order.recovery_incident.open,true);else await rejectCancel(w);
  assertError(await w.command('freeze'),/another batch is open/);
 });
});
test('X11: real process death after attempt is uncertain and readback never sends twice',async(t)=>{
 for(const mode of ['crash-before-network','crash-after-network'])await within(t,async w=>{
  await w.prepare();assert.equal((await w.command(mode)).crashed,9);let out=await w.command('status');assert.equal(b(out).state,'broadcast_uncertain');assert.equal(out.journal.filter(e=>e.kind==='batch').at(-1).batch.state,'broadcast_uncertain');await rejectCancel(w);assertError(await w.command('resume'),/uncertain|nothing to resume/);
  out=await w.command('readback');assert.equal(out.result.adopted,mode==='crash-after-network');assert.equal(sent(out),mode==='crash-after-network'?1:0);assert.equal(b(out).state,mode==='crash-after-network'?'broadcast':'broadcast_uncertain');
 });
});
test('L1: below-final or absent commitment withdraws readiness, alerts, cancellation and publication',async(t)=>{
 for(const height of [61,null])await within(t,async w=>{
  await w.ready();await w.command('publish-only');w.chain.minedHeight=height;w.chain.roots[w.chain.root]=height;const out=await w.command('watch');
  assert.equal(b(out).state,height===null?'broadcast':'mined');assert(out.alerts.some(a=>a.kind==='finality_lost'));
  for(const token of w.tokens){assert.equal((await run(w.store.order(token))).status,'issuing');await assert.rejects(run(w.store.cancel(token)),/issuing/);}
  const pub=await w.command('publish');assert(pub.error||pub.result?.calls?.every(c=>c.called===false));assert.equal(pub.subs.publishes,1);const confirmation=await w.command('confirm');assert(confirmation.error||confirmation.result.confirmed===false);
 });
});
test('L2: regained finality and fresh certificate verification resume publication and delivery',async(t)=>within(t,async w=>{
 await w.ready();w.chain.minedHeight=61;w.chain.roots[w.chain.root]=61;await w.command('watch');
 w.chain.minedHeight=50;w.chain.roots[w.chain.root]=50;const cert=await w.command('certify');assert.equal(cert.error,null);assert.equal(b(cert).state,'final');assert.equal((await run(w.store.order(w.tokens[0]))).status,'ready');
 const out=await w.command('publish');assert.equal(out.error,null);assert.equal((await run(w.store.order(w.tokens[0]))).status,'fulfilled');assert.equal(sent(out),1);
}));
test('L3: delivery confirmation refuses an enrolled but unpublished member',async(t)=>within(t,async w=>{
 await w.ready();await w.command('enroll');const out=await w.command('confirm');assert.equal(out.error,null);assert.equal(out.result.confirmed,false);assert.match(out.result.why,/not published/);assert.equal(out.subs.publishes,0);assert.equal((await run(w.store.order(w.tokens[0]))).status,'ready');
}));
test('L4: fulfilled delivery and reserve survive settled supersession with a durable operator incident',async(t)=>within(t,async w=>{
 await w.ready();await w.command('publish');const out=await supersede(w);assert.equal(b(out).state,'superseded');const order=await run(w.store.order(w.tokens[0]));assert.equal(order.status,'fulfilled');assert.equal(order.recovery_incident.open,true);assert.equal(order.refunded_sats,0);assert.equal((await run(w.store.inspectionOrder('o1'))).price_reserve,10000);
 assert((await run(w.store.operatorStatus())).alerts.some(a=>a.order==='o1'&&a.kind==='recovery_incident'));
}));
test('L5: stale fulfilled certificate stays unavailable until reverified and incident resolution changes no money or status',async(t)=>within(t,async w=>{
 await w.ready();await w.command('publish');await supersede(w);const before=await run(w.store.order(w.tokens[0]));assert.equal(before.certificate_available,false);await assert.rejects(run(w.store.certificate(w.tokens[0])),/unavailable/);
 assert.equal((await run(w.store.order(w.tokens[0]))).recovery_incident.open,true);const resolved=await w.command('resolve-incident');assert.equal(resolved.error,null);const after=await run(w.store.order(w.tokens[0]));assert.equal(after.recovery_incident.open,false);
 for(const key of ['status','refunded_sats','reserved_refund_sats','refund_exposure_sats'])assert.equal(after[key],before[key]);assert.equal((await run(w.store.inspectionOrder('o1'))).price_reserve,10000);assert.equal(after.certificate_available,false);
}));
test('L6: final depth with only 138 anchor blocks keeps issuance pending without pausing and allows readiness at 144',async(t)=>within(t,async w=>{
 await w.issued();w.chain.minedHeight=50;w.chain.roots[w.chain.root]=50;w.chain.anchorHeight=188;const out=await w.command('certify');assertError(out,/covered|anchor/);assert.equal(b(out).state,'final');assert.equal((await run(w.store.order(w.tokens[0]))).status,'issuing');assert.equal((await run(w.store.operatorStatus())).paused,false);assert(!out.alerts.some(a=>a.kind==='certificate_failed'||a.kind==='recovery_paused'));
 const pub=await w.command('publish');assert.equal(pub.subs.publishes,0);const conf=await w.command('confirm');assert(conf.error||conf.result.confirmed===false);
 w.chain.anchorHeight=194;const ready=await w.command('certify');assert.equal(ready.error,null);assert.equal((await run(w.store.order(w.tokens[0]))).status,'ready');
}));
test('L7: evicted commitment rebroadcasts only identical journaled bytes after live journal confirmation',async(t)=>within(t,async w=>{
 await w.ready();w.chain.minedHeight=null;w.chain.roots[w.chain.root]=null;w.chain.known=false;w.chain.mempool=false;await w.command('watch');
 writeFileSync(join(w.f.root,'controller-journal','runner.down'),'');const denied=await w.command('rebroadcast');assertError(denied,/acknowledged|journal unavailable/);assert.deepEqual(denied.subs.raw_sends??[],[]);
 await w.command('journal-up');const out=await w.command('rebroadcast');assert.equal(out.error,null);assert.deepEqual(out.subs.raw_sends,['00']);assert.equal(sent(out),1);
 w.chain.minedHeight=50;w.chain.roots[w.chain.root]=50;const final=await w.command('certify');assert.equal(final.error,null);assert.equal(b(final).state,'final');assert.equal((await run(w.store.order(w.tokens[0]))).status,'ready');
}));
test('L8: an evicted uncertain send without captured bytes pauses recovery and keeps cancellation locked',async(t)=>within(t,async w=>{
 await w.prepare();await w.command('lost-answer');w.chain.known=false;w.chain.mempool=false;const out=await w.command('rebroadcast');assertError(out,/no journaled commitment bytes|no known txid/);assert.equal(b(out).recovery_paused,1);assert(out.alerts.some(a=>a.kind==='recovery_paused'));const repeated=await w.command('rebroadcast');assert.equal(repeated.alerts.filter(a=>a.kind==='recovery_paused').length,1);assert.equal(sent(out),1);assert.deepEqual(out.subs.raw_sends??[],[]);await rejectCancel(w);
}));
test('L9: delivery waits for a later relay certificate root to be final and covered without pausing',async(t)=>within(t,async w=>{
 await w.ready();await w.command('publish-only');w.chain.certificateRoot='c'.repeat(64);w.chain.roots[w.chain.certificateRoot]=61;w.chain.latestRoot=w.chain.certificateRoot;w.chain.sovereignty='pending';
 let out=await w.command('confirm');assert.equal(out.error,null);assert.equal(out.result.confirmed,false);assert.equal(out.result.waiting,true);assert.equal((await run(w.store.order(w.tokens[0]))).status,'ready');
 w.f.node.tip=211;w.chain.anchorHeight=199;out=await w.command('confirm');assert.equal(out.error,null);assert.equal(out.result.waiting,true);
 w.chain.anchorHeight=205;w.chain.sovereignty='sovereign';out=await w.command('confirm');assert.equal(out.error,null);assert.equal(out.result.confirmed,true);assert.equal((await run(w.store.order(w.tokens[0]))).status,'fulfilled');assert.equal((await run(w.store.operatorStatus())).paused,false);assert.equal(sent(out),1);
}));
test('J1: TS-owned signed refund family and reservation survive journal-only host loss and are observed before any send',async(t)=>{
 const saved=await within(t,async w=>{
  w.f.node.outputs.forEach(o=>o.confirmations=6);await run(w.store.setRefundDestination(w.tokens[0],'buyer-refund'));await cancelled(w);const group=await run(w.store.prepareOperatorRefund('o1','cancellation','buyer'));
  assert.equal(w.f.sent.length,0);return {f:w.f,group,token:w.tokens[0]};
 });
 const events=[];const observe=saved.f.adapters.refunds.sender.observe;saved.f.adapters.refunds.sender.observe=txs=>{events.push(['observe',txs.map(t=>t.txid)]);return observe(txs);};
 const config={...saved.f.config,database:join(saved.f.root,'restored.db')};await scoped(restoreApplication(config));const report=await scoped(SalesStore.inspectRecovery(config,saved.f.adapters));assert.equal(report.ready,false);assert.equal(report.refunds.built,1);
 const state=await recovered(config);assert.equal(state.state.groups[0].id,saved.group.id);assert.equal(state.state.groups[0].transaction.txid,saved.group.txid);assert.equal(state.state.groups[0].charged,10000);assert(events.some(e=>e[1].includes(saved.group.txid)));assert.equal(saved.f.sent.length,0);
});
test('J2: unacknowledged preparation exports no signed bytes and blocks runner broadcast until acknowledgment',async(t)=>within(t,async w=>{
 w.f.node.outputs.forEach(o=>o.confirmations=6);await run(w.store.setRefundDestination(w.tokens[0],'buyer-refund'));await cancelled(w);w.f.journal.down=true;
 let group=await run(w.store.prepareOperatorRefund('o1','cancellation','buyer'));assert.equal(group.acknowledged,false);assert.equal(group.phase,'reserved');assert.equal(w.f.senderState.builds,0);w.chain.refundGroupId=group.id;w.chain.refundTxid='0'.repeat(64);
 let out=await w.command('refund-broadcast');assertError(out,/acknowledged|changed/);assert.equal(w.f.sent.length,0);
 w.f.journal.down=false;group=await run(w.store.prepareOperatorRefund('o1','cancellation','buyer'));w.chain.refundTxid=group.txid;out=await w.command('refund-broadcast');assert.equal(out.error,null);assert.equal(w.f.sent.length,1);
 const receipt=JSON.stringify(out.result);assert(!receipt.includes('"raw"'));assert(!receipt.includes('"psbt"'));
}));
test('J3: store acknowledgment failure withholds controller intent and send, then retries one bound entry',async(t)=>within(t,async w=>{
 await w.prepare();w.f.journal.down=true;const pending=await w.command('issue');assert.equal(sent(pending),0);assert.equal(b(pending).state,'checkpointed');assert.equal(b(pending).intent,0);assert.equal((await run(w.store.inspectionOrder('o1'))).status,'issuing');assert(!pending.journal.some(e=>e.kind==='batch'&&e.batch.intent));
 w.f.journal.down=false;const out=await w.command('issue');assert.equal(out.error,null);assert.equal(sent(out),1);assert.equal(b(out).state,'broadcast');
}));
test('J4: bound ordering prevents premature durable intent and restored armed uncertainty retains issuance locks',async(t)=>{
 await within(t,async w=>{await w.prepare();w.f.journal.down=true;const out=await w.command('issue');assert.equal(b(out).intent,0);assert(!out.journal.some(e=>e.kind==='batch'&&e.batch.intent));w.f.journal.down=false;});
 const saved=await within(t,async w=>{await w.prepare();assert.equal((await w.command('crash-after-arm')).crashed,9);return {f:w.f,token:w.tokens[0]};});
 const config={...saved.f.config,database:join(saved.f.root,'restored.db')};await scoped(restoreApplication(config));const snapshot=await recovered(config);assert.equal(snapshot.state.orders[0].status,'issuing');assert.equal(snapshot.state.arms.length,1);
 let cancelled=false;await assert.rejects(scoped(Effect.gen(function*(){const store=yield*SalesStore.open(config,saved.f.adapters);yield*store.cancel(saved.token);cancelled=true;})),/controller and chain reconciliation/);assert.equal(cancelled,false);
});
test('J5: a signed local refund attempt without acknowledgment cannot escape through the runner or repeated send',async(t)=>within(t,async w=>{
 w.f.node.outputs.forEach(o=>o.confirmations=6);await run(w.store.setRefundDestination(w.tokens[0],'buyer-refund'));await cancelled(w);
 const build=w.f.adapters.refunds.build;w.f.adapters.refunds.build=request=>build(request).pipe(Effect.tap(()=>Effect.sync(()=>{w.f.journal.down=true;})));
 const group=await run(w.store.prepareOperatorRefund('o1','cancellation','buyer'));assert.equal(group.phase,'built');assert.equal(group.acknowledged,false);w.chain.refundGroupId=group.id;w.chain.refundTxid=group.txid;
 const out=await w.command('refund-broadcast');assertError(out,/not acknowledged/);assert.equal(w.f.sent.length,0);await run(w.store.broadcastOperatorRefund(group.id,group.txid));assert.equal(w.f.sent.length,0);
 w.f.journal.down=false;const sent=await w.command('refund-broadcast');assert.equal(sent.error,null);assert.equal(w.f.sent.length,1);assert.equal(w.f.senderState.builds,1);
}));
test('J6: journal-only store/controller restore acknowledges a lost intent before one send, then rollback refuses',async(t)=>{
 const saved=await within(t,async w=>{await w.prepare();const pending=await w.command('controller-down-after-entry');assert.equal(b(pending).state,'issuing');assert.equal(b(pending).attempted,0);assert.equal(sent(pending),0);assertError(pending,/acknowledged|journal unavailable/);await w.command('journal-up');return w;});
 await restoreBoundary(t,saved,async r=>{assert.equal((await run(r.store.order(saved.tokens[0]))).status,'issuing');const out=await r.command('issue');assert.equal(out.error,null);assert.equal(sent(out),1);assert(out.journal.some(e=>e.kind==='batch'&&e.batch.intent));assertError(await r.command('rollback'),/may have escaped/);});
});
test('J7: late controller journal acknowledgment in the same process resumes once and never sends twice',async(t)=>within(t,async w=>{
 await w.prepare();const out=await w.command('recover-intent-same-process');assert.equal(out.error,null);assert.equal(sent(out),1);assert.equal(b(out).state,'broadcast');assert.equal(out.errors.length,2);assert.match(out.errors[0],/acknowledged|journal unavailable/);assert.match(out.errors[1],/only a batch issuing and never sent resumes/);
}));
test('J8: readiness cannot outrun a durable known transaction and restore withdraws verification pending fresh chain checks',async(t)=>{
 const saved=await within(t,async w=>{
  await w.prepare();await w.command('lost-answer');w.staleJournal=readFileSync(join(w.f.root,'controller-journal','runner.jsonl'),'utf8');const adopted=await w.command('readback');assert.equal(adopted.result.adopted,true);w.chain.minedHeight=50;w.chain.roots[w.chain.root]=50;w.chain.latestRoot=w.chain.root;const ready=await w.command('certify');assert.equal(ready.error,null);
  const certIndex=ready.journal.findIndex(e=>e.kind==='certificate_verification');const knownIndex=ready.journal.findIndex(e=>e.kind==='batch'&&e.batch.txid===w.chain.txid);assert(knownIndex>=0&&knownIndex<certIndex);assert.equal((await run(w.store.order(w.tokens[0]))).status,'ready');return w;
 });
 copyFileSync(join(saved.f.root,'controller-journal','runner.jsonl'),join(saved.f.root,'newer-controller-journal-kept.jsonl'));writeFileSync(join(saved.f.root,'controller-journal','runner.jsonl'),saved.staleJournal);
 await restoreBoundary(t,saved,async r=>{const before=await run(r.store.order(saved.tokens[0]));assert.equal(before.status,'issuing');assert.equal(before.certificate_available,false);assert(r.calls.includes('getrawtransaction'));const out=await r.command('certify');assert.equal(out.error,null);assert.equal(b(out).state,'final');assert.equal((await run(r.store.order(saved.tokens[0]))).status,'ready');assert.equal(sent(out),1);});
});
test('J9: an unsent issuing batch repeats fresh payment checks before rebuilding, retaining paid reservation',async(t)=>{
 await within(t,async w=>{
  await w.prepare();const pending=await w.command('controller-down-after-entry');assert.equal(b(pending).state,'issuing');await w.command('journal-up');w.f.node.outputs[0].confirmations=2;
  const out=await w.command('resume');assert.equal(out.error,null);assert.equal(sent(out),0);assert.equal(b(out).state,'rebuilt');assert.deepEqual(b(out,'b2').members,['o2']);const o=await run(w.store.inspectionOrder('o1'));assert.equal(o.status,'converted');assert.equal(o.price_reserve,10000);assert(o.reasons.includes('issuance'));
 }); const saved=await within(t,async w=>{await w.prepare();await w.command('controller-down-after-entry');await w.command('journal-up');w.f.node.outputs[0].confirmations=2;return w;});
 await restoreBoundary(t,saved,async r=>{const out=await r.command('issue');assert.equal(out.error,null);assert.equal(sent(out),0);assert.equal(b(out).state,'rebuilt');assert.deepEqual(b(out,'b2').members,['o2']);const o=await run(r.store.inspectionOrder('o1'));assert.equal(o.status,'converted');assert.equal(o.price_reserve,10000);assert(o.reasons.includes('issuance'));});
});
test('J10: restored superseded history never leaves an undelivered member ready',async(t)=>{
 const saved=await within(t,async w=>{await w.issued();w.staleJournal=readFileSync(join(w.f.root,'controller-journal','runner.jsonl'),'utf8');w.chain.minedHeight=50;w.chain.roots[w.chain.root]=50;w.chain.latestRoot=w.chain.root;await w.command('certify');const out=await supersede(w);assert.equal(b(out).state,'superseded');return w;});
 const config={...saved.f.config,database:join(saved.f.root,'restored.db')};await scoped(restoreApplication(config));await scoped(SalesStore.inspectRecovery(config,saved.f.adapters));const restored=await recovered(config);assert.equal(restored.state.orders[0].status,'converted');assert.equal(restored.state.supersessions[0].active,true);assert(restored.state.certificates.every(c=>!c.valid));
 const checkpoint=await scoped(Effect.gen(function*(){const storage=yield*DurableStore.open({...config,requireRestore:true});return yield*storage.checkpoint();}));
 writeFileSync(join(saved.f.root,'inventory.json'),JSON.stringify(inventory(restored.state,checkpoint.store,checkpoint.sequence,saved.chain.tipHash)));
 copyFileSync(join(saved.f.root,'controller-journal','runner.jsonl'),join(saved.f.root,'newer-controller-journal-kept.jsonl'));writeFileSync(join(saved.f.root,'controller-journal','runner.jsonl'),saved.staleJournal);
 renameSync(join(saved.f.root,'controller.db'),join(saved.f.root,'controller-before-loss.db'));
 const replay=await saved.command('replay-offline','b1','http://127.0.0.1:9',config.database);assert.equal(replay.error,null);assert.equal(b(replay).state,'superseded');assert.equal(sent(replay),1);assert.equal((await recovered(config)).state.orders[0].status,'converted');
});
