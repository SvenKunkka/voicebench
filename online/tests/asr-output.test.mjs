import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeOutput} from '../dist/asr-worker.mjs';
import {transcribe,ASR_INFO} from '../dist/asr.mjs';

test('real model chunk boundaries are preserved, including Chinese phrases and zero duration',()=>{
  const result=normalizeOutput({text:'这是测试',chunks:[{text:'这是',timestamp:[0.12,0.73]},{text:'测',timestamp:[0.73,0.73]},{text:'试',timestamp:[0.73,1.08]}]},2);
  assert.deepEqual(result.words,[{text:'这是',start:.12,end:.73,probability:null},{text:'测',start:.73,end:.73,probability:null},{text:'试',start:.73,end:1.08,probability:null}]);
  assert.equal(result.segments.length,3);
  assert.equal(result.settings.audio_uploaded,false);
  assert.equal(result.settings.reference_provided_to_model,false);
});

test('segment fallback never invents word positions',()=>{
  const result=normalizeOutput({text:'一整句话',chunks:[{text:'一整句话',timestamp:[1.2,4.8]}]},5,'segment');
  assert.deepEqual(result.words,[]);
  assert.deepEqual(result.segments,[{text:'一整句话',start:1.2,end:4.8}]);
  assert.equal(result.settings.timing_level,'segment');
});

test('invalid or missing timestamps are not evenly filled or marked as actual words',()=>{
  const result=normalizeOutput({text:'不确定',chunks:[{text:'不',timestamp:[null,1]},{text:'确',timestamp:[1,null]},{text:'定',timestamp:[3,2]}]},4);
  assert.deepEqual(result.words,[]);
  assert.equal(result.settings.timing_level,'unavailable');
  assert.equal(result.settings.missing_timing_chunks,3);
});

test('boundary beyond physical duration is clipped, never extrapolated',()=>{
  const result=normalizeOutput({text:'结束',chunks:[{text:'结',timestamp:[1,2]},{text:'束',timestamp:[3,4]}]},1.5);
  assert.deepEqual(result.words,[{text:'结',start:1,end:1.5,probability:null}]);
});

test('invalid audio and language fail before creating a browser worker',async()=>{
  await assert.rejects(transcribe(new Float32Array()),/非空/);
  await assert.rejects(transcribe(new Float32Array([NaN])),/无效采样/);
  await assert.rejects(transcribe(new Float32Array([.2]),'unknown'),/zh、en/);
  assert.equal(ASR_INFO.transformersVersion,'3.8.1');
});
