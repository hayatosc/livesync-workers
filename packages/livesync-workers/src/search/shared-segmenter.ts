import type { FullTextIndex, FullTextNote, FullTextSearchHit, FullTextSearchOptions, VaultRef } from "../types.js";
import { SEGMENTER_ANALYZER,indexNote,queryPhrases,occurrences,weights,type Field,type FieldName,type IndexedNote } from "./segmenter-analysis.js";
import { PostingTree,type TreeRef,type Entry } from "./posting-tree.js";
type Positions=Field["postings"][string];
type DocumentState={hash:string;r2:string;lengths:number[];terms:string[];updatedAt:number};
type Posting=Omit<DocumentState,"terms">&{path:string;positions:Partial<Record<FieldName,Positions>>};
type Manifest={format:2;documents:TreeRef|null;postings:TreeRef|null;docCount:number;totalLengths:number[];builtAt:number;delta?:{documents:Entry<DocumentState|null>[];postings:Entry<Posting|null>[]}};
type State={active:string|null;building:string|null;activeFormat?:2;buildingFormat?:2};
type Candidate={path:string;hash:string;r2:string;score:number;matchCount:number;matches:Array<Array<Array<{start:number;end:number}>>>};
const fields=Object.keys(weights) as FieldName[];
const encode=new TextEncoder();
const compare=(a:Pick<Candidate,"score"|"path">,b:Pick<Candidate,"score"|"path">)=>b.score-a.score||a.path.localeCompare(b.path);
const empty=():Manifest=>({format:2,documents:null,postings:null,docCount:0,totalLengths:fields.map(()=>0),builtAt:0});
/** Shared term/path pages and bounded ranking. SQLite remains the content coordinator. */
export class SharedSegmenterIndex implements FullTextIndex {
 readonly sourceHashes=true;
 constructor(private readonly bucket:R2Bucket,private readonly legacy:(prefix:string,query:string,limit:number)=>ReturnType<FullTextIndex["search"]>){}
 private prefix(ref:VaultRef){return `search/${SEGMENTER_ANALYZER}/${encodeURIComponent(ref.tenantId)}/${encodeURIComponent(ref.vaultId??ref.databaseName)}/`;}
 private async state(ref:VaultRef){const key=`${this.prefix(ref)}state.json`;const object=await this.bucket.get(key);return {key,etag:object?.etag,state:object?await object.json<State>():{active:null,building:null} as State};}
 private async publish(key:string,value:unknown,etag?:string){
  const body=JSON.stringify(value);
  for(let attempt=0;;attempt++){
   try{
    const saved=await this.bucket.put(key,body,{onlyIf:etag?{etagMatches:etag}:{etagDoesNotMatch:"*"}});
    if(saved)return saved.etag;
    const actual=await this.bucket.get(key);if(actual&&await actual.text()===body)return actual.etag;
    throw new Error("Concurrent shared-index publication; retry indexing");
   }catch(error){
    const status=(error as {status?:number;statusCode?:number}).status??(error as {statusCode?:number}).statusCode;
    if(attempt>=3||!(status===429||status===503||/\b(?:429|503)\b|TooManyRequests|SlowDown/i.test(String(error))))throw error;
    await new Promise(resolve=>setTimeout(resolve,250*2**attempt));
   }
  }
 }
 async beginRebuild(ref:VaultRef){const saved=await this.state(ref);if(saved.state.building&&saved.state.buildingFormat===2)return false;await this.publish(saved.key,{...saved.state,building:crypto.randomUUID(),buildingFormat:2},saved.etag);return true;}
 async completeRebuild(ref:VaultRef){const saved=await this.state(ref);const state=saved.state;if(!state.building||state.buildingFormat!==2)return;const manifest=await this.bucket.get(`${this.prefix(ref)}${state.building}/manifest.json`);if(!manifest)await this.publish(`${this.prefix(ref)}${state.building}/manifest.json`,empty());await this.publish(saved.key,{active:state.building,activeFormat:2,building:null},saved.etag);}
 async openWriter(ref:VaultRef){
  let saved=await this.state(ref);
  if(!(saved.state.building&&saved.state.buildingFormat===2)&&saved.state.activeFormat!==2){await this.beginRebuild(ref);saved=await this.state(ref);}
  const generation=saved.state.building??saved.state.active!;const prefix=`${this.prefix(ref)}${generation}/`;const key=`${prefix}manifest.json`;
  const object=await this.bucket.get(key);let manifest=object?await object.json<Manifest>():empty();let etag=object?.etag;
  const documents=new PostingTree<DocumentState>(this.bucket,`${prefix}pages/`);const postings=new PostingTree<Posting>(this.bucket,`${prefix}pages/`);
  let documentChanges=new Map<string,DocumentState|null>();let postingChanges=new Map<string,Posting|null>();let pendingBytes=0;
  let failure:unknown;let closed=false;
  const flush=async()=>{
   if(failure)throw failure;if(!documentChanges.size)return;
   try{
    const mergedDocuments=new Map((manifest.delta?.documents??[]).map(entry=>[entry.key,entry.value]));
    const mergedPostings=new Map((manifest.delta?.postings??[]).map(entry=>[entry.key,entry.value]));
    for(const [key,value] of documentChanges)mergedDocuments.set(key,value);
    for(const [key,value] of postingChanges)mergedPostings.set(key,value);
    const delta={documents:[...mergedDocuments].map(([key,value])=>({key,value})),postings:[...mergedPostings].map(([key,value])=>({key,value}))};
    let next:Manifest={...manifest,delta};
    // Tiny saves update only the bounded manifest delta; merge into shared pages
    // after32 distinct paths or256 KiB instead of rewriting the tree per note.
    if(mergedDocuments.size>=32||encode.encode(JSON.stringify(delta)).byteLength>256*1024){
     const settled=await Promise.allSettled([documents.apply(manifest.documents,mergedDocuments),postings.apply(manifest.postings,mergedPostings)]);
     for(const value of settled)if(value.status==="rejected")throw value.reason;
     next={...manifest,documents:(settled[0] as PromiseFulfilledResult<TreeRef|null>).value,postings:(settled[1] as PromiseFulfilledResult<TreeRef|null>).value,delta:{documents:[],postings:[]}};
    }
    etag=await this.publish(key,next,etag);manifest=next;documentChanges=new Map();postingChanges=new Map();pendingBytes=0;
   }catch(error){failure=error;throw error;}
  };
  const previous=async(path:string)=>{
   if(documentChanges.has(path))return documentChanges.get(path)!;
   const delta=manifest.delta?.documents.find(entry=>entry.key===path);return delta?delta.value:documents.get(manifest.documents,path);
  };
  const remove=(path:string,old:DocumentState|null)=>{
   if(!old)return;for(const term of old.terms)postingChanges.set(`${term}\0${path}`,null);
   manifest.docCount--;old.lengths.forEach((length,f)=>manifest.totalLengths[f]=manifest.totalLengths[f]!-length);
  };
  const guard=()=>{if(closed)throw new Error("Index writer is closed");if(failure)throw failure;};
  return {
   upsert:async(note:FullTextNote)=>{
    guard();let old=await previous(note.path);if(old?.hash===note.contentHash)return;
    const indexed=indexNote(note);const terms=[...new Set(fields.flatMap(name=>Object.keys(indexed.fields[name].postings)))];
    const size=encode.encode(JSON.stringify(indexed)).byteLength;
    if(pendingBytes&&pendingBytes+size>1024*1024){await flush();old=await previous(note.path);}
    const r2=`${prefix}notes/${crypto.randomUUID()}.json`;
    const stored={path:note.path,fields:Object.fromEntries(fields.map(name=>[name,{text:indexed.fields[name].text,length:indexed.fields[name].length}]))};
    try{await this.bucket.put(r2,JSON.stringify(stored),{onlyIf:{etagDoesNotMatch:"*"}});}catch(error){failure=error;throw error;}
    remove(note.path,old??null);
    const current:DocumentState={hash:note.contentHash,r2,lengths:fields.map(name=>indexed.fields[name].length),terms,updatedAt:indexed.updatedAt};
    manifest.docCount++;current.lengths.forEach((length,f)=>manifest.totalLengths[f]=manifest.totalLengths[f]!+length);manifest.builtAt=Math.max(manifest.builtAt,current.updatedAt);
    documentChanges.set(note.path,current);
    for(const term of terms)postingChanges.set(`${term}\0${note.path}`,{path:note.path,hash:current.hash,r2,lengths:current.lengths,updatedAt:current.updatedAt,positions:Object.fromEntries(fields.filter(name=>indexed.fields[name].postings[term]).map(name=>[name,indexed.fields[name].postings[term]!]))});
    pendingBytes+=size;if(documentChanges.size>=32)await flush();
   },
   delete:async(path:string)=>{guard();const old=await previous(path);remove(path,old??null);documentChanges.set(path,null);pendingBytes+=old?encode.encode(JSON.stringify(old)).byteLength:0;if(documentChanges.size>=32||pendingBytes>=1024*1024)await flush();},
   close:async()=>{guard();await flush();closed=true;},
  };
 }
 private async *postingRange(tree:PostingTree<Posting>,manifest:Manifest,term:string):AsyncGenerator<Entry<Posting>>{
  const start=`${term}\0`,end=`${term}\u0001`;
  const delta=(manifest.delta?.postings??[]).filter(entry=>entry.key>=start&&entry.key<end).sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0);
  const stream=tree.range(manifest.postings,start,end);let base=await stream.next();let offset=0;
  while(!base.done||offset<delta.length){
   const changed=delta[offset];
   if(changed&&(base.done||changed.key<=base.value.key)){
    if(!base.done&&changed.key===base.value.key)base=await stream.next();
    if(changed.value!==null)yield {key:changed.key,value:changed.value};offset++;
   }else if(!base.done){yield base.value;base=await stream.next();}
  }
 }
 private async *matches(tree:PostingTree<Posting>,manifest:Manifest,phrases:string[][]){
  const terms=[...new Set(phrases.flat())];
  const streams=terms.map(term=>this.postingRange(tree,manifest,term));
  const current:Array<IteratorResult<Entry<Posting>>>=[];
  // At most32 term cursors; one bounded leaf per cursor, no corpus-wide candidate array.
  for(const stream of streams)current.push(await stream.next());
  while(current.some(value=>!value.done)){
   const path=current.filter(value=>!value.done).map(value=>value.value.value.path).sort()[0]!;
   const records=new Map<string,Posting>();
   for(let i=0;i<current.length;i++)if(!current[i]!.done&&current[i]!.value.value.path===path)records.set(terms[i]!,current[i]!.value.value);
   const first=records.values().next().value!;
   const matches=phrases.map(phrase=>fields.map(name=>occurrences({postings:Object.fromEntries([...records].map(([term,value])=>[term,value.positions[name]??[]]))} as Field,phrase)));
   yield {record:first,matches};
   for(let i=0;i<current.length;i++)if(!current[i]!.done&&current[i]!.value.value.path===path)current[i]=await streams[i]!.next();
  }
 }
 async search(ref:VaultRef,query:string,limit:number){return this.searchWithOptions(ref,query,limit,{});}
 async searchWithOptions(ref:VaultRef,query:string,limit:number,options:FullTextSearchOptions){
  const saved=await this.state(ref);if(!saved.state.active)return {hits:[],docCount:0,builtAt:0,building:true};
  const prefix=`${this.prefix(ref)}${saved.state.active}/`;
  if(saved.state.activeFormat!==2){
   const result=await this.legacy(prefix,query,Number.MAX_SAFE_INTEGER);const candidates=result.hits.filter(hit=>!options.acceptPath||options.acceptPath(hit.path));const hits:FullTextSearchHit[]=[];
   for(let offset=0;offset<candidates.length&&hits.length<limit;offset+=4){const batch=candidates.slice(offset,offset+4);const accepted=options.validate?await options.validate(batch.map(hit=>({path:hit.path,hash:hit.contentHash!}))):batch.map(()=>true);for(let i=0;i<batch.length&&hits.length<limit;i++)if(accepted[i])hits.push(batch[i]!);}
   return {...result,hits};
  }
  if(!Number.isInteger(limit)||limit<1||limit>1000)throw new Error("Shared search limit must be between 1 and 1000");
  const phrases=queryPhrases(query);const unique=new Set(phrases.flat());if(unique.size>32||encode.encode(query).byteLength>4096)throw new Error("Search query exceeds 32 distinct words or 4096 UTF-8 bytes");
  const object=await this.bucket.get(`${prefix}manifest.json`);if(!object)throw new Error("Missing active shared index manifest");const manifest=await object.json<Manifest>();
  if(!phrases.length)return {hits:[],docCount:manifest.docCount,builtAt:manifest.builtAt};
  const tree=new PostingTree<Posting>(this.bucket,`${prefix}pages/`);const df=phrases.map(()=>0);
  for await(const {matches} of this.matches(tree,manifest,phrases))matches.forEach((phrase,p)=>{if(phrase.some(positions=>positions.length))df[p]=df[p]!+1;});
  const hits:FullTextSearchHit[]=[];let cursor:Pick<Candidate,"score"|"path">|undefined;
  while(hits.length<limit){
   const capacity=options.validate?Math.min(4,limit-hits.length):limit;const ranked:Candidate[]=[];
   for await(const {record,matches} of this.matches(tree,manifest,phrases)){
    if(matches.some(phrase=>phrase.every(positions=>!positions.length))||options.acceptPath&&!options.acceptPath(record.path))continue;
    let score=0,matchCount=0;
    matches.forEach((phrase,p)=>phrase.forEach((positions,f)=>{const tf=positions.length;if(!tf)return;const average=Math.max(1,manifest.totalLengths[f]!/Math.max(1,manifest.docCount));const idf=Math.log(1+(manifest.docCount-df[p]!+.5)/(df[p]!+.5));score+=weights[fields[f]!] * idf * tf*2.2/(tf+1.2*(.25+.75*record.lengths[f]!/average));matchCount+=tf;}));
    const candidate:Candidate={path:record.path,hash:record.hash,r2:record.r2,score,matchCount,matches:matches.map(phrase=>phrase.map(positions=>positions.slice(0,3)))};
    if(cursor&&compare(candidate,cursor)<=0)continue;
    let at=0;while(at<ranked.length&&compare(ranked[at]!,candidate)<=0)at++;
    if(at<capacity){ranked.splice(at,0,candidate);if(ranked.length>capacity)ranked.pop();}
   }
   if(!ranked.length)break;cursor=ranked.at(-1)!;
   const valid=options.validate?await options.validate(ranked.map(candidate=>({path:candidate.path,hash:candidate.hash}))):ranked.map(()=>true);
   for(let i=0;i<ranked.length&&hits.length<limit;i++){
    if(!valid[i])continue;const candidate=ranked[i]!;if(!candidate.r2.startsWith(`${prefix}notes/`))throw new Error("Cross-vault search note reference");
    const stored=await this.bucket.get(candidate.r2);if(!stored)throw new Error("Missing shared index snippet source");const note=await stored.json<IndexedNote>();const snippets:FullTextSearchHit["snippets"]=[];
    candidate.matches.forEach(phrase=>phrase.forEach((positions,f)=>{const text=note.fields[fields[f]!].text;for(const occurrence of positions){if(snippets.length>=5)break;snippets.push({before:[...text.slice(Math.max(0,occurrence.start-100),occurrence.start)].slice(-40).join(""),match:text.slice(occurrence.start,occurrence.end),after:[...text.slice(occurrence.end,occurrence.end+100)].slice(0,40).join("" )});}}));
    hits.push({path:candidate.path,contentHash:candidate.hash,score:candidate.score,matchCount:candidate.matchCount,snippets});
   }
   if(!options.validate)break;
  }
  return {hits,docCount:manifest.docCount,builtAt:manifest.builtAt};
 }
 async deleteVault(ref:VaultRef){let cursor:string|undefined;do{const page=await this.bucket.list({prefix:this.prefix(ref),...(cursor?{cursor}:{})});if(page.objects.length)await this.bucket.delete(page.objects.map(value=>value.key));cursor=page.truncated?page.cursor:undefined;}while(cursor);}
 /** Caller must serialize with the vault writer; grace protects searches holding an older root. */
 async collectGarbage(ref:VaultRef,options:{execute?:boolean;graceMs?:number}={}){
  const saved=await this.state(ref);const live=new Set<string>([saved.key]);
  for(const [generation,format] of [[saved.state.active,saved.state.activeFormat],[saved.state.building,saved.state.buildingFormat]] as const){
   if(!generation)continue;const prefix=`${this.prefix(ref)}${generation}/`;
   if(format!==2){let cursor:string|undefined;do{const page=await this.bucket.list({prefix,...(cursor?{cursor}:{})});for(const value of page.objects)live.add(value.key);cursor=page.truncated?page.cursor:undefined;}while(cursor);continue;}
   const key=`${prefix}manifest.json`;live.add(key);const object=await this.bucket.get(key);if(!object)continue;const manifest=await object.json<Manifest>();
   for(const entry of manifest.delta?.documents??[])if(entry.value){if(!entry.value.r2.startsWith(`${prefix}notes/`))throw new Error("Cross-vault snippet reference");live.add(entry.value.r2);}
   const docs=new PostingTree<DocumentState>(this.bucket,`${prefix}pages/`);await docs.references(manifest.documents,async doc=>{if(!doc.r2.startsWith(`${prefix}notes/`))throw new Error("Cross-vault snippet reference");live.add(doc.r2);},live);
   await new PostingTree<Posting>(this.bucket,`${prefix}pages/`).references(manifest.postings,async()=>{},live);
  }
  const garbage:string[]=[];let cursor:string|undefined;const threshold=Date.now()-(options.graceMs??86_400_000);
  do{const page=await this.bucket.list({prefix:this.prefix(ref),...(cursor?{cursor}:{})});for(const object of page.objects)if(!live.has(object.key)&&object.uploaded.getTime()<threshold)garbage.push(object.key);cursor=page.truncated?page.cursor:undefined;}while(cursor);
  if(options.execute){if((await this.state(ref)).etag!==saved.etag)throw new Error("Index generation changed during GC");for(let i=0;i<garbage.length;i+=100)await this.bucket.delete(garbage.slice(i,i+100));}
  return garbage;
 }
}
