// Scenarios are called by unconditional, typed Node test entry points.
const cases = new Map();
function test(title, callback) { const id = title.split(':')[0]; if (cases.has(id)) throw Error('duplicate scenario'); cases.set(id, callback); }
export async function runCase(id, context) { const scenario = cases.get(id); if (!scenario) throw Error('unknown scenario'); await scenario(context); }
import {within,assert,run,b,sent,assertError,rejectCancel} from './controller-case-fixture.mjs';
import {use} from './application-fixture.ts';
import {Effect} from 'effect';
async function deficit(w){w.f.node.outputs=w.f.node.outputs.filter(p=>p.script!==w.f.node.outputs[0].script);return run(w.store.order(w.tokens[0]));}
async function alertFor(w,amount){const status=await run(w.store.operatorStatus());assert(status.alerts.some(a=>a.order==='o1'&&a.kind==='post_issuance_deficit'&&a.amount===amount));return status;}
async function noRefund(w){for(const kind of ['cancellation','excess'])await assert.rejects(run(w.store.prepareOperatorRefund('o1',kind,'buyer')));assert.equal(w.f.sent.length,0);}
async function mined(w){await w.issued();w.chain.minedHeight=100;w.chain.roots[w.chain.root]=100;const out=await w.command('watch');assert.equal(b(out).state,'mined');return out;}

test('N7: lost issuance response plus removed payment alerts a post-issuance deficit without unlocking or sending again',async(t)=>within(t,async w=>{
 await w.prepare();const lost=await w.command('lost-answer');assert.equal(b(lost).state,'broadcast_uncertain');const order=await deficit(w);assert.deepEqual(order.reconciling,['post_issuance_deficit']);assert.equal(order.status,'issuing');await alertFor(w,10000);await rejectCancel(w);await noRefund(w);
 const fresh=await run(w.store.request({handle:'n0@space',script_pubkey:'5120'+'3'.padStart(64,'0')}));await assert.rejects(run(w.store.quote(fresh.token)),/taken/);
 const status=await w.command('status');assert.equal(b(status).state,'broadcast_uncertain');assert.equal(sent(status),1);assertError(await w.command('resume'),/only a batch issuing and never sent resumes/);assertError(await w.command('rollback'),/may have escaped/);assert.equal((await run(w.store.inspectionOrder('o1'))).price_reserve,10000);
},2,10000));
test('N8: mined issuance retains its original commitment and members when payment drops below three confirmations',async(t)=>within(t,async w=>{
 const original=await mined(w);w.f.node.outputs[0].confirmations=2;const order=await run(w.store.order(w.tokens[0]));assert.deepEqual(order.reconciling,['post_issuance_deficit']);await alertFor(w,10000);await rejectCancel(w);await noRefund(w);
 const out=await w.command('watch');assert.equal(b(out).state,'mined');assert.equal(b(out).root,b(original).root);assert.deepEqual(b(out).members,['o1','o2']);assert.equal(sent(out),1);assert.equal(out.subs.rollbacks,0);assert.equal(out.subs.commits,1);assert.equal(out.batches.length,1);
},2,10000));
test('N12: a mined payment shortfall grants no automatic replacement or unsafe supersession authority',async(t)=>within(t,async w=>{
 await mined(w);w.f.node.outputs[0].confirmations=2;await run(w.store.order(w.tokens[0]));assertError(await w.command('rollback'),/may have escaped/);assertError(await w.command('freeze'),/another batch is open/);
 const out=await w.command('supersede');assert(out.error);assert.equal(b(out).state,'mined');assert.equal(out.batches.length,1);assert.equal(out.subs.commits,1);assert.equal(out.subs.rollbacks,0);assert.equal(sent(out),1);assert.equal((await run(w.store.order(w.tokens[0]))).status,'issuing');
},2,10000));
test('N9: removal of a fulfilled order payment records the deficit while preserving delivery and buyer ownership',async(t)=>within(t,async w=>{
 await w.ready();await w.command('publish');const order=await deficit(w);assert.equal(order.status,'fulfilled');assert.deepEqual(order.reconciling,['post_issuance_deficit']);await alertFor(w,10000);const current=await run(w.store.inspectionOrder('o1'));assert.equal(current.price_reserve,10000);assert(current.fulfillment);await rejectCancel(w);await noRefund(w);assert.equal((await w.command('status')).subs.rollbacks,0);
},2,10000));
test('N10: a re-mined payment clears the fulfilled post-issuance reason at three confirmations',async(t)=>within(t,async w=>{
 await w.ready();await w.command('publish');const original={...w.f.node.outputs[0]};await deficit(w);w.f.node.outputs.push({...original,confirmations:2});assert((await run(w.store.order(w.tokens[0]))).reconciling.includes('post_issuance_deficit'));w.f.node.outputs.at(-1).confirmations=3;const order=await run(w.store.order(w.tokens[0]));assert.deepEqual(order.reconciling,[]);assert.equal(order.status,'fulfilled');assert.equal((await run(w.store.inspectionOrder('o1'))).price_reserve,10000);
},2,10000));
test('N11: an explicit merchant loss clears the fulfilled deficit reason and remains durable on reopen',async(t)=>{
 const saved=await within(t,async w=>{await w.ready();await w.command('publish');await deficit(w);await run(w.store.recordMerchantLoss('o1','post_issuance_deficit'));const status=await run(w.store.operatorStatus());assert.equal(status.orders.find(o=>o.order==='o1').losses.post_issuance_deficit,10000);assert.deepEqual((await run(w.store.order(w.tokens[0]))).reconciling,[]);return w;},2,10000);
 await use(saved.f,store=>Effect.gen(function*(){const status=yield*store.operatorStatus();assert.equal(status.orders.find(o=>o.order==='o1').losses.post_issuance_deficit,10000);assert.equal((yield*store.order(saved.tokens[0])).status,'fulfilled');assert.deepEqual((yield*store.order(saved.tokens[0])).reconciling,[]);}));
});
test('N13: recorded 8000 loss suppresses repeats and a later 2000 shortfall raises only the new difference',async(t)=>within(t,async w=>{
 const source=w.f.node.outputs[0],small={...source,outpoint:'9'.repeat(64)+':0',sats:2000},large={...source,outpoint:'8'.repeat(64)+':0',sats:8000};w.f.node.outputs=[small,large,...w.f.node.outputs.slice(1)];await w.ready();await w.command('publish');
 w.f.node.outputs=w.f.node.outputs.filter(p=>p.outpoint!==large.outpoint);await run(w.store.order(w.tokens[0]));await alertFor(w,8000);await run(w.store.recordMerchantLoss('o1','post_issuance_deficit'));const before=(await run(w.store.operatorStatus())).alerts.length;
 for(let i=0;i<2;i++){w.f.node.tip++;assert.deepEqual((await run(w.store.order(w.tokens[0]))).reconciling,[]);}assert.equal((await run(w.store.operatorStatus())).alerts.length,before);
 w.f.node.outputs=w.f.node.outputs.filter(p=>p.outpoint!==small.outpoint);const order=await run(w.store.order(w.tokens[0]));assert.equal(order.status,'fulfilled');assert.deepEqual(order.reconciling,['post_issuance_deficit']);const status=await run(w.store.operatorStatus());assert.equal(status.alerts.at(-1).amount,2000);assert.equal(status.alerts.at(-1).kind,'post_issuance_deficit');assert.equal(status.orders.find(o=>o.order==='o1').losses.post_issuance_deficit,8000);assert.equal((await run(w.store.inspectionOrder('o1'))).price_reserve,10000);
},2,10000));
