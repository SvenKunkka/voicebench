import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';

// Exercise the production browser adapter in isolated tab contexts. Dependency
// imports are stubbed, while its IndexedDB/lock/queue/state code stays unchanged.
const moduleSource=(await readFile(new URL('../dist/browser-api.mjs',import.meta.url),'utf8'))
 .replace(/^import .*;\s*$/gm,'').replace(/^export /gm,'')
 +'\n globalThis.testAPI={browserAPI};';
const plain=value=>JSON.parse(JSON.stringify(value));
const jobId='a'.repeat(32),doneId='b'.repeat(32),failedId='c'.repeat(32);

function fakeDB(initial=[]){
 const jobs=new Map(initial.map(job=>[job.id,structuredClone(job)])),files=new Map(),writes=[];
 const db={jobs,files,writes,failWrites:false,transaction(names,mode='readonly'){
  const pending=[];
  const tx={error:null,objectStore(name){const store=name==='jobs'?jobs:files;return {
   getAll(){return request(()=>[...store.values()].map(v=>structuredClone(v)));},
   get(key){return request(()=>store.get(key));},
   put(value,key){pending.push([store,key??value.id,structuredClone(value)]);return {};}
  };},abort(){this.error=new Error('test transaction aborted');this.onabort?.();}};
  setImmediate(()=>{
   if(mode==='readwrite'&&db.failWrites){tx.error=new Error('test storage quota exceeded');tx.onabort?.();return;}
   for(const [store,key,value]of pending){store.set(key,value);writes.push({key,value:structuredClone(value)});}
   tx.oncomplete?.();
  });
  return tx;
 }};
 function request(read){const r={};setImmediate(()=>{try{r.result=read();r.onsuccess?.();}catch(e){r.error=e;r.onerror?.();}});return r;}
 return db;
}

function lockManager(){
 let holder=null;
 return {navigatorFor(tab){return {locks:{async request(name,options,callback){
  assert.equal(options.ifAvailable,true);assert.equal(options.mode,'exclusive');
  if(holder)return callback(null);
  holder=tab;
  try{return await callback({name});}finally{if(holder===tab)holder=null;}
 }}};},close(tab){if(holder===tab)holder=null;}};
}

function tab(db,navigator){
 const timers=[],notices=[];
 const context=vm.createContext({
  console,structuredClone,crypto:webcrypto,navigator,
  indexedDB:{open(){const r={};setImmediate(()=>{r.result=db;r.onsuccess?.();});return r;}},
  window:{WebAssembly,addEventListener(){},dispatchEvent(event){notices.push(event.detail);}},
  location:{origin:'https://voicebench.example'},URL,Blob,
  setTimeout(callback){timers.push(callback);return timers.length;},
  CustomEvent:class{constructor(type,options){this.type=type;this.detail=options.detail;}},
  inspectAudio(){throw new Error('analysis must not start during queue-state tests');},
  compareText(){throw new Error('text scoring must not run during queue-state tests');},
  buildTimeline(){},scoreMOS(){},transcribe(){},
  aggregate(job){return {completed:job.recordings.filter(r=>r.status==='done').length};},reportFile(){}
 });
 vm.runInContext(moduleSource,context,{filename:'browser-api.mjs'});
 return {api:context.testAPI.browserAPI,timers,notices};
}

function fixture(status='partial'){
 return {id:jobId,title:'状态恢复测试',created_at:'2026-11-13T18:00:00+08:00',status,recordings:[
  {id:doneId,device:'设备A',scene:'安静',reference:'',status:'done',result:{transcription:{text:'保留的完成结果'}}},
  {id:failedId,device:'设备B',scene:'安静',reference:'',status:'failed',error:'测试失败'}
 ]};
}
function addSources(db,job){for(const row of job.recordings)db.files.set(`${job.id}/${row.id}/source`,new Blob(['test recording']));}

test('a second tab observes current saved jobs without interrupting the active writer',async()=>{
 const db=fakeDB(),locks=lockManager(),owner=tab(db,locks.navigatorFor('owner'));
 assert.equal((await owner.api('/api/health')).analysis_lock_owner,true);
 const active=fixture('running');active.recordings[0].status='running';
 db.jobs.set(jobId,structuredClone(active));
 const observer=tab(db,locks.navigatorFor('observer'));
 const health=await observer.api('/api/health');
 assert.equal(health.analysis_lock_owner,false);assert.equal(health.capabilities.asr,false);
 assert.match(health.analysis_lock_message,/另一个标签页/);
 assert.equal((await observer.api('/api/jobs'))[0].status,'running');
 assert.equal(db.jobs.get(jobId).status,'running');assert.equal(db.writes.length,0);
 const completed=structuredClone(active);completed.status='done';completed.recordings[0].status='done';
 db.jobs.set(jobId,completed);
 assert.equal((await observer.api('/api/jobs/'+jobId)).status,'done');
 assert.equal(db.writes.length,0);
 await assert.rejects(observer.api('/api/jobs',{method:'POST'}),/另一个标签页/);
 await assert.rejects(observer.api(`/api/jobs/${jobId}/retry`,{method:'POST'}),/另一个标签页/);
 assert.equal(observer.timers.length,0);
});

