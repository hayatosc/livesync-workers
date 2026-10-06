import { env, runInDurableObject } from "cloudflare:test";
import { it, expect, afterEach } from "vitest";
import { PersistentVaultDO, type TestEnv } from "./entry.js";
import type { VaultBindings } from "../../packages/livesync-workers/src/types.js";
import { R2Journal, contentPrefix } from "../../packages/livesync-workers/src/storage/r2-journal.js";
import { drainCheckpoint, stopCheckpointAlarms } from "./checkpoint-helpers.js";
const bindings = env as unknown as TestEnv;
const created: DurableObjectStub[] = [];
afterEach(() => stopCheckpointAlarms(created.splice(0)));
const tables = ["docs","revs","rev_metadata","local_docs","changes","rev_body_chunks","meta","index_state"];
async function fixture(name: string, count=300) {
  const object=bindings.VAULT_DB.get(bindings.VAULT_DB.idFromName(`${name}:vault`));
  created.push(object);
  await object.fetch("https://db/",{method:"PUT"});
  const docs=Array.from({length:count},(_,i)=>({_id:`note-${i}`,_rev:"1-original",data:`original ${i}`,path:`${i}.md`,type:"plain"}));
  await object.fetch("https://db/_bulk_docs",{method:"POST",body:JSON.stringify({new_edits:false,docs})});
  return object;
}
async function erase(object: DurableObjectStub) {
  await runInDurableObject(object,async (_instance,state)=>{for(const table of tables) state.storage.sql.exec(`DELETE FROM ${table}`);});
}
it("acknowledges a cadence write with ordinary R2 work and survives cache loss before checkpoint completion",async()=>{
  const object=await fixture("nonblocking-checkpoint",512);
  await runInDurableObject(object,async(instance:PersistentVaultDO,state)=>{
    const mutable=instance as unknown as {bindings():VaultBindings};const original=mutable.bindings.bind(instance);
    let puts=0;const bucket=original().contentBucket!;
    const proxy=new Proxy(bucket,{get(target,key){const value=Reflect.get(target,key);if(typeof value!=="function")return value;return (...args:unknown[])=>{if(key==="put")puts++;return value.apply(target,args);};}});
    mutable.bindings=()=>({...original(),contentBucket:proxy});
    try{
      state.storage.sql.exec("INSERT INTO meta (key,value) VALUES ('monotonic_seq','4095') ON CONFLICT(key) DO UPDATE SET value='4095'");
      expect((await instance.fetch(new Request("https://db/accepted",{method:"PUT",body:'{"data":"durable before checkpoint"}'}))).status).toBe(200);
      expect(puts).toBe(4); // Body, lineage, immutable commit, head CAS; no full snapshot.
      expect(state.storage.sql.exec("SELECT * FROM checkpoint_work").toArray()).toHaveLength(1);
    }finally{mutable.bindings=original;}
  });
  await erase(object);
  expect(await(await object.fetch("https://db/accepted")).json()).toMatchObject({data:"durable before checkpoint"});
});
it("reconciles writes, local checkpoint deletion and binary/deleted/conflict leaves during a rolling snapshot",async()=>{
  const object=await fixture("coherent-rolling");
  const local=await(await object.fetch("https://db/_local/progress",{method:"PUT",body:'{"last_seq":1}'})).json() as {rev:string};
  await object.fetch("https://db/_compact",{method:"POST"});
  await runInDurableObject(object,async(instance:PersistentVaultDO,state)=>{
    // Read enough pages to pass the first rows; changes now require overlays.
    for(let i=0;i<3;i++)await instance.alarm();
    expect(JSON.parse(state.storage.sql.exec<{state:string}>("SELECT state FROM checkpoint_work").one().state).phase).toBe("scan");
  });
  await object.fetch("https://db/note-0",{method:"PUT",body:'{"_rev":"1-original","data":"changed","path":"0.md","type":"plain"}'});
  await object.fetch("https://db/note-1?rev=1-original",{method:"DELETE"});
  await object.fetch("https://db/_bulk_docs",{method:"POST",body:JSON.stringify({new_edits:false,docs:[
    {_id:"note-2",_rev:"2-branchA",_revisions:{start:2,ids:["branchA","original"]},data:"A"},
    {_id:"note-2",_rev:"2-branchB",_revisions:{start:2,ids:["branchB","original"]},data:"B"},
    {_id:"binary",_rev:"1-binary",type:"leaf",data:"AP+A"},
  ]})});
  await runInDurableObject(object,async(instance:PersistentVaultDO,state)=>{
    for(let i=0;i<50;i++){
      const work=JSON.parse(state.storage.sql.exec<{state:string}>("SELECT state FROM checkpoint_work").one().state);
      if(work.phase==="dirty")break;
      await instance.alarm();
    }
    expect(JSON.parse(state.storage.sql.exec<{state:string}>("SELECT state FROM checkpoint_work").one().state).phase).toBe("dirty");
  });
  await object.fetch(`https://db/_local/progress?rev=${local.rev}`,{method:"DELETE"});
  const expected=await(await object.fetch("https://db/_changes?style=all_docs&include_docs=true&revs=true")).json();
  await drainCheckpoint(object);
  await erase(object);
  expect(await(await object.fetch("https://db/_changes?style=all_docs&include_docs=true&revs=true")).json()).toEqual(expected);
  expect((await object.fetch("https://db/_local/progress")).status).toBe(404);
  expect(await(await object.fetch("https://db/binary")).json()).toMatchObject({data:"AP+A"});
});
it("resumes the saved scan cursor across DO reconstruction and protects in-progress pages during GC",async()=>{
  const object=await fixture("resumable-checkpoint");
  await object.fetch("https://db/_compact",{method:"POST"});
  await runInDurableObject(object,async(instance:PersistentVaultDO,state)=>{
    for(let i=0;i<4;i++)await instance.alarm();
    const work=JSON.parse(state.storage.sql.exec<{state:string}>("SELECT state FROM checkpoint_work").one().state);
    expect(work.references.length).toBeGreaterThan(0);
    const journal=new R2Journal(bindings.CONTENT,contentPrefix("resumable-checkpoint","vault"));
    const garbage=await journal.collectGarbage({execute:true,graceMs:-1,roots:[work.references,work.previous]});
    for(const ref of work.references)expect(garbage).not.toContain(ref.r2);
    const fresh=new PersistentVaultDO(state,bindings);
    await fresh.alarm();
    const resumed=JSON.parse(state.storage.sql.exec<{state:string}>("SELECT state FROM checkpoint_work").one().state);
    expect(resumed.table>work.table||resumed.cursor>work.cursor).toBe(true);
  });
  await drainCheckpoint(object);await erase(object);
  expect(await(await object.fetch("https://db/note-200")).json()).toMatchObject({data:"original 200"});
});
it("does not restart a snapshot scan when an immutable page upload is interrupted",async()=>{
  const object=await fixture("scan-interruption",256);await object.fetch("https://db/_compact",{method:"POST"});
  await runInDurableObject(object,async(instance:PersistentVaultDO,state)=>{
    await instance.alarm(); // Compaction completes; start scanning.
    const before=state.storage.sql.exec<{state:string}>("SELECT state FROM checkpoint_work").one().state;
    const mutable=instance as unknown as {bindings():VaultBindings};const original=mutable.bindings.bind(instance);const bucket=original().contentBucket!;
    let failed=false;
    mutable.bindings=()=>({...original(),contentBucket:new Proxy(bucket,{get(target,key){const value=Reflect.get(target,key);if(key!=="put")return typeof value==="function"?value.bind(target):value;return async()=>{failed=true;throw new Error("Injected snapshot page interruption");};}})});
    try{await instance.alarm();}finally{mutable.bindings=original;}
    expect(failed).toBe(true);
    expect(state.storage.sql.exec<{state:string}>("SELECT state FROM checkpoint_work").one().state).toBe(before);
  });
  await drainCheckpoint(object);await erase(object);
  expect((await object.fetch("https://db/note-255")).status).toBe(200);
});
it("keeps concurrent request ordering and optimistic conflicts while bounded maintenance runs",async()=>{
  const object=await fixture("checkpoint-concurrency",256);await object.fetch("https://db/_compact",{method:"POST"});
  const responses=await Promise.all(Array.from({length:12},(_,i)=>object.fetch(`https://db/new-${i}`,{method:"PUT",body:JSON.stringify({data:`writer ${i}`})})));
  expect(responses.every(response=>response.status===200)).toBe(true);
  const conflict=await Promise.all(["A","B"].map(data=>object.fetch("https://db/note-0",{method:"PUT",body:JSON.stringify({_rev:"1-original",data})})));
  expect(conflict.map(response=>response.status).sort()).toEqual([200,409]);
  await drainCheckpoint(object);await erase(object);
  const feed=await(await object.fetch("https://db/_changes")).json() as {results:unknown[];last_seq:number};
  expect(feed.results).toHaveLength(268);expect(feed.last_seq).toBe(269);
});
it("retries explicit R2 head throttling without weakening conditional publication",async()=>{
  const bucket=bindings.CONTENT;let failed=false;
  const proxy=new Proxy(bucket,{get(target,key){const value=Reflect.get(target,key);if(key!=="put")return typeof value==="function"?value.bind(target):value;return async(name:string,...args:unknown[])=>{if(name.endsWith("head.json")&&!failed){failed=true;throw Object.assign(new Error("Injected 429"),{status:429});}return value.apply(target,[name,...args]);};}});
  const journal=new R2Journal(proxy,contentPrefix("throttle","one"));
  const commit=await journal.commit([{sql:"saved",args:[]}],null);
  expect(failed).toBe(true);expect((await journal.head()).commit).toBe(commit);
  const external=new R2Journal(bucket,journal.prefix);const winner=await external.commit([],commit);
  await expect(journal.commit([],commit)).rejects.toThrow("journal changed");
  expect((await external.head()).commit).toBe(winner);
});

