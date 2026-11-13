import test from 'node:test';
import assert from 'node:assert/strict';
import {transcribe,resetASR} from '../dist/asr.mjs';

class WorkerStub {
  static instances=[];
  constructor(url,options){this.url=String(url);this.options=options;WorkerStub.instances.push(this);}
  postMessage(data,transfers){this.request=data;this.transfers=transfers;}
  terminate(){this.terminated=true;}
  emit(data){this.onmessage({data:{id:this.request.id,...data}});}
}

test('adapter keeps caller audio intact and forwards progress/result with request IDs',async()=>{
  const original=globalThis.Worker;globalThis.Worker=WorkerStub;
  try{
    const samples=new Float32Array([.1,-.2,.3]);
    const messages=[];
    const pending=transcribe(samples,'zh',message=>messages.push(message));
    const worker=WorkerStub.instances.at(-1);
    assert.notEqual(worker.request.samples,samples);
    assert.deepEqual(worker.request.samples,samples);
    assert.equal(samples.length,3);
    assert.equal(worker.options.type,'module');
    worker.emit({type:'progress',message:'模型下载50%'});
    worker.emit({type:'result',result:{text:'测试',words:[]}});
    assert.deepEqual(await pending,{text:'测试',words:[]});
    assert.equal(messages.at(-1),'模型下载50%');
  }finally{resetASR();globalThis.Worker=original;}
});

test('failed initialization can be retried in a fresh worker',async()=>{
  const original=globalThis.Worker;globalThis.Worker=WorkerStub;
  try{
    const attempt=transcribe(new Float32Array([.2]));
    const failed=WorkerStub.instances.at(-1);
    failed.emit({type:'error',message:'模型校验失败'});
    await assert.rejects(attempt,/模型校验失败/);
    assert.equal(failed.terminated,true);
    const retry=transcribe(new Float32Array([.2]));
    const recovered=WorkerStub.instances.at(-1);
    assert.notEqual(recovered,failed);
    recovered.emit({type:'result',result:{text:'重试成功'}});
    assert.equal((await retry).text,'重试成功');
  }finally{resetASR();globalThis.Worker=original;}
});
