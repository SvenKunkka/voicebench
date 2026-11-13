// VoiceBench browser audio measurements. Source measurements precede resampling.
import {measureLoudness} from './loudness.mjs';
const db=value=>value>0?20*Math.log10(value):null;
const round=(value,n=3)=>Number(value.toFixed(n));
function validateShape(rate,channels,frames){
  if(!Number.isInteger(rate)||rate<=0||rate>192000||!Number.isInteger(channels)||channels<1||channels>8)throw new Error('最多支持 8 声道、192 kHz 的有效音频。');
  if(!Number.isInteger(frames)||frames<1||frames/rate>600)throw new Error('每份录音需要在 0～10 分钟之间；请先分段。');
  if(frames*channels>60_000_000)throw new Error('这份高采样率或多声道录音解码后过大，请先缩短或导出需要的声道。');
}
const tag=(view,offset)=>String.fromCharCode(...Array.from({length:4},(_,i)=>view.getUint8(offset+i)));
export function decodeNativeWav(buffer){
  const view=new DataView(buffer);
  if(view.byteLength<12||tag(view,0)!=='RIFF'||tag(view,8)!=='WAVE')return null;
  let fmt=null,data=null;
  for(let offset=12;offset+8<=view.byteLength;){
    const kind=tag(view,offset),size=view.getUint32(offset+4,true),start=offset+8;
    if(start+size>view.byteLength)throw new Error('WAV 文件内容不完整，不能可靠检查采样。');
    if(kind==='fmt '){
      if(size<16)throw new Error('WAV 格式信息不完整。');
      let format=view.getUint16(start,true);const channels=view.getUint16(start+2,true),rate=view.getUint32(start+4,true),block=view.getUint16(start+12,true),bits=view.getUint16(start+14,true);
      if(format===65534){if(size<40)throw new Error('WAV 扩展格式信息不完整。');format=view.getUint16(start+24,true);}
      fmt={format,channels,rate,block,bits};
    }
    if(kind==='data'&&!data)data={start,size};
    offset=start+size+(size%2);
  }
  if(!fmt||!data)throw new Error('WAV 缺少格式或采样数据。');
  if(![1,3].includes(fmt.format))return null;
  const {format,channels,rate,block,bits}=fmt,bytes=bits/8;
  if(!Number.isInteger(bytes)||block!==bytes*channels||!(format===1?[8,16,24,32]:[32,64]).includes(bits))throw new Error('不支持这份 WAV 的采样编码。');
  if(data.size%block)throw new Error('WAV 的最后一帧不完整，请重新导出。');
  const frames=data.size/block;validateShape(rate,channels,frames);
  const planes=Array.from({length:channels},()=>new Float32Array(frames));
  for(let frame=0;frame<frames;frame++)for(let channel=0;channel<channels;channel++){
    const at=data.start+frame*block+channel*bytes;let value;
    if(format===3)value=bits===32?view.getFloat32(at,true):view.getFloat64(at,true);
    else if(bits===8)value=(view.getUint8(at)-128)/128;
    else if(bits===16)value=view.getInt16(at,true)/32768;
    else if(bits===24){let raw=view.getUint8(at)|(view.getUint8(at+1)<<8)|(view.getUint8(at+2)<<16);if(raw&0x800000)raw-=0x1000000;value=raw/8388608;}
    else value=view.getInt32(at,true)/2147483648;
    if(!Number.isFinite(value))throw new Error('音频包含无效采样值。');
    planes[channel][frame]=value;
    if(!Number.isFinite(planes[channel][frame]))throw new Error('采样值超出浏览器分析范围。');
  }
  return{planes,sampleRate:rate,frames,codec:format===3?`pcm_f${bits}le`:`pcm_${bits===8?'u8':`s${bits}le`}`,native:true,bits};
}
async function decodeAudio(buffer){
  const native=decodeNativeWav(buffer);if(native)return native;
  const Context=globalThis.AudioContext||globalThis.webkitAudioContext;
  if(!Context)throw new Error('浏览器不能解码此音频格式，请改用标准 PCM WAV。');
  const context=new Context();
  try{
    const decoded=await context.decodeAudioData(buffer.slice(0));
    validateShape(decoded.sampleRate,decoded.numberOfChannels,decoded.length);
    const planes=Array.from({length:decoded.numberOfChannels},(_,i)=>decoded.getChannelData(i).slice());
    if(planes.some(plane=>plane.some(value=>!Number.isFinite(value))))throw new Error('音频包含无效采样值。');
    return{planes,sampleRate:decoded.sampleRate,frames:decoded.length,codec:'browser-decoded',native:false,bits:null};
  }catch(error){throw new Error(`无法解码音频，请检查文件是否完整，或改用 PCM WAV。${error.message||''}`);}
  finally{await context.close();}
}
export function resampleMono(input,rate,target=16000){
  if(rate===target)return input.slice();
  // Windowed-sinc anti-aliasing fallback. Browser normally uses OfflineAudioContext.
  const output=new Float32Array(Math.max(1,Math.round(input.length*target/rate)));
  const cutoff=Math.min(1,target/rate)*.94,radius=Math.ceil(16/cutoff),kernels=new Map();
  for(let i=0;i<output.length;i++){
    const position=i*rate/target,center=Math.floor(position),phase=Math.round((position-center)*1024);
    let weights=kernels.get(phase);
    if(!weights){weights=new Float64Array(radius*2+1);for(let k=-radius;k<=radius;k++){
      const distance=k-phase/1024,scaled=distance*cutoff;
      weights[k+radius]=Math.abs(distance)<=radius?(Math.abs(scaled)<1e-12?1:Math.sin(Math.PI*scaled)/(Math.PI*scaled))*(.5+.5*Math.cos(Math.PI*distance/radius)):0;
    }kernels.set(phase,weights);}
    let value=0,sum=0;
    for(let k=-radius;k<=radius;k++){const index=center+k;if(index<0||index>=input.length)continue;const weight=weights[k+radius];value+=input[index]*weight;sum+=weight;}
    output[i]=sum?value/sum:0;
  }
  return output;
}
async function analysisSamples(input,rate){
  if(rate===16000)return{samples:input.slice(),method:'无需重采样'};
  const Offline=globalThis.OfflineAudioContext||globalThis.webkitOfflineAudioContext;
  if(Offline&&rate>=3000){
    const context=new Offline(1,Math.max(1,Math.round(input.length*16000/rate)),16000);
    const buffer=context.createBuffer(1,input.length,rate);buffer.copyToChannel(input,0);
    const source=context.createBufferSource();source.buffer=buffer;source.connect(context.destination);source.start();
    const result=await context.startRendering();return{samples:result.getChannelData(0).slice(),method:'Web Audio OfflineAudioContext 带限重采样'};
  }
  return{samples:resampleMono(input,rate),method:'窗函数 sinc 带限重采样（1024 相位量化）'};
}
export function pcmWav(samples,sampleRate=16000,gain=1){
  const bytes=new ArrayBuffer(44+samples.length*2),view=new DataView(bytes);
  const write=(offset,text)=>{for(let i=0;i<text.length;i++)view.setUint8(offset+i,text.charCodeAt(i));};
  write(0,'RIFF');view.setUint32(4,36+samples.length*2,true);write(8,'WAVE');write(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,sampleRate,true);view.setUint32(28,sampleRate*2,true);view.setUint16(32,2,true);view.setUint16(34,16,true);write(36,'data');view.setUint32(40,samples.length*2,true);
  for(let i=0;i<samples.length;i++){const value=Math.max(-1,Math.min(1,samples[i]*gain));view.setInt16(44+i*2,Math.round(value*(value<0?32768:32767)),true);}
  return new Blob([bytes],{type:'audio/wav'});
}
function spectrum(samples){
  const n=1024;if(samples.length<n)return[];
  const sum=new Float64Array(n/2+1),window=Float64Array.from({length:n},(_,i)=>.5-.5*Math.cos(2*Math.PI*i/n));
  const scale=16000*window.reduce((acc,value)=>acc+value*value,0);let windows=0;
  for(let offset=0;offset+n<=samples.length;offset+=n/2){
    const real=new Float64Array(n),imag=new Float64Array(n);let mean=0;
    for(let i=0;i<n;i++)mean+=samples[offset+i];mean/=n;
    for(let i=0;i<n;i++)real[i]=(samples[offset+i]-mean)*window[i];
    for(let i=1,j=0;i<n;i++){let bit=n>>1;for(;j&bit;bit>>=1)j^=bit;j^=bit;if(i<j){[real[i],real[j]]=[real[j],real[i]];}}
    for(let size=2;size<=n;size*=2){const half=size/2,angle=-2*Math.PI/size;for(let start=0;start<n;start+=size)for(let k=0;k<half;k++){
      const wr=Math.cos(angle*k),wi=Math.sin(angle*k),right=start+k+half,left=start+k,tr=wr*real[right]-wi*imag[right],ti=wr*imag[right]+wi*real[right];real[right]=real[left]-tr;imag[right]=imag[left]-ti;real[left]+=tr;imag[left]+=ti;
    }}
    for(let bin=0;bin<=n/2;bin++)sum[bin]+=(real[bin]**2+imag[bin]**2)/scale*(bin&&bin!==n/2?2:1);
    windows++;
  }
  return Array.from({length:64},(_,i)=>{const a=80*(7900/80)**(i/64),b=80*(7900/80)**((i+1)/64);let total=0,count=0;for(let bin=Math.ceil(a*n/16000);bin<n/2&&bin*16000/n<b;bin++){total+=sum[bin]/windows;count++;}return{hz:Math.sqrt(a*b),db:10*Math.log10(Math.max(count?total/count:0,1e-15))};});
}
export async function inspectAudio(file,channel='first'){
  if(!file||typeof file.arrayBuffer!=='function'||file.size===0)throw new Error('音频文件为空或无法读取。');
  if(file.size>100*1024*1024)throw new Error('每份录音最多 100 MB，请先分段。');
  if(!['first','second','mix'].includes(channel))throw new Error('请选择第一声道、第二声道或声道混合。');
  const decoded=await decodeAudio(await file.arrayBuffer()),{planes,sampleRate,frames}=decoded;
  if(channel==='second'&&planes.length<2)throw new Error('已选择第二声道，但这份录音只有一个声道。');
  const selected=channel==='mix'?Float32Array.from({length:frames},(_,i)=>planes.reduce((sum,plane)=>sum+plane[i],0)/planes.length):planes[channel==='second'?1:0];
  let peak=0,squares=0,near=0,start=-1;const clipping=[];
  for(let i=0;i<frames;i++){const value=Math.abs(selected[i]);peak=Math.max(peak,value);squares+=value*value;if(value>=.999){near++;if(start<0)start=i;}else if(start>=0){if(i-start>=3)clipping.push({start:round(start/sampleRate),end:round(i/sampleRate)});start=-1;}}
  if(start>=0&&frames-start>=3)clipping.push({start:round(start/sampleRate),end:round(frames/sampleRate)});
  const rms=Math.sqrt(squares/frames),duration=frames/sampleRate,warnings=[];
  if(!decoded.native)warnings.push('此格式由 Web Audio 解码，浏览器可能已重采样。电平和疑似削波检查基于解码后采样，不能证明编码前的原采样率或原始削波。');
  if(clipping.length)warnings.push(`发现 ${clipping.length} 处连续接近满刻度的采样，疑似削波，需回听确认。`);
  if(peak>1)warnings.push('源浮点采样超过数字满刻度，16 kHz PCM16 试听副本会被限幅；原始电平测量使用未限幅采样。');
  if(peak<1e-5)warnings.push('录音接近数字静音，无法评价有效人声质量。');
  const {samples,method}=await analysisSamples(selected,sampleRate),energyFrames=Math.floor(samples.length/320)||1;let quietCount=0,quietStart=-1;const quietEvents=[];
  for(let frame=0;frame<energyFrames;frame++){
    let power=0;const begin=frame*320,end=Math.min(samples.length,begin+320);for(let i=begin;i<end;i++)power+=samples[i]**2;
    const quiet=Math.sqrt(power/Math.max(1,end-begin))<10**(-50/20);if(quiet){quietCount++;if(quietStart<0)quietStart=frame;}else if(quietStart>=0){if(frame-quietStart>=25)quietEvents.push({start:round(quietStart*.02,2),end:round(frame*.02,2)});quietStart=-1;}
  }
  if(quietStart>=0&&energyFrames-quietStart>=25)quietEvents.push({start:round(quietStart*.02,2),end:round(energyFrames*.02,2)});
  const waveform=[];for(let bucket=0,count=Math.min(400,samples.length);bucket<count;bucket++){let value=0;for(let i=Math.floor(bucket*samples.length/count);i<Math.floor((bucket+1)*samples.length/count);i++)value=Math.max(value,Math.abs(samples[i]));waveform.push(value);}
  if(planes.length>1){
    if(channel==='mix'){let maximumRms=0;for(const plane of planes){let power=0;for(const value of plane)power+=value*value;maximumRms=Math.max(maximumRms,Math.sqrt(power/frames));}if(rms<maximumRms*.3)warnings.push('混合后能量明显下降，可能存在声道反相；建议分别分析声道。');}
    warnings.push(`源文件为 ${planes.length} 声道，本次使用${channel==='mix'?'所有声道平均混合':channel==='second'?'第 2 声道':'第 1 声道'}。`);
  }
  let loudness={integrated_lufs:null,true_peak_dbtp:null,loudness_range_lu:null,loudness_method:'未测'};
  try{loudness=await measureLoudness(selected,sampleRate);}catch(error){warnings.push(`响度与真峰值未测得：${error.message||'本地浏览器测量模块未就绪'}。没有以采样峰值替代真峰值。`);}
  let monoPeak=0,monoPower=0;for(const value of samples){monoPeak=Math.max(monoPeak,Math.abs(value));monoPower+=value*value;}
  const monoRms=Math.sqrt(monoPower/samples.length),gain=monoPeak>1e-5?Math.min(10**(-23/20)/Math.max(monoRms,1e-12),.95/monoPeak):1;
  const audio={duration,sample_rate:sampleRate,source_sample_rate:decoded.native?sampleRate:null,channels:planes.length,channel_selection:channel==='mix'?'所有声道平均混合':channel==='second'?'第 2 声道':'第 1 声道',codec:decoded.codec,
    sample_peak_dbfs:db(peak),rms_dbfs:db(rms),near_full_scale_percent:near/frames*100,clipping_events:clipping.slice(0,100),low_energy_percent:quietCount/energyFrames*100,low_energy_events:quietEvents.slice(0,100),waveform,spectrum:spectrum(samples),warnings,digital_silence:peak<1e-5,
    ...loudness,native_rate_preserved:decoded.native,decode_method:decoded.native?'原生 WAV 采样解码':'Web Audio decodeAudioData',resample_method:method,preview_gain_db:20*Math.log10(gain),preview_note:'固定增益匹配 RMS 至 -23 dBFS；采样峰值保留余量时可能达不到目标。不是 LUFS 等响或降噪。'};
  return{audio,samples,original:pcmWav(samples),matched:pcmWav(samples,16000,gain)};
}