test('only a newly acquired owner recovers jobs after the previous tab closes',async()=>{
 const db=fakeDB(),locks=lockManager(),oldTab=tab(db,locks.navigatorFor('old'));
 await oldTab.api('/api/health');
 const running=fixture('running');running.recordings[1].status='pending';db.jobs.set(jobId,running);
 locks.close('old');
 const next=tab(db,locks.navigatorFor('new'));
 assert.equal((await next.api('/api/health')).analysis_lock_owner,true);
 const saved=db.jobs.get(jobId);assert.equal(saved.status,'interrupted');
 assert.equal(saved.recordings[1].status,'interrupted');
 assert.equal(saved.recordings[0].status,'done');
 assert.equal(saved.recordings[0].result.transcription.text,'保留的完成结果');
});

test('unsupported Web Locks allow read-only history but never analysis writes',async()=>{
 const original=fixture('running'),db=fakeDB([original]),client=tab(db,{});
 const health=await client.api('/api/health');
 assert.equal(health.analysis_lock_supported,false);assert.equal(health.capabilities.analysis_lock,false);
 assert.equal((await client.api('/api/jobs'))[0].status,'running');
 await assert.rejects(client.api('/api/jobs',{method:'POST'}),/Chrome 或 Edge/);
 await assert.rejects(client.api(`/api/jobs/${jobId}/refresh`,{method:'POST'}),/Chrome 或 Edge/);
 assert.equal(db.writes.length,0);
});

test('failed retry persistence leaves the in-memory and stored partial job unchanged',async()=>{
 const original=fixture(),db=fakeDB([original]),locks=lockManager();addSources(db,original);
 const client=tab(db,locks.navigatorFor('owner'));await client.api('/api/health');
 db.failWrites=true;
 await assert.rejects(client.api(`/api/jobs/${jobId}/retry`,{method:'POST'}),/quota exceeded/);
 const current=await client.api('/api/jobs/'+jobId);
 assert.equal(current.status,'partial');assert.equal(current.recordings[1].status,'failed');
 assert.deepEqual(plain(current.recordings),original.recordings);
 assert.deepEqual(db.jobs.get(jobId),original);assert.equal(client.timers.length,0);
});

test('refresh validates every source before replacing any completed result',async()=>{
 const original=fixture('done');original.recordings[1].status='done';original.recordings[1].result={transcription:{text:'另一个完成结果'}};
 const db=fakeDB([original]),locks=lockManager();db.files.set(`${jobId}/${doneId}/source`,new Blob(['only first source']));
 const client=tab(db,locks.navigatorFor('owner'));await client.api('/api/health');
 await assert.rejects(client.api(`/api/jobs/${jobId}/refresh`,{method:'POST'}),/原录音已不在/);
 const current=await client.api('/api/jobs/'+jobId);
 assert.deepEqual(plain(current.recordings),original.recordings);assert.equal(current.status,'done');
 assert.deepEqual(db.jobs.get(jobId),original);assert.equal(client.timers.length,0);
});

test('a successful retry queues only unfinished recordings and suppresses double-click requeues',async()=>{
 const original=fixture(),db=fakeDB([original]),locks=lockManager();addSources(db,original);
 const client=tab(db,locks.navigatorFor('owner'));await client.api('/api/health');
 const [first,second]=await Promise.allSettled([
  client.api(`/api/jobs/${jobId}/retry`,{method:'POST'}),
  client.api(`/api/jobs/${jobId}/retry`,{method:'POST'})
 ]);
 assert.equal(first.status,'fulfilled');assert.equal(second.status,'rejected');
 assert.match(second.reason.message,/仍在进行/);
 const saved=db.jobs.get(jobId);assert.equal(saved.status,'queued');
 assert.equal(saved.recordings[0].status,'done');assert.deepEqual(saved.recordings[0].result,original.recordings[0].result);
 assert.equal(saved.recordings[1].status,'pending');assert.equal(client.timers.length,1);
});
