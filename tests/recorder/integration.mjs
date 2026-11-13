import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {randomUUID} from 'node:crypto';
import {wavHeader} from '../../app/static/recorder/wav.mjs';

class Element {
  constructor(ownerDocument) { this.ownerDocument=ownerDocument;this.children=[];this.dataset={};this.attributes={};this.hidden=false;this.disabled=false;this.checked=false;this.textContent='';this.events=new Map();this.names=new Set();this.classList={add:(...xs)=>xs.forEach(x=>this.names.add(x)),remove:(...xs)=>xs.forEach(x=>this.names.delete(x)),toggle:(x,on)=>on?this.names.add(x):this.names.delete(x)}; }
  set innerHTML(html){this.html=html; if(this.elements) for(const match of html.matchAll(/<[^>]*data-recorder="([^"]+)"[^>]*>/g)){const element=new Element(this.ownerDocument);element.hidden=/\bhidden\b/.test(match[0]);element.disabled=/\bdisabled\b/.test(match[0]);this.elements.set(match[1],element);}}
  get innerHTML(){return this.html||'';}
  querySelector(selector){return this.elements?.get(selector.match(/data-recorder="([^"]+)"/)?.[1])||null;}
  querySelectorAll(selector){const tags=selector.split(',');const walk=children=>children.flatMap(child=>[...(tags.includes(child.tagName)||tags.includes(child.type==='button'?'button':child.type==='checkbox'?'input':'')?[child]:[]),...walk(child.children||[])]);return walk(this.children);}
  replaceChildren(...children){this.children=[...children];} append(...children){this.children.push(...children);} remove(){} setAttribute(name,value){this.attributes[name]=value;}removeAttribute(name){delete this.attributes[name];}
  addEventListener(name,handler){this.events.set(name,handler);}removeEventListener(name){this.events.delete(name);}
  pause(){}load(){}play(){return Promise.resolve();}click(){this.onclick?.();}getBoundingClientRect(){return {width:0,height:0};}
}
const document={createElement:tag=>{const element=new Element(document);element.tagName=tag;return element;},body:null};document.body=new Element(document);
const container=new Element(document);container.elements=new Map();const get=id=>{const element=container.elements.get(id);assert.ok(element,`template contains ${id}`);return element;};
const library=new Map(),states=[],comparisons=[],requests=[],workletURLs=[];
let failSave=false,failMic=false,defaultDevice='测试默认麦克风',node,micCalls=0,confirmCalls=0,saveGate,compareAllowed;
const tracks=[];
function microphone(options){
  micCalls++;requests.push(options);
  if(failMic){const error=new Error('denied');error.name='NotAllowedError';throw error;}
  const track={label:defaultDevice,readyState:'live',getSettings:()=>({sampleRate:48000,echoCancellation:false,noiseSuppression:false,autoGainControl:false}),stop(){this.readyState='ended';}};tracks.push(track);
  return {get active(){return track.readyState==='live';},getTracks:()=>[track],getAudioTracks:()=>[track]};
}
const window=new Element(document);window.isSecureContext=true;window.AudioWorkletNode=true;
const sandbox={console,Blob,Date,crypto:{randomUUID},wavHeader,
  listRecordings:async()=>[...library.values()].map(({blob,peaks,...metadata})=>metadata),
  readRecording:async id=>{if(!library.has(id))throw new Error('missing');return library.get(id);},
  saveRecording:async(metadata,blob,peaks)=>{if(saveGate)await saveGate;if(failSave){const error=new Error('quota');error.name='QuotaExceededError';throw error;}library.set(metadata.id,{...metadata,blob,peaks});},
  document,window,navigator:{mediaDevices:{getUserMedia:async options=>microphone(options),addEventListener(){},removeEventListener(){}}},
  ResizeObserver:class{observe(){}disconnect(){}},devicePixelRatio:1,
  AudioContext:class{constructor(){this.state='running';this.sampleRate=48000;this.audioWorklet={addModule:async url=>workletURLs.push(url)};}createMediaStreamSource(){return{connect(){},disconnect(){}};}createGain(){return{gain:{value:1},connect(){},disconnect(){}};}resume(){return Promise.resolve();}close(){return Promise.resolve();}},
  AudioWorkletNode:class{constructor(){node=this;this.port={postMessage:()=>Promise.resolve().then(()=>this.port.onmessage({data:{type:'stopped'}}))};}connect(){}disconnect(){}},
  URL:{revokeObjectURL(){},createObjectURL:()=> 'blob:local-only'},performance:{now:()=>0},confirm:()=>{confirmCalls++;return false;},setInterval:()=>1,clearInterval(){},setTimeout,clearTimeout};
const source=fs.readFileSync(new URL('../../app/static/recorder/recorder.mjs',import.meta.url),'utf8');
vm.runInNewContext(source.replace(/^import .*;\r?\n/gm,'').replace('export function mountRecorder','function mountRecorder')+'\nglobalThis.mountRecorder=mountRecorder;',sandbox);
const controller=sandbox.mountRecorder(container,{onCompare:async items=>{comparisons.push(items);compareAllowed=controller.canLeave().allowed;},onStateChange:state=>states.push(state)});
await controller.ready;
assert.equal(sandbox.mountRecorder(container),controller,'mount is idempotent on the same root');
assert.equal(controller.canLeave().allowed,true);
assert.equal(get('libraryList').children.length,0);
assert.equal(get('compareCurrent').disabled,true);
assert.equal(get('compareSelected').disabled,true);
assert.equal(get('confirmDownload').hidden,true);

await get('authorize').onclick();
assert.equal(micCalls,1);
assert.match(get('actualInput').textContent,/测试默认麦克风/);
await get('record').onclick();
assert.equal(micCalls,1,'recording reuses the approved stream');
assert.equal(controller.canLeave().allowed,false,'recording blocks tab changes');
assert.match(controller.canLeave().reason,/正在录音/);
assert.equal(controller.destroy().allowed,false,'cannot destroy an active recording');
assert.deepEqual(workletURLs,['/static/recorder/pcm-worklet.js']);
assert.equal(requests[0].audio.echoCancellation,false);assert.equal(requests[0].audio.noiseSuppression,false);assert.equal(requests[0].audio.autoGainControl,false);
assert.equal('deviceId' in requests[0].audio,false,'never pins an old device');
node.port.onmessage({data:{type:'pcm',buffer:new ArrayBuffer(8192),frames:4096,peak:.04,missing:0}});
let releaseSave;saveGate=new Promise(resolve=>{releaseSave=resolve;});
const stopping=get('stop').onclick();
await new Promise(resolve=>setTimeout(resolve,0));
assert.equal(controller.canLeave().allowed,false,'WAV generation and saving block tab changes');
assert.ok(states.some(state=>state.state==='saving'));
releaseSave();await stopping;saveGate=null;
assert.equal(library.size,1);assert.equal(controller.canLeave().allowed,true);
assert.equal(get('compareCurrent').disabled,false);
await get('compareCurrent').onclick();
assert.equal(comparisons.length,1);assert.equal(comparisons[0].length,1);
assert.ok(comparisons[0][0].blob instanceof Blob);assert.match(comparisons[0][0].filename,/^Vibe_.*\.wav$/);
assert.equal(comparisons[0][0].device,'测试默认麦克风');assert.equal(typeof comparisons[0][0].createdAt,'number');
assert.equal(comparisons[0][0].id,[...library.keys()][0]);assert.equal(comparisons[0][0].duration,4096/48000);
assert.equal(compareAllowed,true,'parent callback can safely switch tabs');
const firstId=[...library.keys()][0];
await get('record').onclick();assert.equal(micCalls,1);assert.equal(confirmCalls,0);
failSave=true;node.port.onmessage({data:{type:'pcm',buffer:new ArrayBuffer(8192),frames:4096,peak:.04,missing:0}});await get('stop').onclick();
assert.equal(library.size,1,'save failure preserves the older take');
assert.equal(get('retrySave').hidden,false);assert.match(get('libraryError').textContent,/空间不足/);
assert.equal(controller.canLeave().allowed,false,'only unsaved copy blocks navigation');
assert.equal(get('compareCurrent').disabled,true);
const currentWAV=get('download').href;
get('download').onclick();
assert.equal(controller.canLeave().allowed,false,'download initiation is not proof of a saved copy');
assert.equal(get('confirmDownload').hidden,false);
failMic=true;await get('authorize').onclick();
assert.equal(tracks[0].readyState,'ended','explicit reconnect releases old microphone');
assert.equal(get('actualInput').textContent,'尚未连接');assert.equal(get('download').href,currentWAV,'failed reconnect retains the current WAV');
assert.equal(controller.canLeave().allowed,false);
await get('libraryList').children[0].children[1].onclick();
assert.match(get('error').textContent,/还未保存/,'opening history cannot replace unsaved take');
await get('record').onclick();assert.equal(confirmCalls,1,'starting a new take requires acknowledging loss of an unsaved only copy');
failSave=false;await get('retrySave').onclick();
assert.equal(library.size,2);assert.ok(library.has(firstId));assert.equal(controller.canLeave().allowed,true);
assert.equal(get('confirmDownload').hidden,true);assert.equal(get('retrySave').hidden,true);

failMic=false;defaultDevice='另一默认输入';await get('authorize').onclick();
assert.equal(micCalls,3);assert.match(get('actualInput').textContent,/另一默认输入/);
await get('record').onclick();assert.equal(micCalls,3);
node.port.onmessage({data:{type:'pcm',buffer:new ArrayBuffer(8192),frames:4096,peak:.04,missing:0}});await get('stop').onclick();
assert.equal(library.size,3);
for(let index=0;index<21;index++) {
  const blob=new Blob([wavHeader(16,48000),new ArrayBuffer(32)],{type:'audio/wav'});
  const id=`history-${index}`;library.set(id,{id,createdAt:index,title:`历史${index}`,filename:`history-${index}.wav`,device:'历史输入',sampleRate:48000,frames:16,bytes:blob.size,blob,peaks:[]});
}
await controller.refresh();
for(let index=0;index<21;index++){const checkbox=get('libraryList').children[index].children[0];checkbox.checked=true;checkbox.onchange();}
assert.match(get('selectionStatus').textContent,/20 \/ 20/);assert.match(get('libraryError').textContent,/最多选择 20/);
assert.equal(get('libraryList').children[20].children[0].checked,false);
await get('compareSelected').onclick();
assert.equal(comparisons.at(-1).length,20);
assert.equal(compareAllowed,true,'batch transfer clears read-busy before callback');
assert.ok(comparisons.at(-1).every(item=>item.blob instanceof Blob));
assert.equal(library.size,24,'comparison never deletes or modifies the library');
const missingId=get('libraryList').children[0].children[0].dataset.takeId;
const missingTake=library.get(missingId);library.delete(missingId);
const callbacksBefore=comparisons.length;await get('compareSelected').onclick();
assert.equal(comparisons.length,callbacksBefore,'failed library read cannot transfer partial batches');
assert.equal(controller.canLeave().allowed,true,'failed transfer releases busy state');library.set(missingId,missingTake);
await get('libraryList').children[0].children[1].onclick();
assert.equal(get('stateText').textContent,'回听历史录音');
await get('record').onclick();failSave=true;
node.port.onmessage({data:{type:'pcm',buffer:new ArrayBuffer(8192),frames:4096,peak:.04,missing:0}});await get('stop').onclick();
assert.equal(controller.canLeave().allowed,false);get('download').onclick();assert.equal(controller.canLeave().allowed,false);
get('confirmDownload').onclick();assert.equal(controller.canLeave().allowed,true,'explicit confirmation acknowledges an external saved copy');
assert.equal(get('retrySave').hidden,false,'pending take remains available to retry after external-download acknowledgment');
await get('compareCurrent').onclick();assert.equal(comparisons.at(-1).length,1);
await get('disconnect').onclick();assert.equal(get('actualInput').textContent,'尚未连接');
assert.equal(controller.destroy().allowed,true);assert.equal(container.children.length,0);
assert.equal(window.events.size,0,'destroy removes global event listeners');
assert.equal(requests.every(options=>!('deviceId' in options.audio)),true);
assert.equal(source.includes('fetch('),false,'module transfers only local Blob objects');
assert.equal(source.includes('document.getElementById('),false,'DOM lookup is scoped to the container');
const styles=fs.readFileSync(new URL('../../app/static/recorder/recorder.css',import.meta.url),'utf8');
for(const match of styles.matchAll(/(?:^|[{}])([^{}]+)\{/g)){
  const selector=match[1].trim();if(selector.startsWith('@'))continue;
  for(const part of selector.split(','))assert.ok(part.trim().startsWith('.recorder-workspace'),`scoped CSS selector: ${part}`);
}
console.log('PASS recorder integration: default stream reuse/reconnect; raw PCM worklet path; recording/saving/unsaved navigation guards; current Blob handoff; independent save failure preserves takes; 20-selection cap and batch handoff; library playback; DOM/CSS isolation; cleanup.');
