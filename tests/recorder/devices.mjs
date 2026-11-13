import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {randomUUID} from 'node:crypto';
import {wavHeader} from '../../app/static/recorder/wav.mjs';

const source=fs.readFileSync(new URL('../../app/static/recorder/recorder.mjs',import.meta.url),'utf8');
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
const input=(id,label=`麦克风 ${id}`)=>({kind:'audioinput',deviceId:id,label});
class Element {
  constructor(document){this.ownerDocument=document;this.children=[];this.dataset={};this.attributes={};this.hidden=false;this.disabled=false;this.value='';this.textContent='';this.events=new Map();this.classList={add(){},remove(){},toggle(){}};}
  set innerHTML(html){this.html=html;if(this.elements)for(const match of html.matchAll(/<[^>]*data-recorder="([^"]+)"[^>]*>/g)){const element=new Element(this.ownerDocument);element.hidden=/\bhidden\b/.test(match[0]);element.disabled=/\bdisabled\b/.test(match[0]);this.elements.set(match[1],element);}}
  querySelector(selector){return this.elements?.get(selector.match(/data-recorder="([^"]+)"/)?.[1])||null;}
  querySelectorAll(selector){const tags=selector.split(',');const walk=children=>children.flatMap(child=>[...(tags.includes(child.tagName)||tags.includes(child.type==='button'?'button':child.type==='checkbox'?'input':'')?[child]:[]),...walk(child.children||[])]);return walk(this.children);}
  replaceChildren(...children){this.children=[...children];}append(...children){this.children.push(...children);}remove(){}setAttribute(name,value){this.attributes[name]=value;}removeAttribute(name){delete this.attributes[name];}
  addEventListener(name,handler){this.events.set(name,handler);}removeEventListener(name){this.events.delete(name);}
  pause(){}load(){}play(){return Promise.resolve();}click(){this.onclick?.();}getBoundingClientRect(){return{width:0,height:0};}
}
function createApp(){
  const document={createElement:tag=>{const element=new Element(document);element.tagName=tag;return element;},body:null};document.body=new Element(document);
  const container=new Element(document);container.elements=new Map();
  const get=id=>{const element=container.elements.get(id);assert.ok(element,`missing UI ${id}`);return element;};
  const state={granted:false,devices:[input('A','USB 输入 A'),input('B','USB 输入 B')],defaultId:'A',enumerationQueue:[],requests:[],enumerations:0,tracks:[],rejected:new Set(),denied:false,actualOverride:null,omitSettingsId:false,micGate:null,saveGate:null,library:new Map(),node:null,updates:[]};
  const media=new Element(document);
  media.enumerateDevices=async()=>{state.enumerations++;if(state.enumerationQueue.length)return await state.enumerationQueue.shift();return state.granted?[...state.devices]:[];};
  media.getUserMedia=async options=>{
    state.requests.push(JSON.parse(JSON.stringify(options)));
    if(state.micGate)await state.micGate;
    const requested=options.audio.deviceId?.exact||state.defaultId;
    if(state.denied){const error=new Error('permission denied');error.name='NotAllowedError';throw error;}
    if(state.rejected.has(requested)){const error=new Error('missing input');error.name='NotFoundError';throw error;}
    state.granted=true;
    const actual=state.actualOverride||requested;
    const track={id:actual,label:state.devices.find(device=>device.deviceId===actual)?.label||`实际输入 ${actual}`,readyState:'live',
      getSettings:()=>({sampleRate:48000,...(state.omitSettingsId?{}:{deviceId:actual})}),stop(){this.readyState='ended';this.stopped=true;}};
    state.tracks.push(track);
    return{get active(){return track.readyState==='live';},getTracks:()=>[track],getAudioTracks:()=>[track]};
  };
  const window=new Element(document);window.isSecureContext=true;window.AudioWorkletNode=true;
  const sandbox={console,Blob,Date,crypto:{randomUUID},wavHeader,document,window,navigator:{mediaDevices:media},devicePixelRatio:1,
    listRecordings:async()=>[...state.library.values()].map(({blob,peaks,...metadata})=>metadata),
    readRecording:async id=>state.library.get(id),saveRecording:async(metadata,blob,peaks)=>{if(state.saveGate)await state.saveGate;state.library.set(metadata.id,{...metadata,blob,peaks});},
    ResizeObserver:class{observe(){}disconnect(){}},
    AudioContext:class{constructor(){this.state='running';this.sampleRate=48000;this.audioWorklet={addModule:async()=>{}};}createMediaStreamSource(){return{connect(){},disconnect(){}};}createGain(){return{gain:{value:1},connect(){},disconnect(){}};}resume(){return Promise.resolve();}close(){return Promise.resolve();}},
    AudioWorkletNode:class{constructor(){state.node=this;this.port={postMessage:()=>Promise.resolve().then(()=>this.port.onmessage({data:{type:'stopped'}}))};}connect(){}disconnect(){}},
    URL:{revokeObjectURL(){},createObjectURL:()=>`blob:take-${state.library.size}`},performance:{now:()=>0},confirm:()=>false,setInterval:()=>1,clearInterval(){},setTimeout,clearTimeout};
  vm.runInNewContext(source.replace(/^import .*;\r?\n/gm,'').replace('export function mountRecorder','function mountRecorder')+'\nglobalThis.mountRecorder=mountRecorder;',sandbox);
  const controller=sandbox.mountRecorder(container,{onCompare(){},onStateChange:update=>state.updates.push(update)});
  return{state,get,controller,media,container,select:async id=>{get('deviceSelect').value=id;await get('deviceSelect').onchange();await tick();},options:()=>get('deviceSelect').children.map(option=>({id:option.value,label:option.textContent})),
    feed:()=>state.node.port.onmessage({data:{type:'pcm',buffer:new ArrayBuffer(8192),frames:4096,peak:.1,missing:0}})};
}

// Permission reveals names, explicit A→B switches stop old tracks, and an
// unchanged explicit input is reused for the next raw-PCM recording.
{
  const app=createApp(),{state,get,controller}=app;await controller.ready;
  assert.deepEqual(app.options().map(option=>option.id),['']);
  await get('authorize').onclick();await tick();
  assert.ok(state.enumerations>=2,'enumerate again after permission');
  assert.deepEqual(app.options().map(option=>option.id),['','A','B']);
  assert.equal('deviceId' in state.requests[0].audio,false,'browser default has no pinned ID');
  const defaultTrack=state.tracks.at(-1);await app.select('A');
  assert.equal(defaultTrack.stopped,true);assert.equal(state.requests.at(-1).audio.deviceId.exact,'A');
  const a=state.tracks.at(-1);await app.select('B');
  assert.equal(a.stopped,true);assert.equal(state.requests.at(-1).audio.deviceId.exact,'B');
  assert.equal(get('actualInput').textContent,'USB 输入 B');
  const b=state.tracks.at(-1),calls=state.requests.length;await get('record').onclick();
  assert.equal(state.requests.length,calls,'reuse the same selected B stream');
  assert.equal(get('deviceSelect').disabled,true);assert.equal(get('refreshDevices').disabled,true);
  get('deviceSelect').value='A';await get('deviceSelect').onchange();
  assert.equal(get('deviceSelect').value,'B','programmatic changes during recording are rejected');
  await get('refreshDevices').onclick();assert.equal(state.requests.length,calls);assert.equal(b.stopped,undefined);
  app.feed();const saving=deferred();state.saveGate=saving.promise;const stop=get('stop').onclick();await tick();
  get('deviceSelect').value='A';await get('deviceSelect').onchange();assert.equal(get('deviceSelect').value,'B','saving blocks selection');
  assert.equal(state.requests.length,calls);saving.resolve();await stop;state.saveGate=null;
  assert.equal([...state.library.values()][0].device,'USB 输入 B');
  assert.equal(get('deviceSelect').disabled,false);assert.equal(controller.canLeave().allowed,true);
  const wav=get('download').href;state.rejected.add('A');await app.select('A');
  assert.equal(b.stopped,true);assert.equal(get('deviceSelect').value,'A');assert.equal(get('actualInput').textContent,'尚未连接');
  assert.equal(get('download').href,wav,'switch failure retains current WAV');assert.equal(state.library.size,1,'switch failure retains history');
  assert.match(get('notice').textContent,/不会自动/);
  assert.equal(state.requests.at(-1).audio.deviceId.exact,'A');
  const failedCalls=state.requests.length;await get('record').onclick();assert.equal(state.requests.length,failedCalls+1);
  assert.equal(state.requests.at(-1).audio.deviceId.exact,'A','a retry never falls back');assert.equal(get('download').href,wav);
  state.rejected.clear();state.actualOverride='B';await get('authorize').onclick();
  assert.equal(state.tracks.at(-1).stopped,true,'actual ID mismatch stops the returned candidate');
  assert.equal(get('actualInput').textContent,'尚未连接');assert.match(get('error').textContent,/实际输入与所选设备不一致/);
  state.actualOverride=null;state.denied=true;await get('authorize').onclick();
  assert.equal(state.requests.at(-1).audio.deviceId.exact,'A');assert.match(get('error').textContent,/权限未开启/);
  state.denied=false;await app.select('');assert.equal('deviceId' in state.requests.at(-1).audio,false);
  assert.equal(get('actualInput').textContent,'USB 输入 A');assert.equal(controller.destroy().allowed,true);
}

// A connection in flight cannot be replaced by a second change event.
{
  const app=createApp(),{state,get,controller}=app;await controller.ready;
  const gate=deferred();state.micGate=gate.promise;const permission=get('authorize').onclick();
  get('deviceSelect').value='B';await get('deviceSelect').onchange();
  assert.equal(get('deviceSelect').value,'');assert.equal(state.requests.length,1);
  assert.equal(controller.canLeave().allowed,false);gate.resolve();await permission;await tick();
  assert.equal(get('actualInput').textContent,'USB 输入 A');assert.equal(controller.destroy().allowed,true);
}

// Empty/limited device enumeration cannot replace a successful stream or its
// selected identity; insertion/removal updates choices without a hidden switch.
{
  const app=createApp(),{state,get,controller,media}=app;await controller.ready;
  await get('authorize').onclick();await tick();await app.select('B');
  const b=state.tracks.at(-1),calls=state.requests.length;
  state.enumerationQueue.push(Promise.resolve([]));await get('refreshDevices').onclick();
  assert.equal(get('actualInput').textContent,'USB 输入 B');assert.equal(get('deviceSelect').value,'B');assert.equal(b.stopped,undefined);
  assert.ok(app.options().some(option=>option.id==='B'));
  state.devices=[input('A','USB 输入 A'),{kind:'audiooutput',deviceId:'speaker',label:'扬声器'}];state.rejected.add('B');
  b.readyState='ended';b.onended();await tick();
  assert.equal(get('actualInput').textContent,'尚未连接');assert.equal(get('deviceSelect').value,'B');assert.match(get('error').textContent,/没有自动切换/);
  assert.equal(state.requests.length,calls,'unplug does not request a fallback');
  await get('record').onclick();assert.equal(state.requests.at(-1).audio.deviceId.exact,'B');
  await app.select('A');assert.ok(!app.options().some(option=>option.id==='B'),'old unavailable B disappears after user selects A');
  assert.ok(!app.options().some(option=>option.id==='speaker'));
  const a=state.tracks.at(-1),count=state.requests.length;state.devices.push(input('C','新接入 USB C'));
  media.events.get('devicechange')();await tick();assert.ok(app.options().some(option=>option.id==='C'));
  assert.equal(state.requests.length,count);assert.equal(a.stopped,undefined);
  state.omitSettingsId=true;state.enumerationQueue.push(Promise.resolve([]));await app.select('C');
  assert.equal(get('actualInput').textContent,'新接入 USB C','track label remains available without settings ID or enumeration');
  assert.equal(get('deviceSelect').value,'C');assert.equal(controller.destroy().allowed,true);
}

// Old enumerations cannot overwrite a later successful switch, empty or not.
{
  const app=createApp(),{state,get,controller}=app;await controller.ready;await get('authorize').onclick();await tick();await app.select('A');
  const old=deferred();state.enumerationQueue.push(old.promise);const pending=get('refreshDevices').onclick();
  await app.select('B');const stableStatus=get('deviceStatus').textContent;
  old.resolve([input('A','过期设备名')]);await pending;
  assert.equal(get('deviceSelect').value,'B');assert.equal(get('actualInput').textContent,'USB 输入 B');
  assert.ok(app.options().some(option=>option.id==='B'));assert.ok(!app.options().some(option=>option.label==='过期设备名'));
  assert.equal(get('deviceStatus').textContent,stableStatus);
  const empty=deferred();state.enumerationQueue.push(empty.promise);const emptyPending=get('refreshDevices').onclick();
  await app.select('A');empty.resolve([]);await emptyPending;
  assert.equal(get('deviceSelect').value,'A');assert.equal(get('actualInput').textContent,'USB 输入 A');
  const first=deferred(),second=deferred();state.enumerationQueue.push(first.promise,second.promise);
  const p1=get('refreshDevices').onclick(),p2=get('refreshDevices').onclick();
  second.resolve([input('A','USB 输入 A'),input('B','USB 输入 B'),input('C','新列表 C')]);await p2;
  first.resolve([input('A','旧列表 A')]);await p1;
  assert.ok(app.options().some(option=>option.id==='C'));assert.ok(!app.options().some(option=>option.label==='旧列表 A'));
  const afterDestroy=deferred();state.enumerationQueue.push(afterDestroy.promise);const last=get('refreshDevices').onclick();
  const savedOptions=app.options();assert.equal(controller.destroy().allowed,true);const updateCount=state.updates.length;
  afterDestroy.resolve([input('Z','不应回写')]);await last;
  assert.equal(containerSize(app.container),0);assert.equal(state.updates.length,updateCount);
  assert.deepEqual(app.options(),savedOptions,'destroy invalidates late enumeration UI updates');
}
function containerSize(container){return container.children.length;}
assert.equal(source.includes('localStorage'),false,'selected device IDs are not persisted across sessions');
console.log('PASS device selection: default constraints, permission labels, A→B exact/stop/reuse, recording+save+connection guards, explicit rejection and actual-ID mismatch without fallback, unplug/insertion, empty enumeration preservation, stale/new enumeration ordering, and destroy invalidation.');