it("fences a stale rolling checkpoint if another journal writer advances the head",async()=>{
  const object=await fixture("stale-snapshot",5);await object.fetch("https://db/_compact",{method:"POST"});
  await runInDurableObject(object,async(instance:PersistentVaultDO,state)=>{
    for(let i=0;i<30;i++){
      const work=JSON.parse(state.storage.sql.exec<{state:string}>("SELECT state FROM checkpoint_work").one().state);
      if(work.phase==="dirty")break;await instance.alarm();
    }
    const journal=new R2Journal(bindings.CONTENT,contentPrefix("stale-snapshot","vault"));
    const external=await journal.commit([{sql:"INSERT INTO meta (key,value) VALUES (?,?)",args:["external_probe","preserved"]}],(await journal.head()).commit);
    await instance.alarm(); // CAS must reject the snapshot of the older local state.
    expect((await journal.head()).commit).toBe(external);
    expect(state.storage.sql.exec<{value:string}>("SELECT value FROM meta WHERE key='external_probe'").one().value).toBe("preserved");
  });
  await drainCheckpoint(object);await erase(object);
  await object.fetch("https://db/");
  await runInDurableObject(object,async(_instance,state)=>{expect(state.storage.sql.exec<{value:string}>("SELECT value FROM meta WHERE key='external_probe'").one().value).toBe("preserved");});
});
it("replays ordered overlays after older pages across a catalog boundary",async()=>{
  const journal=new R2Journal(bindings.CONTENT,contentPrefix("ordered-catalog","vault"));
  const base=await journal.putBody(JSON.stringify({statements:[{sql:"base",args:[]}]}));
  const first=await journal.putBody(JSON.stringify({references:Array.from({length:128},()=>({r2:base})),previous:null}));
  const overlay=await journal.putBody(JSON.stringify({statements:[{sql:"overlay-delete",args:[]}]}));
  const root=await journal.putBody(JSON.stringify({ordered:true,references:[{r2:overlay}],previous:{r2:first}}));
  await journal.commit([],null,{r2:root,format:2});
  const replay=[];
  for await(const page of journal.replay((await journal.head()).commit))replay.push(page);
  expect(replay.flatMap(page=>page.statements.map(statement=>statement.sql))).toEqual([...Array(128).fill("base"),"overlay-delete"]);
  expect(replay.filter(page=>page.reset)).toHaveLength(1);
  expect((await journal.history())[0]!.version).toBe(2);
});
