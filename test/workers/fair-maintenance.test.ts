import { env,runInDurableObject } from "cloudflare:test";
import { it,expect,afterEach } from "vitest";
import type { PersistentVaultDO,TestEnv } from "./entry.js";
import type { VaultBindings } from "../../packages/livesync-workers/src/types.js";
import { SegmenterFullTextIndex } from "../../packages/livesync-workers/src/search/segmenter-index.js";
import { R2Journal,contentPrefix } from "../../packages/livesync-workers/src/storage/r2-journal.js";
import { stopCheckpointAlarms } from "./checkpoint-helpers.js";
const bindings=env as unknown as TestEnv;const created:DurableObjectStub[]=[];afterEach(()=>stopCheckpointAlarms(created.splice(0)));
async function fixture(name:string,count=1){const stub=bindings.VAULT_DB.get(bindings.VAULT_DB.idFromName(`${name}:vault`));created.push(stub);await runInDurableObject(stub,async(instance:PersistentVaultDO,state)=>{(instance as unknown as {scheduleIndexing():Promise<void>}).scheduleIndexing=async()=>{};await state.storage.deleteAlarm();});await stub.fetch("https://db/",{method:"PUT"});if(count)await stub.fetch("https://db/_bulk_docs",{method:"POST",body:JSON.stringify({new_edits:false,docs:Array.from({length:count},(_,i)=>({_id:`n-${i}`,_rev:"1-fixed",path:`n-${i}.md`,type:"plain",data:"東京 API"}))})});return stub;}
it("coalesces body/history PUT and GET while preserving lineage, journal fencing and full restore",async()=>{
 const stub=await fixture("coalesced-revision",0);
 await runInDurableObject(stub,async(instance:PersistentVaultDO,state)=>{
  const mutable=instance as unknown as {bindings():VaultBindings};const original=mutable.bindings.bind(instance);const bucket=original().contentBucket!;let puts=0,gets=0;
  const proxy=new Proxy(bucket,{get(target,key){const value=Reflect.get(target,key);if(typeof value!=="function")return value;return(...args:unknown[])=>{if(key==="put")puts++;if(key==="get")gets++;return value.apply(target,args);};}});mutable.bindings=()=>({...original(),contentBucket:proxy});
  try{
   expect((await instance.fetch(new Request("https://db/_bulk_docs",{method:"POST",body:JSON.stringify({new_edits:false,docs:Array.from({length:10},(_,i)=>({_id:`doc-${i}`,_rev:"2-fixed",_revisions:{start:2,ids:["fixed","parent"]},data:"saved"}))})}))).status).toBe(200);expect(puts).toBe(12);
   const row=state.storage.sql.exec<{body:string;rev_history:string}>("SELECT body,rev_history FROM revs WHERE id='doc-0' AND rev='2-fixed'").one();expect(JSON.parse(row.body).r2).toBe(JSON.parse(row.rev_history).r2);expect(JSON.parse(row.body).part).toBe("body");expect(JSON.parse(row.rev_history).part).toBe("history");
   gets=0;expect(await(await instance.fetch(new Request("https://db/doc-0?revs=true"))).json()).toMatchObject({data:"saved",_revisions:{start:2,ids:["fixed","parent"]}});expect(gets).toBe(2);
   expect(state.storage.sql.exec("SELECT * FROM meta WHERE key='r2_applied_head'").toArray()).toHaveLength(0);
   for(const table of ["docs","revs","rev_metadata","local_docs","changes","rev_body_chunks","meta","index_state"])state.storage.sql.exec(`DELETE FROM ${table}`);
   expect(await(await instance.fetch(new Request("https://db/doc-0?revs=true"))).json()).toMatchObject({data:"saved",_revisions:{start:2,ids:["fixed","parent"]}});
  }finally{mutable.bindings=original;}
 });
 expect((await new R2Journal(bindings.CONTENT,contentPrefix("coalesced-revision","vault")).history()).at(-1)!.version).toBe(3);
});
it("makes indexing progress before a rolling checkpoint completes and finishes both jobs",async()=>{
 const stub=await fixture("fair-checkpoint",128);await stub.fetch("https://db/_compact",{method:"POST"});
 await runInDurableObject(stub,async(instance:PersistentVaultDO,state)=>{
  await instance.alarm();expect(state.storage.sql.exec("SELECT * FROM checkpoint_work").toArray()).toHaveLength(1);
  await instance.alarm();expect(state.storage.sql.exec<{n:number}>("SELECT COUNT(*) AS n FROM index_state WHERE fts_hash IS NOT NULL").one().n).toBeGreaterThan(0);expect(state.storage.sql.exec("SELECT * FROM checkpoint_work").toArray()).toHaveLength(1);
  let finished=false;for(let i=0;i<250;i++){await instance.alarm();if(!state.storage.sql.exec("SELECT * FROM checkpoint_work").toArray().length&&state.storage.sql.exec<{n:number}>("SELECT COUNT(*) AS n FROM index_state WHERE fts_hash IS NOT NULL AND pending=0").one().n===128){finished=true;break;}}expect(finished).toBe(true);
 });
 expect((await new SegmenterFullTextIndex(bindings.SEARCH).search({tenantId:"fair-checkpoint",databaseName:"vault"},"東京",5)).hits).toHaveLength(5);
},15_000);
it("retries failed writer publication instead of marking staged paths as indexed",async()=>{
 const stub=await fixture("index-close-failure");
 await runInDurableObject(stub,async(instance:PersistentVaultDO,state)=>{
  const mutable=instance as unknown as {bindings():VaultBindings};const original=mutable.bindings.bind(instance);let fail=true;
  const bucket=new Proxy(bindings.SEARCH,{get(target,key){const value=Reflect.get(target,key);if(key!=="put")return typeof value==="function"?value.bind(target):value;return async(name:string,...args:unknown[])=>{if(fail&&name.endsWith("manifest.json"))throw new Error("Injected close failure");return value.apply(target,[name,...args]);};}});
  mutable.bindings=()=>({...original(),fullText:new SegmenterFullTextIndex(bucket)});
  try{await instance.alarm();expect(state.storage.sql.exec<{pending:number;fts_hash:string|null}>("SELECT pending,fts_hash FROM index_state WHERE path='n-0.md'").one()).toMatchObject({pending:1,fts_hash:null});fail=false;await instance.alarm();expect(state.storage.sql.exec<{pending:number;fts_hash:string|null}>("SELECT pending,fts_hash FROM index_state WHERE path='n-0.md'").one()).toMatchObject({pending:0});expect(state.storage.sql.exec<{fts_hash:string}>("SELECT fts_hash FROM index_state WHERE path='n-0.md'").one().fts_hash).toBeTruthy();}finally{mutable.bindings=original;}
 });
 expect((await new SegmenterFullTextIndex(bindings.SEARCH).search({tenantId:"index-close-failure",databaseName:"vault"},"東京",5)).hits).toHaveLength(1);
});
it("does not let repeated checkpoint page failures starve indexing",async()=>{
 const stub=await fixture("fair-failure",8);await stub.fetch("https://db/_compact",{method:"POST"});
 await runInDurableObject(stub,async(instance:PersistentVaultDO,state)=>{
  await instance.alarm();const mutable=instance as unknown as {bindings():VaultBindings};const original=mutable.bindings.bind(instance);const target=original().contentBucket!;let fail=true;
  const proxy=new Proxy(target,{get(bucket,key){const value=Reflect.get(bucket,key);if(key!=="put")return typeof value==="function"?value.bind(bucket):value;return async(name:string,payload:unknown,...args:unknown[])=>{if(fail&&String(payload).startsWith('{"statements":'))throw new Error("Injected checkpoint failure");return value.apply(bucket,[name,payload,...args]);};}});mutable.bindings=()=>({...original(),contentBucket:proxy});
  try{for(let i=0;i<4;i++)await instance.alarm();expect(state.storage.sql.exec<{n:number}>("SELECT COUNT(*) AS n FROM index_state WHERE fts_hash IS NOT NULL").one().n).toBe(8);expect(state.storage.sql.exec("SELECT * FROM checkpoint_work").toArray()).toHaveLength(1);fail=false;for(let i=0;i<100&&state.storage.sql.exec("SELECT * FROM checkpoint_work").toArray().length;i++)await instance.alarm();expect(state.storage.sql.exec("SELECT * FROM checkpoint_work").toArray()).toHaveLength(0);}finally{mutable.bindings=original;}
 });
});
it("sweeps exhausted missing-chunk retries across multiple bounded passes after chunk arrival",async()=>{
 const stub=await fixture("pending-chunk-sweep",0);
 await stub.fetch("https://db/_bulk_docs",{method:"POST",body:JSON.stringify({new_edits:false,docs:Array.from({length:40},(_,i)=>({_id:`missing-${i}`,_rev:"1-fixed",path:`pending-${String(i).padStart(3,"0")}.md`,type:"plain",children:["h:late"]}))})});
 await runInDurableObject(stub,async(instance:PersistentVaultDO,state)=>{for(let i=0;i<8;i++)await instance.alarm();expect(state.storage.sql.exec<{n:number}>("SELECT COUNT(*) AS n FROM index_state WHERE pending=1").one().n).toBe(40);state.storage.sql.exec("UPDATE index_state SET attempts=20 WHERE pending=1");});
 await stub.fetch("https://db/_bulk_docs",{method:"POST",body:JSON.stringify({new_edits:false,docs:[{_id:"h:late",_rev:"1-fixed",type:"leaf",data:"東京 API"}]})});
 await runInDurableObject(stub,async(instance:PersistentVaultDO,state)=>{
  const mutable=instance as unknown as {hydrateRevision(row:unknown):Promise<unknown>};
  const original=mutable.hydrateRevision.bind(instance);
  // Force the real 50 ms boundary independently of machine speed. Deferred
  // exhausted notes retain their attempts; they must resume via the cursor.
  mutable.hydrateRevision=async row=>{await new Promise(resolve=>setTimeout(resolve,55));return original(row);};
  try {
   await instance.alarm();
   expect(state.storage.sql.exec<{n:number}>("SELECT COUNT(*) AS n FROM index_state WHERE pending=1 AND attempts=20").one().n).toBeGreaterThan(0);
   expect(state.storage.sql.exec("SELECT * FROM meta WHERE key='index_chunk_sweep'").toArray()).toHaveLength(1);
   let ready=0;for(let i=0;i<40;i++){await instance.alarm();ready=state.storage.sql.exec<{n:number}>("SELECT COUNT(*) AS n FROM index_state WHERE pending=0 AND fts_hash IS NOT NULL").one().n;if(ready===40)break;}expect(ready).toBe(40);
  } finally {mutable.hydrateRevision=original;}
 });
},15_000);
