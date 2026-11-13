/** Pinned Transformers.js / ONNX WASM pipeline. No audio network requests. */
const TRANSFORMERS_VERSION = '3.8.1';
const MODEL = 'Xenova/whisper-tiny';
const REVISION = '5332fcc35e32a33b86612b9a57a89be7906102b1';
const TRANSFORMERS_URL = new URL('./vendor/transformers/transformers.min.js',import.meta.url).href;
const MODEL_ROOT = new URL('./models/whisper/',import.meta.url);
let manifestPromise;
let pipelinePromise;
let libraryPromise;
let emitProgress = ()=>{};
let lastProgress = 0;
let queue = Promise.resolve();

async function sha256(buffer) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',buffer))].map(v=>v.toString(16).padStart(2,'0')).join('');
}

async function modelManifest() {
  if(!manifestPromise)manifestPromise=fetch(new URL('manifest.json',MODEL_ROOT)).then(async response=>{
    if(!response.ok)throw new Error('本站语音模型清单未能加载。');
    const manifest=await response.json();
    if(manifest.model!==MODEL||manifest.revision!==REVISION)throw new Error('本站语音模型清单版本不匹配。');
    return manifest;
  }).catch(error=>{manifestPromise=undefined;throw error;});
  return manifestPromise;
}

async function localModelResponse(request) {
  const address=typeof request==='string'?request:request?.url;
  const prefix=new URL(REVISION+'/',MODEL_ROOT).href;
  if(!address?.startsWith(prefix))return undefined;
  const filename=decodeURIComponent(address.slice(prefix.length).split('?')[0]);
  const manifest=await modelManifest();
  const item=manifest.files.find(file=>file.kind==='model'&&file.file===filename);
  if(!item)return new Response('This model file is not included in the pinned bundle.',{status:404});
  let cache;
  try { cache=await caches.open('voicebench-asr-'+REVISION+'-v1'); } catch {}
  const cached=await cache?.match(address);
  if(cached){
    const bytes=await cached.arrayBuffer();
    if(bytes.byteLength===item.bytes&&await sha256(bytes)===item.sha256)return new Response(bytes,{headers:{'Content-Length':String(item.bytes)}});
    await cache.delete(address);
  }
  const parts=[];
  let loaded=0;
  for(const part of item.parts){
    const path=new URL('./'+part.path,import.meta.url);
    emitProgress(`从本站下载语音模型 ${filename}（${(loaded/1048576).toFixed(1)} / ${(item.bytes/1048576).toFixed(1)} MiB）`);
    const response=await fetch(path,{credentials:'same-origin'});
    if(!response.ok)throw new Error(`本站模型文件未能加载：${part.path}（${response.status}）`);
    const bytes=await response.arrayBuffer();
    if(bytes.byteLength!==part.bytes||await sha256(bytes)!==part.sha256)throw new Error('本站模型文件完整性校验失败，请清除本页缓存后重试。');
    loaded+=bytes.byteLength;parts.push(bytes);
  }
  const bytes=await new Blob(parts).arrayBuffer();
  if(bytes.byteLength!==item.bytes||await sha256(bytes)!==item.sha256)throw new Error('本站模型合并校验失败。');
  const response=new Response(bytes,{headers:{'Content-Length':String(item.bytes),'Content-Type':filename.endsWith('.json')?'application/json':'application/octet-stream'}});
  try{await cache?.put(address,response.clone());}catch{emitProgress('浏览器缓存空间不足，本次仍可继续分析；下次可能需要重新下载模型。');}
  return response;
}

async function getPipeline() {
  if (!libraryPromise) libraryPromise = import(TRANSFORMERS_URL).then(library => {
    library.env.allowLocalModels = false;
    library.env.remoteHost = MODEL_ROOT.href;
    library.env.remotePathTemplate = '{revision}/';
    library.env.useBrowserCache = false;
    library.env.useCustomCache = true;
    library.env.customCache = {match:localModelResponse,put:async()=>{}};
    library.env.backends.onnx.wasm.numThreads = 1;
    library.env.backends.onnx.wasm.proxy = false;
    library.env.backends.onnx.wasm.wasmPaths = new URL('./vendor/transformers/',import.meta.url).href;
    return library;
  });
  if (!pipelinePromise) pipelinePromise = libraryPromise.then(({pipeline}) => pipeline('automatic-speech-recognition', MODEL, {
    revision: REVISION, device:'wasm', dtype:'q8',
    progress_callback: value => {
      if (value.status==='progress' && Date.now()-lastProgress<250) return;
      lastProgress=Date.now();
      const percent=Number.isFinite(value.progress)?` ${value.progress.toFixed(1)}%`:'';
      const file=value.file?.split('/').pop()||'';
      emitProgress(value.status==='ready'?'语音模型已就绪':`准备语音模型 ${file}${percent}`.trim());
    },
  })).catch(error=>{pipelinePromise=undefined;libraryPromise=undefined;throw error;});
  return pipelinePromise;
}

