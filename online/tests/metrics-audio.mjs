import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {inspectAudio,decodeNativeWav,pcmWav,resampleMono} from '../dist/audio-metrics.mjs';
const originalFetch=globalThis.fetch;
globalThis.fetch=async input=>{const url=new URL(input);assert.equal(url.protocol,'file:','tests never upload or call an external service');return new Response(await fs.readFile(url));};
const tone=(duration=1,rate=16000,hz=1000,amplitude=.1)=>Float32Array.from({length:Math.round(duration*rate)},(_,i)=>amplitude*Math.sin(2*Math.PI*hz*i/rate));
function wave(planes,rate,bits=16,format=1){const frames=planes[0].length,channels=planes.length,bytes=bits/8,buffer=new ArrayBuffer(44+frames*channels*bytes),v=new DataView(buffer),str=(at,s)=>{for(let i=0;i<s.length;i++)v.setUint8(at+i,s.charCodeAt(i));};str(0,'RIFF');v.setUint32(4,buffer.byteLength-8,true);str(8,'WAVE');str(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,format,true);v.setUint16(22,channels,true);v.setUint32(24,rate,true);v.setUint32(28,rate*channels*bytes,true);v.setUint16(32,channels*bytes,true);v.setUint16(34,bits,true);str(36,'data');v.setUint32(40,frames*channels*bytes,true);
for(let frame=0;frame<frames;frame++)for(let channel=0;channel<channels;channel++){const at=44+(frame*channels+channel)*bytes,value=planes[channel][frame];if(format===3){if(bits===32)v.setFloat32(at,value,true);else v.setFloat64(at,value,true);}else if(bits===8)v.setUint8(at,Math.max(0,Math.min(255,Math.round(value*128+128))));else if(bits===16)v.setInt16(at,Math.max(-32768,Math.min(32767,Math.round(value*32768))),true);else if(bits===24){let raw=Math.max(-8388608,Math.min(8388607,Math.round(value*8388608)));v.setUint8(at,raw&255);v.setUint8(at+1,(raw>>8)&255);v.setUint8(at+2,(raw>>16)&255);}else v.setInt32(at,Math.max(-2147483648,Math.min(2147483647,Math.round(value*2147483648))),true);}
return new Blob([buffer],{type:'audio/wav'});}
let result=await inspectAudio(wave([tone()],16000));
assert.equal(result.audio.sample_rate,16000);assert.equal(result.audio.duration,1);assert.equal(result.audio.native_rate_preserved,true);assert.equal(result.samples.length,16000);assert.equal(result.original.size,32044);assert.equal(result.matched.type,'audio/wav');
assert.ok(Math.abs(result.audio.sample_peak_dbfs+20)<.01);assert.ok(Math.abs(result.audio.rms_dbfs+23.0103)<.01);assert.equal(result.audio.near_full_scale_percent,0);assert.equal(result.audio.clipping_events.length,0);assert.equal(result.audio.spectrum.length,64);
const matched=decodeNativeWav(await result.matched.arrayBuffer()).planes[0];let power=0;for(const value of matched)power+=value*value;assert.ok(Math.abs(20*Math.log10(Math.sqrt(power/matched.length))+23)<.01);
const clipped=new Float32Array(16000);clipped.fill(1,100,150);result=await inspectAudio(wave([clipped],16000));assert.equal(result.audio.near_full_scale_percent,50/16000*100);assert.equal(result.audio.clipping_events.length,1);assert.equal(result.audio.clipping_events[0].start,.006);
result=await inspectAudio(wave([new Float32Array(16000)],16000));assert.equal(result.audio.digital_silence,true);assert.equal(result.audio.sample_peak_dbfs,null);assert.equal(result.audio.rms_dbfs,null);assert.equal(result.audio.low_energy_percent,100);assert.equal(result.audio.preview_gain_db,0);assert.equal(result.audio.integrated_lufs,null);
await assert.rejects(()=>inspectAudio(wave([tone()],16000),'second'),/第二声道/);
const first=tone(),second=Float32Array.from(first,value=>-value);result=await inspectAudio(wave([first,second],16000),'mix');assert.equal(result.audio.digital_silence,true);assert.ok(result.audio.warnings.some(warning=>warning.includes('反相')));
result=await inspectAudio(wave([first,Float32Array.from(first,value=>value*.5)],16000),'second');assert.ok(Math.abs(result.audio.sample_peak_dbfs+26.02)<.02);assert.equal(result.audio.channels,2);
for(const [bits,format] of [[8,1],[24,1],[32,1],[32,3],[64,3]]){const decoded=decodeNativeWav(await wave([tone(.1)],16000,bits,format).arrayBuffer());assert.equal(decoded.sampleRate,16000);assert.equal(decoded.frames,1600);assert.ok(Math.abs(decoded.planes[0][4]-.1)<(bits===8?.008:.0001));}
assert.equal(decodeNativeWav(new ArrayBuffer(0)),null); // non-WAV is delegated to Web Audio, not guessed
await assert.rejects(()=>inspectAudio(new Blob([])),/为空/);
await assert.rejects(()=>inspectAudio({size:101*1024*1024,arrayBuffer:async()=>new ArrayBuffer(0)}),/100 MB/);
await assert.rejects(()=>inspectAudio(wave([tone()],16000),'invalid'),/声道/);
await assert.rejects(()=>inspectAudio(wave([tone(.1)],192001)),/192 kHz/);
await assert.rejects(()=>inspectAudio(wave([Float32Array.of(NaN)],16000,32,3)),/无效/);
await assert.rejects(()=>inspectAudio(wave([[1e300]],16000,64,3)),/超出/);
const short=await wave([tone(.1)],16000).arrayBuffer();assert.throws(()=>decodeNativeWav(short.slice(0,short.byteLength-1)),/不完整/);
const filtered=resampleMono(tone(.3,48000,12000),48000);let alias=0;for(const value of filtered.slice(100,-100))alias+=value*value;assert.ok(Math.sqrt(alias/(filtered.length-200))<.001,'anti-aliasing suppresses out-of-band 12 kHz before 16 kHz analysis');
const originalContext=globalThis.AudioContext;let closeCalls=0;
globalThis.AudioContext=class{async decodeAudioData(){return{sampleRate:16000,numberOfChannels:1,length:16000,getChannelData:()=>tone()};}async close(){closeCalls++;}};
result=await inspectAudio(new Blob(['compressed-format-placeholder']));assert.equal(result.audio.native_rate_preserved,false);assert.equal(result.audio.source_sample_rate,null);assert.equal(closeCalls,1);assert.ok(result.audio.warnings.some(warning=>warning.includes('可能已重采样')));globalThis.AudioContext=originalContext;
const fixture=wave([tone(10,48000,440)],48000);result=await inspectAudio(fixture);
assert.equal(result.samples.length,160000);assert.equal(result.audio.sample_rate,48000);assert.equal(result.audio.loudness_range_lu,null,'LRA remains unmeasured');assert.ok(Number.isFinite(result.audio.integrated_lufs));assert.ok(Number.isFinite(result.audio.true_peak_dbtp));
const ffmpeg=spawnSync('ffmpeg',['-hide_banner','-i','pipe:0','-af','loudnorm=I=-23:TP=-1:LRA=7:print_format=json','-f','null','-'],{input:Buffer.from(await fixture.arrayBuffer()),maxBuffer:1024*1024});
assert.equal(ffmpeg.status,0,ffmpeg.stderr.toString());const log=ffmpeg.stderr.toString(),fragment=log.slice(log.lastIndexOf('{')),reference=JSON.parse(fragment.slice(0,fragment.indexOf('}')+1));
const deltaLU=result.audio.integrated_lufs-Number(reference.input_i),deltaTP=result.audio.true_peak_dbtp-Number(reference.input_tp);assert.ok(Math.abs(deltaLU)<.12,`LUFS differs ${deltaLU}`);assert.ok(Math.abs(deltaTP)<.08,`true peak differs ${deltaTP}`);
assert.ok(!JSON.stringify(result.audio).includes('NaN'));globalThis.fetch=originalFetch;
console.log(`PASS audio metrics: PCM8/16/24/32,float32/64 native WAV; RMS/peak/clipping/silence/channels; valid WAV previews and RMS matching; bandlimited resample; browser-decode disclosure; limits/corrupt values; real ebur128-WASM vs FFmpeg ΔLU=${deltaLU.toFixed(4)}, ΔTP=${deltaTP.toFixed(4)} dB.`);
