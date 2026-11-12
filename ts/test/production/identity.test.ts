import { test } from "node:test";
import assert from "node:assert/strict";
import { GENESIS, bindIdentity, descriptorFingerprint, identity } from "../../src/bitcoin/identity.ts";
const descriptors = [{ desc: "tr(mock-public-key/*)#fixture", active: true, range: [0,100], next_index: 3 }];
const original = { version: 1 as const, network: "regtest" as const, genesis: GENESIS.regtest,
  wallet: "merchant", descriptorHash: descriptorFingerprint({descriptors}) };
test("descriptor scan range, next index and reply ordering do not change key identity", () => {
  assert.equal(original.descriptorHash,descriptorFingerprint({descriptors:[{...descriptors[0],range:[0,1000],next_index:99}]}));
  const other = {desc:"tr(other-mock-public-key/*)#fixture"};
  assert.equal(descriptorFingerprint({descriptors:[...descriptors,other]}),descriptorFingerprint({descriptors:[other,...descriptors]}));
  assert.notEqual(original.descriptorHash,descriptorFingerprint({descriptors:[other]}));
});
test("a recorded installation refuses network, wallet and key substitution", () => {
  assert.deepEqual(bindIdentity(original,original,true),original);
  for(const changed of [ {...original,wallet:"other"}, {...original,descriptorHash:"a".repeat(64)},
    {...original,network:"main",genesis:GENESIS.main} ]) assert.throws(()=>bindIdentity(original,changed,true),/identity differs/);
});
test("only the historical regtest network may adopt an unbound used installation",()=>{
  assert.deepEqual(bindIdentity(null,original,true),original);
  const main={...original,network:"main",genesis:GENESIS.main};
  assert.throws(()=>bindIdentity(null,main,true),/identity differs/);
  assert.deepEqual(bindIdentity(null,main,false),main);
});
test("malformed identity and descriptor responses refuse without exposing input",()=>{
  const marker="sensitive-marker";
  for(const value of [{...original,extra:marker},{...original,genesis:"a".repeat(64)},
    {...original,wallet:marker+"/bad"},{...original,descriptorHash:marker},null]) {
    assert.throws(()=>identity(value),error=>error instanceof Error&&!error.message.includes(marker));
  }
  for(const value of [{descriptors:[]},{descriptors:[{desc:marker+"\n"}]},{descriptors:[{},{}]},
    {descriptors:[...descriptors,...descriptors]},{}]) assert.throws(()=>descriptorFingerprint(value));
});
