import * as library from './vendor/ebur128/ebur128_wasm_bg.js';
let ready;
async function init(){if(!ready)ready=(async()=>{const {instance}=await WebAssembly.instantiate(await(await fetch(new URL('./vendor/ebur128/ebur128_wasm_bg.wasm',import.meta.url))).arrayBuffer(),{'./ebur128_wasm_bg.js':library});library.__wbg_set_wasm(instance.exports);})();return ready;}
export async function measureLoudness(samples,sampleRate){await init();const lufs=library.ebur128_integrated_mono(sampleRate,samples),peak=library.ebur128_true_peak_mono(sampleRate,samples);return {integrated_lufs:Number.isFinite(lufs)?lufs:null,true_peak_dbtp:Number.isFinite(peak)?peak:null,loudness_range_lu:null,loudness_method:'ebur128-wasm 3.0.0 / Rust ebur128; 单声道 BS.1770/R128; 未计算 LRA'};}