/** Preserve actual model chunks. No evenly-spaced word/character timestamps. */
export function normalizeOutput(output, duration, timingMode='word') {
  const chunks = Array.isArray(output.chunks)?output.chunks:[];
  const timed = chunks.filter(chunk=>Array.isArray(chunk.timestamp)&&Number.isFinite(chunk.timestamp[0])&&Number.isFinite(chunk.timestamp[1])&&chunk.timestamp[0]>=0&&chunk.timestamp[1]>=chunk.timestamp[0])
    .map(chunk=>({text:String(chunk.text||''),start:chunk.timestamp[0],end:Math.min(duration,chunk.timestamp[1]),probability:null}))
    .filter(chunk=>chunk.start<=chunk.end&&chunk.start<=duration);
  const words = timingMode==='word'?timed:[];
  const missingTiming=chunks.length-timed.length;
  const segments = timed.map(chunk=>({start:chunk.start,end:chunk.end,text:chunk.text,...(timingMode==='word'?{words:[chunk]}:{})}));
  return {text:String(output.text||''),segments,words,
    engine:'Whisper tiny q8 · 浏览器 WASM',version:TRANSFORMERS_VERSION,
    settings:{model:MODEL,revision:REVISION,device:'wasm',dtype:'q8',num_threads:1,
      return_timestamps:timingMode==='word'?'word':true,chunk_length_s:30,stride_length_s:5,
      do_sample:false,reference_provided_to_model:false,audio_uploaded:false,
      timing_level:!timed.length?'unavailable':timingMode==='word'?'word_or_phrase':'segment',missing_timing_chunks:missingTiming},
    timing_note:(!timed.length?'模型未返回可靠的时间对齐，未生成字词时间。':timingMode==='word'?'Whisper模型对齐的字词或词组估计时间；没有伪造逐字时间，未提供词置信概率。':'当前模型仅返回真实段落时间，未生成字词时间。')+(missingTiming?` ${missingTiming} 个时间不完整的单元未用于定位。`:''),
  };
}

async function handle({id,samples,language}) {
  emitProgress=message=>self.postMessage({id,type:'progress',message});
  try {
    const transcriber=await getPipeline();
    emitProgress('语音模型已就绪，正在浏览器后台转写与对齐字词…');
    const options={task:'transcribe',return_timestamps:'word',chunk_length_s:30,stride_length_s:5,
      do_sample:false,max_new_tokens:448,
      ...(language==='auto'?{}:{language:language==='zh'?'chinese':'english'})};
    let output,timingMode='word';
    try { output=await transcriber(samples,options); }
    catch(error) {
      if(!/alignment|cross.?attention|word.*timestamp|token.*timestamp|timestamps.*not implemented/i.test(String(error?.message||error)))throw error;
      emitProgress('当前模型的字词对齐不可用，改为返回真实段落时间；不生成估算的逐字时间。');
      timingMode='segment';output=await transcriber(samples,{...options,return_timestamps:true});
    }
    const result=normalizeOutput(output,samples.length/16000,timingMode);
    result.settings.language=language;
    self.postMessage({id,type:'result',result});
  } catch(error) {
    self.postMessage({id,type:'error',message:'浏览器语音识别未完成：'+String(error?.message||error)+'。模型下载需要联网，录音不会上传；可以重试。'});
  }
}

if (typeof self!=='undefined' && typeof self.postMessage==='function') self.onmessage=({data})=>{
  if(data?.type!=='transcribe')return;
  queue=queue.then(()=>handle(data)).catch(error=>self.postMessage({id:data.id,type:'error',message:String(error)}));
};
