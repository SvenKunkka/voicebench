/** Browser-only ASR. Audio is copied to a local Worker, never to a remote API. */
export const ASR_INFO = Object.freeze({
  model: 'Xenova/whisper-tiny',
  revision: '5332fcc35e32a33b86612b9a57a89be7906102b1',
  transformersVersion: '3.8.1',
  sampleRate: 16000,
  modelBytes: 40852675,
  approximateFirstDownloadMiB: 64,
  note: '浏览器版使用 Whisper tiny q8，结果与桌面版 Whisper small 不可直接混合排名。',
});

let worker;
let nextId = 1;
const pending = new Map();

function progress(callback, message) {
  try { callback(message); } catch (error) { console.warn('ASR progress callback failed', error); }
}

function stopWorker(reason) {
  worker?.terminate();
  worker = undefined;
  for (const task of pending.values()) {
    clearTimeout(task.timeout);
    task.reject(new Error(reason));
  }
  pending.clear();
}

function getWorker() {
  if (worker) return worker;
  if (typeof Worker === 'undefined') throw new Error('当前浏览器不支持后台语音分析，请使用最新版 Chrome 或 Edge。');
  worker = new Worker(new URL('./asr-worker.mjs', import.meta.url), {type:'module', name:'voicebench-asr'});
  worker.onmessage = ({data}) => {
    const task = pending.get(data.id);
    if (!task) return;
    if (data.type === 'progress') { progress(task.onProgress, data.message); return; }
    clearTimeout(task.timeout);
    pending.delete(data.id);
    if (data.type === 'result') task.resolve(data.result);
    else task.reject(new Error(data.message || '浏览器语音识别失败，请重试。'));
    // A new Worker can retry an initialization/runtime failure. Persisted model
    // cache remains available; no recordings or user reference are in that cache.
    if (data.type === 'error' && !pending.size) { worker?.terminate(); worker = undefined; }
  };
  worker.onerror = event => { event.preventDefault(); stopWorker('语音分析模块加载失败，请检查模型下载网络后重试。'+(event.message||'')); };
  worker.onmessageerror = () => stopWorker('语音分析模块未能读取数据，请重新导入录音后重试。');
  return worker;
}

export async function transcribe(samples, language='zh', onProgress=()=>{}) {
  if (!(samples instanceof Float32Array) || !samples.length) throw new TypeError('语音识别需要非空的16 kHz单声道 Float32Array。');
  if (samples.length > ASR_INFO.sampleRate*600) throw new RangeError('浏览器语音识别每份最多10分钟，请先分段。');
  if (!['zh','en','auto'].includes(language)) throw new TypeError('语音语言仅支持 zh、en 或 auto。');
  for (let i=0;i<samples.length;i++) if (!Number.isFinite(samples[i])) throw new TypeError('录音包含无效采样，请重新导出音频。');
  const localWorker = getWorker();
  const id = nextId++;
  const audio = samples.slice(); // Keep the caller's samples usable for other metrics.
  progress(onProgress, '在浏览器后台准备语音识别；首次从本站下载约64 MiB（含约39 MiB模型权重），录音不会上传。');
  return new Promise((resolve,reject) => {
    const timeout = setTimeout(() => stopWorker('语音识别等待超过20分钟。请缩短录音，或检查模型下载网络后重试。'), 20*60*1000);
    pending.set(id,{resolve,reject,onProgress,timeout});
    try { localWorker.postMessage({type:'transcribe',id,samples:audio,language},[audio.buffer]); }
    catch (error) { clearTimeout(timeout); pending.delete(id); reject(error); }
  });
}

export function resetASR() { stopWorker('语音识别已重置，可以重新开始。'); }
