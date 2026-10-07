import { env } from "cloudflare:test";
import { it,expect } from "vitest";
import { PostingTree,type TreeRef } from "../../packages/livesync-workers/src/search/posting-tree.js";
import { SegmenterFullTextIndex } from "../../packages/livesync-workers/src/search/segmenter-index.js";
import { indexNote,searchWordIndex } from "../../packages/livesync-workers/src/search/segmenter-analysis.js";
import type { FullTextNote } from "../../packages/livesync-workers/src/types.js";
import type { TestEnv } from "./entry.js";
const bucket=(env as unknown as TestEnv).SEARCH;
it("keeps immutable ordered roots correct through splits, overwrites and deletions",async()=>{
 const tree=new PostingTree<number>(bucket,"tree-test/one/");let root:TreeRef|null=null;const expected=new Map<string,number>();
 for(let step=0;step<6;step++){
  const changes=new Map<string,number|null>();
  for(let i=0;i<140;i++){const key=`k${String((i*137+step*31)%501).padStart(4,"0")}`;const value=step>1&&i%3===0?null:step*1000+i;changes.set(key,value);if(value===null)expected.delete(key);else expected.set(key,value);}
  const old=root;const before=[];for await(const entry of tree.range(old))before.push(entry);
  root=await tree.apply(root,changes);const actual=[];for await(const entry of tree.range(root))actual.push(entry);
  expect(actual).toEqual([...expected].map(([key,value])=>({key,value})).sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0));
  const unchanged=[];for await(const entry of tree.range(old))unchanged.push(entry);expect(unchanged).toEqual(before);
  for(const key of ["k0000","k0100","k0500"])expect(await tree.get(root,key)).toBe(expected.get(key)??null);
 }
 await expect(tree.get({r2:"other-vault/page",first:"a",last:"z"},"b")).rejects.toThrow("Cross-vault");
});
it("preserves legacy BM25, AND, phrase positions, field weights and original highlights",async()=>{
 const notes:FullTextNote[]=Array.from({length:40},(_,i)=>({path:`${i%2?"Other":"Projects"}/API_${i}.md`,content:`# 東京 API\n${i%3?"東京 API":"東京 useful API"} 日本語 ＡＰＩ foo_bar Café\u0301 😀 ${i%7?"common":"needle"}`,contentHash:`h${i}`,mtime:null}));
 const index=new SegmenterFullTextIndex(bucket);const ref={tenantId:"equivalent-postings",vaultId:"one",databaseName:"vault"};await index.beginRebuild(ref);const writer=await index.openWriter(ref);for(const note of notes)await writer.upsert(note);await writer.close();await index.completeRebuild(ref);
 for(const query of ["東京 API",'"東京 API"',"foo_bar",'"API API"',"ＣＡＦÉ", "missing", "needle common"]){
  async function* legacy(){for(const note of notes)yield indexNote(note);}
  const expected=await searchWordIndex(legacy(),query,40);const actual=await index.search(ref,query,40);
  expect(actual.docCount).toBe(expected.docCount);expect(actual.hits.map(hit=>hit.path)).toEqual(expected.hits.map(hit=>hit.path));
  for(let i=0;i<actual.hits.length;i++){expect(actual.hits[i]!.score).toBeCloseTo(expected.hits[i]!.score,10);expect(actual.hits[i]!.matchCount).toBe(expected.hits[i]!.matchCount);expect(actual.hits[i]!.snippets).toEqual(expected.hits[i]!.snippets);}
 }
 const filtered=await index.searchWithOptions(ref,"API",5,{acceptPath:path=>path.startsWith("Projects/"),validate:async candidates=>candidates.map(candidate=>candidate.path!=="Projects/API_0.md")});
 expect(filtered.hits).toHaveLength(5);expect(filtered.hits.every(hit=>hit.path.startsWith("Projects/")&&hit.path!=="Projects/API_0.md")).toBe(true);
 expect((await index.search({...ref,tenantId:"other"},"API",5)).hits).toHaveLength(0);
});
it("reads only matching shared pages for rare/missing terms as corpus grows",async()=>{
 for(const size of [64,256]){
  let gets=0,lists=0;const proxy=new Proxy(bucket,{get(target,key){const value=Reflect.get(target,key);if(typeof value!=="function")return value;return (...args:unknown[])=>{if(key==="get")gets++;if(key==="list")lists++;return value.apply(target,args);};}});
  const index=new SegmenterFullTextIndex(proxy);const ref={tenantId:`lookup-${size}`,databaseName:"vault"};await index.beginRebuild(ref);const writer=await index.openWriter(ref);
  for(let i=0;i<size;i++)await writer.upsert({path:`n${String(i).padStart(4,"0")}.md`,content:`東京 API ${i===0?"rare_needle":"common"}`,contentHash:`h${i}`,mtime:null});await writer.close();await index.completeRebuild(ref);
  gets=0;lists=0;expect((await index.search(ref,"rare_needle",10)).hits.map(hit=>hit.path)).toEqual(["n0000.md"]);expect(gets).toBeLessThanOrEqual(12);expect(lists).toBe(0);
  gets=0;expect((await index.search(ref,"zz_unmatched",10)).hits).toHaveLength(0);expect(gets).toBeLessThanOrEqual(8);
 }
},15_000);
it("publishes staged writes atomically and fences concurrent writers without losing the winner",async()=>{
 const index=new SegmenterFullTextIndex(bucket);const ref={tenantId:"posting-cas",databaseName:"vault"};await index.beginRebuild(ref);let writer=await index.openWriter(ref);await writer.upsert({path:"seed.md",content:"東京",contentHash:"seed",mtime:null});await writer.close();await index.completeRebuild(ref);
 const a=await index.openWriter(ref),b=await index.openWriter(ref);await a.upsert({path:"a.md",content:"東京 A",contentHash:"A",mtime:null});await b.upsert({path:"b.md",content:"東京 B",contentHash:"B",mtime:null});
 expect((await index.search(ref,"東京",10)).hits).toHaveLength(1);
 await a.close();await expect(b.close()).rejects.toThrow("Concurrent shared-index");expect((await index.search(ref,"東京",10)).hits.map(hit=>hit.path).sort()).toEqual(["a.md","seed.md"]);
 writer=await index.openWriter(ref);await writer.upsert({path:"b.md",content:"東京 B",contentHash:"B",mtime:null});await writer.close();expect((await index.search(ref,"東京",10)).hits).toHaveLength(3);
 writer=await index.openWriter(ref);await writer.delete("a.md");await writer.close();expect((await index.search(ref,"東京",10)).hits.map(hit=>hit.path).sort()).toEqual(["b.md","seed.md"]);
 const garbage=await index.collectGarbage(ref,{execute:true,graceMs:-1});expect(garbage.length).toBeGreaterThan(0);expect((await index.search(ref,"東京",10)).hits).toHaveLength(2);
});
it("serves the legacy active index while new shared pages rebuild and retains it on failed publication",async()=>{
 const ref={tenantId:"legacy-to-shared",databaseName:"vault"};const prefix="search/ja-segmenter-nfkc-v1/legacy-to-shared/vault/";
 await bucket.put(`${prefix}state.json`,JSON.stringify({active:"legacy",building:null}));await bucket.put(`${prefix}legacy/old.md.json`,JSON.stringify(indexNote({path:"old.md",content:"legacy 東京",contentHash:"old",mtime:null})));
 let fail=true;const proxy=new Proxy(bucket,{get(target,key){const value=Reflect.get(target,key);if(key!=="put")return typeof value==="function"?value.bind(target):value;return async(name:string,...args:unknown[])=>{if(fail&&name.endsWith("manifest.json"))throw new Error("Injected root failure");return value.apply(target,[name,...args]);};}});
 const index=new SegmenterFullTextIndex(proxy);await index.beginRebuild(ref);const writer=await index.openWriter(ref);await writer.upsert({path:"new.md",content:"new 東京",contentHash:"new",mtime:null});await expect(writer.close()).rejects.toThrow("Injected root failure");expect((await index.search(ref,"legacy",10)).hits).toHaveLength(1);
 fail=false;const retry=await index.openWriter(ref);await retry.upsert({path:"new.md",content:"new 東京",contentHash:"new",mtime:null});await retry.close();expect((await index.search(ref,"legacy",10)).hits).toHaveLength(1);await index.completeRebuild(ref);expect((await index.search(ref,"legacy",10)).hits).toHaveLength(0);expect((await index.search(ref,"new",10)).hits).toHaveLength(1);
});
