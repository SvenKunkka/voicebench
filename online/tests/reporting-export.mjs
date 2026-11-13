import test from 'node:test';
import assert from 'node:assert/strict';
import {reportFile} from '../dist/reporting.mjs';

function job(){return {id:'safe-job',title:'<script>alert(1)</script>',created_at:'2026-11-13',conditions_confirmed:false,recordings:[{
  id:'r1',device:'=SUM(1,2)',scene:'near',filename:'recording.wav',reference:'正确<原稿>',status:'done',result:{
    text:{cer:0,content_score:100,keyword_accuracy:1,substitutions:0,deletions:0,insertions:0,alignment:[{type:'equal',reference:'正确',recognized:'正确'}],keywords:[]},
    audio:{rms_dbfs:-32,near_full_scale_percent:0},mos:{available:true,signal:3.5,background:3,overall:3.2},
    transcription:{text:'独立<转写>',segments:[{start:.2,end:1.4,text:'历史片段'}]},warnings:['<需回听>'],
    provenance:{asr_model:'Xenova/whisper-tiny',reference_sent_to_asr:false},timeline:{available:true,
      words:[{index:0,text:'完整',char_start:1,char_end:2,start:.2,end:.8,probability:.98,event_ids:[]},{index:1,text:'<转写>',char_start:3,char_end:4,start:.8,end:1.4,probability:.3,uncertain:true,event_ids:['e1']}],
      events:[{id:'e1',label:'模型疑点',start:.8,end:1.4,evidence:['低概率','<需回听>'],word_context:'<转写>',precision:'模型估计',score_impact:null}],
      quality_windows:[{start:0,end:9.01,signal:3.5,background:3,overall:3.2,repeated_input:false}],
      global_issues:[{label:'低电平提示',evidence:'全局，不能归因某字'}],limitations:['误差不等于收音故障'],timestamp_source:'model alignment'}}}]};}
test('all report kinds return named content without modifying the job',()=>{
  const source=job(),before=JSON.stringify(source);
  for(const kind of ['html','csv','timeline-csv','json']){const file=reportFile(source,kind);assert.equal(typeof file.content,'string');assert.ok(file.mime.includes('charset=utf-8'));assert.match(file.filename,/^voicebench-online-/);}
  assert.equal(JSON.stringify(source),before);assert.throws(()=>reportFile(source,'unsupported'),/不支持/);
});
test('standalone HTML contains full evidence and escapes every untrusted field',()=>{
  const html=reportFile(job(),'html').content;
  for(const text of ['音质对比','独立转写','正确原稿','完整词级时间表','局部疑似异常时间表','转写字序（不计标点空格）','1～2','3～4','0:00.20—0:00.80','低概率；&lt;需回听&gt;','误差不等于收音故障','模型来源','Xenova/whisper-tiny','Whisper small','CC BY 4.0'])assert.ok(html.includes(text),text);
  assert.ok(html.includes('&lt;script&gt;'));assert.ok(!html.includes('<script>'));assert.ok(!/<audio\b|<iframe\b|<script\b|data:audio/iu.test(html));
  assert.ok(html.includes('未计算，不作因果归因'));assert.ok(html.includes('9.01秒窗口'));
});
test('CSV protects formulas and preserves numeric negative measurements and quoted newlines',()=>{
  const source=job();source.recordings[0].reference='\t=HYPERLINK("https://example.test")\n另一行';
  const content=reportFile(source,'csv').content;
  assert.ok(content.startsWith('\ufeff'));assert.ok(content.includes('"\'=SUM(1,2)"'));
  assert.ok(content.includes("'\t=HYPERLINK"));
  source.recordings[0].result.audio.integrated_lufs=-32;
  const measured=reportFile(source,'csv').content;assert.ok(measured.includes(',-32,'));assert.ok(!measured.includes(",'\u002d32,"));
});
test('timeline CSV retains all words, event evidence, character positions and window limits',()=>{
  const content=reportFile(job(),'timeline-csv').content;
  for(const text of ['recording,device,start,end,type,evidence,context,precision,score_impact','char_start','char_end','完整','<转写>','9.01秒质量预测窗口','低电平提示','未计算单字分数影响'])assert.ok(content.includes(text),text);
  assert.equal(content.split('\r\n').length,7); // Header, two words, event, window, issue, final newline.
});
test('legacy, empty events, no reference and stale results remain readable',()=>{
  const source=job(),row=source.recordings[0];row.reference='';row.result.text={cer:null,content_score:null};row.result.timeline.events=[];
  assert.ok(reportFile(source,'html').content.includes('本次未标出局部疑似异常'));
  delete row.result.timeline;row.status='failed';row.result_stale=true;row.error='<failed>';
  const html=reportFile(source,'html').content;
  for(const text of ['当前显示上次成功结果','没有词级时间线','历史片段','未提供原稿','&lt;failed&gt;'])assert.ok(html.includes(text),text);
  assert.ok(reportFile(source,'timeline-csv').content.includes('结果无词级时间线'));
});
test('JSON includes comparison and method while unavailable MOS stays null in summaries',()=>{
  const source=job();source.recordings[0].result.mos={available:false,reason:'未测'};
  const exported=JSON.parse(reportFile(source,'json').content);
  assert.equal(exported.comparison.quality_groups[0].devices[0].mos_mean,null);
  assert.match(exported.method.asr,/不可|不能/);assert.equal(exported.recordings[0].result.provenance.reference_sent_to_asr,false);
});
