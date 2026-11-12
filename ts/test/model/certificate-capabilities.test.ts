import {test} from "node:test";
import assert from "node:assert/strict";
import {initial,stageIssue,stageRevoke,stageExpiry,acknowledge,hostLoss,read,type Grant} from "../../model/certificate-capabilities.ts";
const grant:Grant={hash:"h1",order:"o1",revision:"entry1-revision1",format:"spacecert-v1",artifact:"native-hash1",expires:1060,revoked:false};
function ready(){const m=initial();m.ready.o1=grant.revision;return m;}
test("O161: capability model grants exactly one artifact profile and no order authority",()=>{const m=acknowledge(stageIssue(ready(),grant,1000));assert.equal(read(m,"h1","spacecert-v1",1000).artifact,"native-hash1");assert.throws(()=>read(m,"h1","spacemsg-0.4.4",1000));assert.throws(()=>read(m,"order-token","spacecert-v1",1000));});
test("O162: capability model expires exactly at deadline and rotation permanently replaces a slot",()=>{let m=acknowledge(stageIssue(ready(),grant,1000));assert.throws(()=>read(m,"h1","spacecert-v1",1060));assert.throws(()=>read(m,"h1","spacecert-v1",999));m=acknowledge(stageIssue(m,{...grant,hash:"h2"},1000));assert.equal(m.durable.grants.length,1);assert.throws(()=>read(m,"h1","spacecert-v1",1000));assert.equal(read(m,"h2","spacecert-v1",1000).hash,"h2");});
test("O163: capability model requires exact current certificate revision on every read",()=>{let m=acknowledge(stageIssue(ready(),grant,1000));m.ready.o1=undefined;assert.throws(()=>read(m,"h1","spacecert-v1",1000));m.ready.o1="entry1-revision3";assert.throws(()=>read(m,"h1","spacecert-v1",1000));});
test("O172: capability model refuses publication when certificate readiness changed before issue",()=>{const m=ready();m.ready.o1="entry1-revision2";assert.throws(()=>stageIssue(m,grant,1000));});
test("O173: capability model never acknowledges unavailable or pending journal mutations",()=>{let m=acknowledge(stageIssue(ready(),grant,1000));m=stageRevoke(m,"h1");m.available=false;assert.throws(()=>acknowledge(m));assert.throws(()=>read(m,"h1","spacecert-v1",1000));});
test("O174: capability model replays acknowledged revocation after host loss",()=>{let m=acknowledge(stageIssue(ready(),grant,1000));m=acknowledge(stageRevoke(m,"h1"));m=hostLoss(m);assert.equal(m.durable.grants[0]!.revoked,true);assert.throws(()=>read(m,"h1","spacecert-v1",1000));});
test("O179: invalid capability reads cannot change the model journal or clock",()=>{let m=acknowledge(stageIssue(ready(),grant,1000));for(const hash of ["unknown","h1"]){const before=JSON.stringify(m);assert.throws(()=>read(m,hash,"spacecert-v1",1060));assert.equal(JSON.stringify(m),before);}m=acknowledge(stageRevoke(m,"h1"));const before=JSON.stringify(m);assert.throws(()=>read(m,"h1","spacecert-v1",1001));assert.equal(JSON.stringify(m),before);});

test("O162: observed expiry is durably retired before a backward step or host loss", () => {
 let m = acknowledge(stageIssue(ready(), grant, 1000));
 m = stageExpiry(m, "h1", 1060); assert.throws(() => read(m, "h1", "spacecert-v1", 1059));
 m = hostLoss(acknowledge(m)); assert.equal(m.durable.now, 1060); assert.equal(m.durable.grants[0]!.revoked, true);
 assert.throws(() => read(m, "h1", "spacecert-v1", 1059)); assert.throws(() => read(m, "h1", "spacecert-v1", 1061));
});
