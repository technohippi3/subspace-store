import { open, readFile, type FileHandle } from "node:fs/promises";
import { Effect } from "effect";
import { loadConfiguration } from "./runtime/config.ts";
import { credentials } from "./runtime/credentials.ts";
import { sellerCommand } from "./seller-cli.ts";

const files=new Map<string,FileHandle>();
const intents=new Map<string,{[key:string]:unknown}>();
try{
  if(!process.argv[2])throw Error("configuration required");
  const config=await Effect.runPromise(loadConfiguration(process.argv[2]));
  const token=credentials(config.credentials).operator;
  const result=await sellerCommand(process.argv.slice(3),{
    call:async(method,path,value)=>{
      const credential=await Effect.runPromise(token);
      const response=await fetch(`http://127.0.0.1:${config.listen.operator}${path}`,{method,
        headers:{Authorization:`Bearer ${credential}`,"Content-Type":"application/json"},
        ...(value===undefined?{}:{body:JSON.stringify(value)}),signal:AbortSignal.timeout(15000)});
      const text=await response.text();if(text.length>4_194_304)throw Error("operator receipt too large");
      const receipt:unknown=JSON.parse(text);
      if(!response.ok||!receipt||typeof receipt!=="object"||Array.isArray(receipt))throw Error("operator command refused or unavailable");
      return receipt as {[key:string]:unknown};
    },
    readNomination:async path=>{const bytes=await readFile(path);if(bytes.length>4096)throw Error("nomination too large");
      const raw=new TextDecoder("utf-8",{fatal:true}).decode(bytes);if(raw.includes("\\"))throw Error("escaped nomination");
      const keys=[...raw.matchAll(/"([^"\\]*)"\s*:/g)].map(m=>m[1]);if(new Set(keys).size!==keys.length)throw Error("duplicate nomination field");
      return JSON.parse(raw) as unknown;},
    reserveLink:async(path,intent)=>{
      const file=await open(path,"wx",0o600);files.set(path,file);intents.set(path,intent);
      await file.writeFile(JSON.stringify({request:intent,pending:true})+"\n");await file.sync();
    },
    saveLink:async(path,value)=>{const file=files.get(path);if(!file)throw Error("private output not reserved");
      await file.truncate(0);await file.write(JSON.stringify({request:intents.get(path),...value})+"\n",0,"utf8");await file.sync();},
  });
  process.stdout.write(JSON.stringify(result)+"\n");
}catch{process.stderr.write("seller command failed; inspect arguments, runtime readiness and operator receipts\n");process.exitCode=1;}
finally{for(const file of files.values())await file.close();}
