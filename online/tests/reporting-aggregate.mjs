import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {aggregate} from '../dist/reporting.mjs';
import {normalize} from '../dist/text-metrics.mjs';

function row(device,reference,scene,cer,mos=3.5,status='done',id=device+reference+scene+cer){
  return {id,device,reference,scene,status,filename:id+'.wav',result:{
    text:{cer,content_score:cer===null?null:Math.max(0,100*(1-cer)),keyword_accuracy:cer===null?null:.5},
    mos:{available:true,overall:mos,signal:mos+.1,background:mos+.2},
    audio:{integrated_lufs:-30,rms_dbfs:-32,true_peak_dbtp:-10,near_full_scale_percent:0}}};
}
test('scene/reference groups and repeated measurements retain Python summary schema',()=>{
  const job={conditions_confirmed:true,recordings:[row('A','你好','quiet',.1,3.5),row('A','你好','quiet',.3,3.3),row('B','你好','quiet',.4,3),row('B','其他','quiet',0,4),row('B','你好','noise',0,4)]};
  const result=aggregate(job),group=result.groups.find(item=>item.scene==='quiet'&&item.devices.length===2);
  assert.equal(result.groups.length,3);assert.equal(result.quality_groups.length,2);
  const a=group.devices[0];assert.equal(a.n,2);assert.equal(a.cer_mean,.2);assert.equal(a.cer_min,.1);assert.equal(a.cer_max,.3);
  assert.ok(Math.abs(a.cer_sd-Math.sqrt(.02))<1e-12);assert.equal(a.mos_mean,3.4);
  assert.deepEqual(a.recording_ids,job.recordings.slice(0,2).map(item=>item.id));
  assert.deepEqual(Object.keys(a).sort(),['device','n','cer_n','cer_mean','cer_min','cer_max','cer_sd','mos_mean','mos_min','mos_max','mos_n','signal_mean','background_mean','signal_min','signal_max','background_min','background_max','lufs_mean','rms_mean','true_peak_max','clipping_percent_mean','keyword_mean','content_score','recording_ids'].sort());
  assert.equal(result.quality_groups[0].reference_status,'different_references');
  assert.ok(result.quality_groups[0].devices.every(item=>item.cer_n===0&&item.cer_mean===null&&item.content_score===null));
});
test('no-reference quality stays available without fabricated content scores or hardware winner',()=>{
  const result=aggregate({recordings:[row('A','','near',null,3.4),row('B','','near',null,2.1)]});
  assert.deepEqual(result.groups,[]);const group=result.quality_groups[0];
  assert.equal(group.reference_status,'no_reference');assert.equal(group.leading_device,'A');
  assert.match(group.decision,/不是硬件优胜/);assert.ok(group.caveats.some(value=>value.includes('未经确认')));
  assert.ok(group.devices.every(item=>item.cer_mean===null&&item.content_score===null));
  assert.equal(group.devices[0].rms_mean,-32);assert.equal(group.devices[0].clipping_percent_mean,0);
});
test('unavailable, missing and non-finite MOS values are never zero or a winning complete group',()=>{
  const a=row('A','你好','near',0,3.4),b=row('B','你好','near',.2,2.1);
  b.result.mos={available:false,overall:9,signal:9,background:9};
  let group=aggregate({conditions_confirmed:true,recordings:[a,b]}).quality_groups[0];
  assert.equal(group.leading_device,null);assert.equal(group.devices[1].mos_mean,null);assert.equal(group.devices[1].mos_n,0);
  assert.match(group.decision,/没有有效质量预测/);
  b.result.mos={available:true,overall:NaN,signal:Infinity};
  group=aggregate({recordings:[a,b]}).quality_groups[0];assert.equal(group.devices[1].mos_mean,null);
});
test('condition and completion guards prevent a reference-based winner',()=>{
  const recordings=[row('A','你好','quiet',0,4),row('B','你好','quiet',.2,3)];
  assert.match(aggregate({recordings,conditions_confirmed:false}).groups[0].decision,/不能据此判定/);
  recordings.push(row('C','你好','quiet',0,5,'failed'));
  const result=aggregate({recordings,conditions_confirmed:true});
  assert.equal(result.completed,2);assert.equal(result.failed,1);assert.match(result.groups[0].decision,/部分结果/);
  assert.equal(result.quality_groups[0].leading_device,null);
});
test('mixed references do not pool CER and normalization does not equate spoken digits',()=>{
  const result=aggregate({recordings:[row('A','你好！','same',.1,4),row('B',' 你好 ','same',.2,3),row('C','','same',null,3)]});
  assert.equal(result.groups.length,1);assert.equal(result.groups[0].devices.length,2);
  assert.equal(result.quality_groups[0].reference_status,'mixed_references');
  assert.ok(result.quality_groups[0].devices.every(item=>item.cer_n===0));
  assert.equal(aggregate({recordings:[row('A','十五','same',0),row('B','15','same',0)]}).groups.length,2);
});
test('reference identifiers are exact UTF-8 SHA-256 prefixes and Unicode previews match Python',()=>{
  for(const reference of ['你好','abc'.repeat(100),'𠀀'.repeat(80),'繁體測試ＡＢＣ123']){
    const normalized=normalize(reference),group=aggregate({recordings:[row('A',reference,'one',0)]}).groups[0];
    assert.equal(group.reference_hash,createHash('sha256').update(normalized).digest('hex').slice(0,12));
    assert.equal(group.reference_preview,Array.from(normalized).slice(0,70).join(''));
  }
});
test('untrusted map keys do not collide and inputs are not mutated',()=>{
  const job={recordings:[row('__proto__','你好','constructor',0),row('constructor','你好','__proto__',0)]};
  const original=JSON.stringify(job);assert.equal(aggregate(job).quality_groups.length,2);assert.equal(JSON.stringify(job),original);
  assert.deepEqual(aggregate({recordings:[]}),{groups:[],quality_groups:[],completed:0,failed:0,note:'音质按场景比较；字错率只比较相同非空原稿。不同文案或未经控制的录音不生成硬件总排名。'});
});
