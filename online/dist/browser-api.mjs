import {inspectAudio} from './audio-metrics.mjs';
import {compareText} from './text-metrics.mjs';
import {buildTimeline} from './timeline.mjs';
import {scoreMOS} from './mos.mjs';
import {transcribe} from './asr.mjs';
import {aggregate,reportFile} from './reporting.mjs';
const METHOD={version:'online-1.0.0',text:'在线版使用量化 Whisper tiny，独立识别后与正确原稿按字符对照；原稿不输入识别模型。不与桌面 small 的识别分混合排名。',content_score:'有原稿：max(0,100×(1−CER))；无正确原稿时未测。分数不是人工听懂率。',grouping:'音质按场景分组；CER只比较同场景、同一非空归一化原稿。同设备重复取均值。',limits:'DNSMOS 是模型预测，不是人工MOS、真实声学信噪比或硬件认证；没有干净参考不计算STOI/PESQ。',timeline:'时间是模型估计；多字词组不均分成逐字时间；9.01秒音质窗口不能解释成单字扣分。',refresh:'所有音频与结果留在当前浏览器。关闭网页会中断正在运行的分析；可重新打开后重试。首次使用需要下载模型，后续通常复用浏览器缓存。'};
const jobs=new Map(),sources=new Map(),urls=new Map(),queue=[],requeueing=new Set();let running=false;
const lockState={supported:!!globalThis.navigator?.locks?.request,owner:false,message:''};
const lockReady=new Promise(resolve=>{
 if(!lockState.supported){lockState.message='当前浏览器不支持安全的分析标签页锁，暂不能开始分析；录音仍可使用。请使用最新版 Chrome 或 Edge。';resolve();return;}
 try{navigator.locks.request('voicebench-online-analysis-writer-v1',{mode:'exclusive',ifAvailable:true},async lock=>{
  if(!lock){lockState.message='另一个标签页已占用分析工作区。本页可查看已保存结果；请关闭那个标签页后刷新本页，再开始分析。';resolve();return;}
  lockState.owner=true;resolve();
  // Keep the browser-managed lock for this document's lifetime. Closing the
  // document releases it automatically; a second tab never steals ownership.
  await new Promise(()=>{});
 }).catch(()=>{lockState.owner=false;lockState.message='无法取得浏览器分析锁。请使用最新版 Chrome 或 Edge，并刷新页面重试。';resolve();});}
 catch{lockState.message='无法取得浏览器分析锁。请使用最新版 Chrome 或 Edge，并刷新页面重试。';resolve();}
});
function requireWriter(){if(!lockState.owner)throw new Error(lockState.message||'当前标签页没有分析权限，请刷新页面重试。');}
const uid=()=>crypto.randomUUID().replaceAll('-','');
const localDate=()=>{const d=new Date(),offset=-d.getTimezoneOffset(),p=n=>String(Math.abs(n)).padStart(2,'0');return new Date(d.getTime()+offset*60000).toISOString().slice(0,19)+(offset>=0?'+':'-')+p(Math.trunc(offset/60))+':'+p(offset%60);};
const req=r=>new Promise((ok,no)=>{r.onsuccess=()=>ok(r.result);r.onerror=()=>no(r.error);});
const opened=new Promise((ok,no)=>{const r=indexedDB.open('voicebench-online-analysis',1);r.onupgradeneeded=()=>{r.result.createObjectStore('jobs',{keyPath:'id'});r.result.createObjectStore('files');};r.onsuccess=()=>ok(r.result);r.onerror=()=>no(new Error('浏览器存储不可用。请允许网站存储，或换用普通浏览窗口。'));});
async function transaction(stores,mode,callback){const db=await opened;return new Promise((ok,no)=>{const tx=db.transaction(stores,mode);tx.oncomplete=()=>ok();tx.onerror=()=>no(tx.error);tx.onabort=()=>no(tx.error||new Error('浏览器存储空间不足，请下载重要录音后释放空间。'));try{callback(tx);}catch(e){tx.abort();no(e);}});}
const key=(j,r,k)=>`${j}/${r}/${k}`;
async function file(j,r,k){const k2=key(j,r,k);if(sources.has(k2))return sources.get(k2);const db=await opened,v=await req(db.transaction('files').objectStore('files').get(k2));if(v)sources.set(k2,v);return v;}
async function persist(job,files=[]){requireWriter();await transaction(['jobs','files'],'readwrite',tx=>{requireWriter();tx.objectStore('jobs').put(job);for(const [k,v]of files)tx.objectStore('files').put(v,k);});}
async function readSavedJobs(){const db=await opened;return req(db.transaction('jobs').objectStore('jobs').getAll());}
async function refreshObserverJobs(){if(lockState.owner)return;const records=await readSavedJobs();jobs.clear();for(const job of records)jobs.set(job.id,job);}
const loaded=(async()=>{await lockReady;const records=await readSavedJobs();for(const job of records){if(lockState.owner&&['running','queued'].includes(job.status)){job.status='interrupted';for(const row of job.recordings)if(['running','pending'].includes(row.status))row.status='interrupted';await persist(job);}jobs.set(job.id,job);}})();
function memo(j,r,k,blob){if(!blob)return;const id=key(j,r,k);sources.set(id,blob);if(urls.has(id))URL.revokeObjectURL(urls.get(id));urls.set(id,URL.createObjectURL(blob));}
export function audioURL(j,r,k='original'){return urls.get(key(j,r,k))||'';}
async function hydrate(job){for(const row of job.recordings)if(row.result){for(const k of ['original','matched'])if(!urls.has(key(job.id,row.id,k)))memo(job.id,row.id,k,await file(job.id,row.id,k));}}
const fail=e=>e instanceof Error?e:new Error(String(e));
async function safeSave(job,files=[]){try{await persist(job,files);}catch(e){job.storage_warning='结果未能保存到浏览器；当前页面仍可查看，请先导出报告。';window.dispatchEvent(new CustomEvent('voicebench-notice',{detail:job.storage_warning}));}}
async function run(){if(running)return;running=true;try{while(queue.length){const job=jobs.get(queue.shift());job.status='running';await safeSave(job);for(const row of job.recordings){if(row.status==='done')continue;row.status='running';row.stage='读取与解码录音';delete row.error;await safeSave(job);
try{const source=await file(job.id,row.id,'source');if(!source)throw new Error('浏览器中没有这份原始文件，请重新导入。');const started=performance.now();
const update=message=>{row.stage=typeof message==='string'?message:JSON.stringify(message);};
const {audio,samples,original,matched}=await inspectAudio(source,job.channel);
update('准备浏览器语音识别模型…');const transcription=audio.digital_silence?{text:'',segments:[],words:[],engine:'数字静音保护',version:'online-1.0.0',settings:{}}:await transcribe(samples,job.language,update);
const text=compareText(row.reference,transcription.text,job.keywords);
let mos;try{mos=await scoreMOS(samples,update);}catch(e){mos={available:false,reason:fail(e).message};}
const warnings=[...(audio.warnings||[])];if(audio.duration<9.01)warnings.push('录音不足9.01秒，音质模型会重复补齐；结果仅供整段参考。');
if(!transcription.text.trim()&&!audio.digital_silence){warnings.push('未识别出文字，不能直接认定人类听不懂。');mos={available:false,reason:'未识别出有效文字，不将该录音的MOS用于人声比较。'};}
const timeline=buildTimeline(samples,16000,transcription,audio,mos);
row.result={audio,text,mos,transcription,timeline,warnings,elapsed_seconds:(performance.now()-started)/1000,provenance:{analysis_version:'online-1.0.0',source_sha256:row.sha256,reference_sent_to_asr:false,processing:'browser-only',channel:job.channel,asr:{engine:transcription.engine,version:transcription.version,settings:transcription.settings},dnsmos_sha256:mos.model_sha256||null}};
row.status='done';row.stage='已完成';delete row.result_stale;memo(job.id,row.id,'original',original);memo(job.id,row.id,'matched',matched);await safeSave(job,[[key(job.id,row.id,'original'),original],[key(job.id,row.id,'matched'),matched]]);
}catch(e){row.status='failed';row.error=fail(e).message;row.stage='分析失败，可重试';await safeSave(job);}}
job.status=job.recordings.some(r=>r.status==='failed')?'partial':'done';await safeSave(job);}}finally{running=false;}}
const summary=j=>({id:j.id,title:j.title,created_at:j.created_at,status:j.status,count:j.recordings.length,completed:j.recordings.filter(r=>r.status==='done').length});
export async function browserAPI(url,options={}){
await loaded;
await refreshObserverJobs();
if(url==='/api/health')return {name:'收音对比台在线版',app_id:'voicebench-online',version:'online-1.0.0',server:{primary_origin:location.origin},analysis_lock_owner:lockState.owner,analysis_lock_supported:lockState.supported,analysis_lock_message:lockState.message,capabilities:{ffmpeg:true,ffprobe:true,asr:!!window.WebAssembly&&lockState.owner,dnsmos:!!window.WebAssembly&&lockState.owner,analysis_lock:lockState.owner,local_only:true},method:METHOD};
if(url==='/api/jobs'&&options.method!=='POST')return [...jobs.values()].sort((a,b)=>b.created_at.localeCompare(a.created_at)).slice(0,50).map(summary);
if(url==='/api/jobs'){
 requireWriter();
 const manifest=JSON.parse(options.body.get('manifest')),files=options.body.getAll('files');if(files.length<1||files.length>20||files.length!==manifest.recordings.length)throw new Error('每批需要1～20份对应录音。');if([...jobs.values()].filter(j=>['running','queued'].includes(j.status)).length>=3)throw new Error('已有3批测试排队，请等待完成。');if(files.reduce((s,f)=>s+f.size,0)>500*1024**2)throw new Error('每批最多500MB。');
 const job={...manifest,id:uid(),created_at:localDate(),status:'queued',recordings:[]},stored=[];
 for(let i=0;i<files.length;i++){const source=files[i],meta=manifest.recordings[i];if(!source.size||source.size>100*1024**2)throw new Error('每份录音需大于0且不超过100MB。');if(!meta.device?.trim()||!meta.scene?.trim())throw new Error('请填写设备和场景。');
 const row={...meta,id:uid(),filename:source.name,bytes:source.size,sha256:[...new Uint8Array(await crypto.subtle.digest('SHA-256',await source.arrayBuffer()))].map(v=>v.toString(16).padStart(2,'0')).join(''),status:'pending'};job.recordings.push(row);stored.push([key(job.id,row.id,'source'),source]);}
 await persist(job,stored);for(const [k,v]of stored)sources.set(k,v);jobs.set(job.id,job);queue.push(job.id);setTimeout(run,30);return {id:job.id,status:job.status};
}
const match=url.match(/^\/api\/jobs\/([a-f0-9]{32})(?:\/(refresh|retry))?$/);if(!match)throw new Error('不支持的浏览器操作。');const job=jobs.get(match[1]);if(!job)throw new Error('当前浏览器中没有这个测试。别人打开你的网址不会看到你的私人录音或报告。');
if(match[2]){requireWriter();if(['queued','running'].includes(job.status)||requeueing.has(job.id))throw new Error('本批测试仍在进行。');requeueing.add(job.id);try{const candidate=structuredClone(job);for(const row of candidate.recordings)if(match[2]==='refresh'||row.status!=='done'){if(!await file(job.id,row.id,'source'))throw new Error('原录音已不在浏览器中，请重新导入。');row.status='pending';if(row.result)row.result_stale=true;}candidate.status='queued';await persist(candidate);jobs.set(candidate.id,candidate);queue.push(candidate.id);setTimeout(run,30);return {id:candidate.id,status:'queued'};}finally{requeueing.delete(job.id);}}
await hydrate(job);return {...structuredClone(job),comparison:aggregate(job),method:METHOD};
}
export async function downloadReport(url){const m=url.match(/\/api\/jobs\/([a-f0-9]{32})\/export\/(html|csv|timeline-csv|json)$/);if(!m)throw new Error('导出类型无效。');const job=await browserAPI('/api/jobs/'+m[1]),out=reportFile(job,m[2]),blob=new Blob([out.content],{type:out.mime}),object=URL.createObjectURL(blob),a=document.createElement('a');a.href=object;a.download=out.filename;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(object),60000);}
window.addEventListener('beforeunload',e=>{if(running||queue.length){e.preventDefault();e.returnValue='';}});
