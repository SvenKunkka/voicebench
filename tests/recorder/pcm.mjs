import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import {wavHeader} from '../../app/static/recorder/wav.mjs';

// Feed the actual worklet implementation speech-like bursts, an exact second
// of silence, a missing input block, and a partial final block. Verify samples
// and timeline, rather than only that a file can be created.
let Processor;
const messages = [];
const sandbox = {
  AudioWorkletProcessor: class { constructor() { this.port = {postMessage:m=>messages.push(m)}; } },
  registerProcessor: (_name, cls) => {Processor=cls;},
};
vm.runInNewContext(fs.readFileSync(new URL('../../app/static/recorder/pcm-worklet.js',import.meta.url),'utf8'),sandbox);
const processor = new Processor();
const expected = [];
const rate = 48000;
for(let block=0;block<600;block++) {
  const data = new Float32Array(128);
  for(let i=0;i<128;i++) data[i] = block < 75 || block >=450 ? Math.sin((block*128+i)*2*Math.PI*440/rate)*0.6 : 0;
  const missing = block === 599;
  processor.process(missing ? [[]] : [[data]],[[new Float32Array(128)]]);
  for(const sample of data) { const x = missing?0:Math.max(-1,Math.min(1,sample)); expected.push(x<0?Math.round(x*32768):Math.round(x*32767)); }
}
processor.port.onmessage({data:'stop'});
const packets=messages.filter(m=>m.type==='pcm');
const frames = packets.reduce((n,m)=>n+m.frames,0);
assert.equal(frames,76800,'no silence removed');
assert.equal(packets.reduce((n,m)=>n+m.missing,0),128,'missing input accounted for');
assert.equal(messages.at(-1).type,'stopped','flush acknowledged');
const pcm=Buffer.concat(packets.map(m=>Buffer.from(m.buffer)));
assert.equal(pcm.length,frames*2);
for(let i=0;i<expected.length;i++) assert.equal(pcm.readInt16LE(i*2),expected[i] || 0);
const header=Buffer.from(wavHeader(frames,rate));
assert.equal(header.toString('ascii',0,4),'RIFF');assert.equal(header.readUInt32LE(4),pcm.length+36);
assert.equal(header.readUInt16LE(20),1);assert.equal(header.readUInt16LE(22),1);
assert.equal(header.readUInt32LE(24),48000);assert.equal(header.readUInt16LE(34),16);
assert.equal(header.readUInt32LE(40),pcm.length);
assert.throws(()=>wavHeader(0xffffffff,48000));
console.log('PASS: 76,800 PCM frames preserved; silence, missing input, final flush, WAV header, size limit.');
