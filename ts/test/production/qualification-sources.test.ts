import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdirSync,mkdtempSync,writeFileSync,symlinkSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {productionSources} from "../../regtest/qualification.ts";
test("qualification hashes the sorted full production source tree and refuses source symlinks",(t)=>{
 const root=mkdtempSync(join(tmpdir(),"qualification-sources-"));t.after(()=>rmSync(root,{recursive:true,force:true}));
 mkdirSync(join(root,"ts/src/runtime/nested"),{recursive:true});
 for(const file of ["runtime/nested/new-backend.ts","runtime/startup.mjs","main.ts","ignored.json"])writeFileSync(join(root,"ts/src",file),"fixture");
 assert.deepEqual(productionSources(root),["ts/src/main.ts","ts/src/runtime/nested/new-backend.ts","ts/src/runtime/startup.mjs"]);
 symlinkSync(join(root,"ts/src/runtime"),join(root,"ts/src/foreign"));assert.throws(()=>productionSources(root),/symlink/);
});
