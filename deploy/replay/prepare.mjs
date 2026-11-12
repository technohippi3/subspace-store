import { mkdirSync, writeFileSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, createECDH } from 'node:crypto';
import { decode, encode } from './src/application/records.ts';
import { createRequested } from './src/application/seller-records.ts';
import { refresh, grant, release } from './src/application/sales.ts';
import { configuration } from './src/refunds/book.ts';
import { entry } from './src/storage/codec.ts';
import { refundPolicy } from './test/production/application-fixture.ts';
import { pathToFileURL } from 'node:url';
const {MAX_PLAIN,RecoveryClient,sha}=await import(pathToFileURL(process.env.SUBSPACE_PACKAGE_CLIENT_DIRECTORY+'/transport.mjs').href);
import { readFileSync } from 'node:fs';

const [configFile, root] = process.argv.slice(2);
const client = new RecoveryClient(JSON.parse(readFileSync(configFile)));
mkdirSync(root, {mode:0o700}); for (const dir of ['store','blobs']) mkdirSync(join(root,dir),{mode:0o700});
const durable = (path, bytes) => { const fd=openSync(path,'wx',0o600); try {writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);} };
const state = decode([], 1_000_000, configuration({version:1,policy:refundPolicy,merchantDestinations:[]}));
state.settings.lastTime=200000; state.settings.tip=100; state.settings.paused=false;
state.seller.configured=true; state.seller.limits={windowSeconds:3600,maximumRequests:10000,maximumOrders:10000};
state.spaces=[{version:1,space:'space',paused:false,catalog:'listed'}];
state.listings=Array.from({length:10000},(_,i)=>({handle:`n${i}@space`,space:'space',price:1000}));
let sequence=0, previous=null, totalBytes=0, maximum=0;
function append(changes) {
  const value=entry('12345678-1234-4234-8234-123456789abc',++sequence,previous,changes);previous=value.hash;
  const raw=Buffer.from(JSON.stringify(value)); totalBytes+=raw.length; maximum=Math.max(maximum,raw.length);
  let encrypted;
  if(raw.length+3<=MAX_PLAIN) encrypted=client.encrypt(Buffer.concat([Buffer.from('J1\0'),raw]),`journal:store:${sequence}`);
  else {
    const chunks=[];
    for(let offset=0;offset<raw.length;offset+=MAX_PLAIN){
      const cipher=client.encrypt(raw.subarray(offset,offset+MAX_PLAIN),`journal-chunk:store:${sequence}:${chunks.length}`);
      const hash=sha(cipher); durable(join(root,'blobs',hash),cipher); chunks.push(hash);
    }
    encrypted=client.encrypt(Buffer.concat([Buffer.from('J2\0'),Buffer.from(JSON.stringify({size:raw.length,sha256:sha(raw),chunks}))]),`journal:store:${sequence}`);
  }
  durable(join(root,'store',String(sequence).padStart(16,'0')+'.json'),encrypted);
}
const global=encode(state); append(global);
for(let i=0;i<10000;i++){
  const curve=createECDH('secp256k1');curve.setPrivateKey(Buffer.from((i+1).toString(16).padStart(64,'0'),'hex'));
  const order=createRequested(state,{handle:`n${i}@space`,script:'5120'+curve.getPublicKey(undefined,'compressed').subarray(1).toString('hex')},
    createHash('sha256').update('fixture-token-'+i).digest('hex'),200000);
  const row=()=>({kind:'sales_order',key:order.id,value:structuredClone(order)});
  append([row(),{kind:'refund_account',key:order.id,value:state.accounts.at(-1)}]);
  if(i<8000){
    order.status='quoted'; order.quotedAt=i<5?199999:1000+i; order.quotedPrice=order.price=1000;
    order.destination={address:'historical-fixture-'+i,script:'0014'+(i+1).toString(16).padStart(40,'0')};
    state.accounts.at(-1).ceiling=refundPolicy.buyerFeeCeiling;
    state.settings.lastTime=order.quotedAt; grant(state,order); state.settings.lastTime=200000;
    append([row(),{kind:'refund_account',key:order.id,value:state.accounts.at(-1)}]);
    if(i>=2000){order.status='cancelled';release(order);append([row()]);}
  }
}
refresh(state,200000,{tip:100,outputs:state.orders.slice(0,5).map((o,i)=>({outpoint:'fixture-output-'+i,script:o.destination.script,sats:1000,confirmations:3}))});
const final=encode(state);
decode(final,1_000_000,configuration({version:1,policy:refundPolicy,merchantDestinations:[]}));
// Persist final settings and the small set changed by the live payment reducer.
append(final.filter(r=>['sales_settings','seller_settings','payment'].includes(r.kind) ||
  r.kind==='sales_order' && Number(r.key.slice(1))<=2000));
for(const dir of ['store','blobs','']){const fd=openSync(join(root,dir),'r');try{fsyncSync(fd);}finally{closeSync(fd);}}
console.log(JSON.stringify({orders:10000,invoices:8000,cancelled:6000,unpaid:1995,converted:5,entries:sequence,plaintextBytes:totalBytes,largestEntry:maximum,sourceCommit:process.env.SUBSPACE_PACKAGE_SOURCE_COMMIT??'working-tree'}));
