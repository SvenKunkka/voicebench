// DNSMOS P.835 non-personalized model/calibration adapted from Microsoft DNS-Challenge.
// CC BY 4.0; fixed upstream and model hash are recorded in models/dnsmos-manifest.json.
import * as ort from './vendor/ort/ort.wasm.min.mjs';
ort.env.wasm.numThreads=1;
ort.env.wasm.wasmPaths=new URL('./vendor/ort/',import.meta.url).href;
let loading;
async function session(){
 if(!loading) loading=(async()=>{
  const response=await fetch(new URL('./models/sig_bak_ovr.onnx',import.meta.url));if(!response.ok)throw new Error('音质模型下载失败，请重试。');
  const data=await response.arrayBuffer(),hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',data))].map(v=>v.toString(16).padStart(2,'0')).join('');
  if(hash!=='269fbebdb513aa23cddfbb593542ecc540284a91849ac50516870e1ac78f6edd')throw new Error('音质模型校验未通过。');
  return ort.InferenceSession.create(data,{executionProviders:['wasm'],graphOptimizationLevel:'all'});
 })().catch(e=>{loading=null;throw e;});
 return loading;
}
const poly=(a,b,c,x)=>(a*x+b)*x+c;
export async function scoreMOS(samples,onProgress=()=>{}){
 let peak=0;for(const x of samples)peak=Math.max(peak,Math.abs(x));if(!samples.length||peak<1e-5)return {available:false,reason:'接近数字静音，不计算人声质量。'};
 onProgress('准备音质模型…');const model=await session(),repeated=samples.length<144160;
 let input=samples;while(input.length<144160){const v=new Float32Array(input.length*2);v.set(input);v.set(input,input.length);input=v;}
 const hops=Math.trunc(Math.floor(input.length/16000)-9.01)+1,windows=[];
 for(let i=0;i<hops;i++){
  onProgress(`预测人声与背景质量 ${i+1}/${hops}`);
  const result=await model.run({[model.inputNames[0]]:new ort.Tensor('float32',input.slice(i*16000,i*16000+144160),[1,144160])});
  const [sig,bak,ovr]=result[model.outputNames[0]].data;
  windows.push({start:i,signal:poly(-.08397278,1.22083953,.0052439,sig),background:poly(-.13166888,1.60915514,-.39604546,bak),overall:poly(-.06766283,1.11546468,.04602535,ovr)});
 }
 const mean=k=>windows.reduce((s,w)=>s+w[k],0)/windows.length;
 return {available:true,signal:mean('signal'),background:mean('background'),overall:mean('overall'),windows,repeated_short_audio:repeated,model_sha256:'269fbebdb513aa23cddfbb593542ecc540284a91849ac50516870e1ac78f6edd',note:'DNSMOS P.835 模型预测，通常按1～5分解读；不是人工听懂率。'};
}
