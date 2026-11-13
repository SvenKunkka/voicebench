import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {ASR_INFO} from '../dist/asr.mjs';

const root=new URL('../dist/',import.meta.url);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');

test('every self-hosted ASR asset is complete and fits the 25 MiB static asset limit',async()=>{
  const manifest=JSON.parse(await readFile(new URL('models/whisper/manifest.json',root),'utf8'));
  assert.equal(manifest.model,ASR_INFO.model);
  assert.equal(manifest.revision,ASR_INFO.revision);
  const weights=[];
  for(const item of manifest.files){
    const parts=[];
    for(const part of item.parts){
      const data=await readFile(new URL(part.path,root));
      assert.equal(data.length,part.bytes,part.path);
      assert.equal(hash(data),part.sha256,part.path);
      assert.ok(data.length<=25*1024*1024,part.path);
      parts.push(data);
    }
    const combined=Buffer.concat(parts);
    assert.equal(combined.length,item.bytes,item.file);
    assert.equal(hash(combined),item.sha256,item.file);
    if(item.file.endsWith('.onnx'))weights.push(item);
  }
  assert.equal(weights.reduce((n,item)=>n+item.bytes,0),ASR_INFO.modelBytes);
  assert.equal(weights.find(item=>item.file.includes('decoder')).parts.length,2);
});
