import {normalize} from './text-metrics.mjs';

export const METHOD=Object.freeze({
  version:'online-1.0.0',
  asr:'Xenova/whisper-tiny 量化模型在浏览器本地运行；与本机 Whisper small 的识别结果不能直接合并排名。原稿不输入识别模型。',
  text:'NFKC、繁体转简体、Unicode大小写折叠，忽略标点和空格并保留字母及数字。中文和英文均按字符；不将十五与15自动视为等价。',
  content_score:'有正确原稿时，内容保真分 = max(0, 100 × (1 − CER))。这是自动转写衍生分，不是人类听懂百分比；CER 可超过100%。无原稿时不计分。',
  grouping:'音质按场景比较；字错率只比较同一场景、相同非空归一化原稿。同设备重复录音先求均值。',
  decision:'CER至少低1个百分点且DNSMOS整体至少高0.1才提示两项方向一致；这些是工程提示，不是统计显著性或产品合格线。',
  timeline:'字词时间为模型估计。低置信度仅是模型疑点，不证明收音故障。9.01秒质量窗口不能归因于某一个字；不计算单字扣分。',
  audio:'LUFS与真峰值使用浏览器ebur128-wasm 3.0.0；LRA未实现。编解码、重采样与声道处理以每份结果说明为准，未取得可靠值时不补零。',
  limits:'自动识别和模型预测不能替代人工盲听；无干净参考不计算STOI、PESQ或真实声学SNR。未检测到局部疑点不证明录音没有问题。',
});

const finite=value=>typeof value==='number'&&Number.isFinite(value);
const mean=values=>values.length?values.reduce((sum,value)=>sum+value,0)/values.length:null;
const minimum=values=>values.length?Math.min(...values):null;
const maximum=values=>values.length?Math.max(...values):null;
const values=(rows,section,key,requireMOS=false)=>rows.flatMap(row=>{
  const part=row.result?.[section]||{},value=part[key];
  return (!requireMOS||part.available)&&finite(value)?[value]:[];
});

// aggregate is synchronous, including its Python-compatible reference identifier.
// SHA-256 hashes text only; no audio, network or external runtime is involved.
function referenceHash(text){
  const bytes=new TextEncoder().encode(text),length=Math.ceil((bytes.length+9)/64)*64;
  const data=new Uint8Array(length);data.set(bytes);data[bytes.length]=128;
  const view=new DataView(data.buffer),bits=bytes.length*8;
  view.setUint32(length-8,Math.floor(bits/0x100000000));view.setUint32(length-4,bits>>>0);
  const h=[0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const k=[0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  const rotate=(value,bits)=>(value>>>bits)|(value<<(32-bits)),w=new Uint32Array(64);
  for(let offset=0;offset<length;offset+=64){
    for(let i=0;i<16;i++)w[i]=view.getUint32(offset+i*4);
    for(let i=16;i<64;i++){const a=w[i-15],b=w[i-2];w[i]=(w[i-16]+(rotate(a,7)^rotate(a,18)^(a>>>3))+w[i-7]+(rotate(b,17)^rotate(b,19)^(b>>>10)))>>>0;}
    let [a,b,c,d,e,f,g,v]=h;
    for(let i=0;i<64;i++){
      const t1=(v+(rotate(e,6)^rotate(e,11)^rotate(e,25))+((e&f)^((~e)&g))+k[i]+w[i])>>>0;
      const t2=((rotate(a,2)^rotate(a,13)^rotate(a,22))+((a&b)^(a&c)^(b&c)))>>>0;
      v=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;
    }
    [a,b,c,d,e,f,g,v].forEach((value,index)=>{h[index]=(h[index]+value)>>>0;});
  }
  return h.map(value=>value.toString(16).padStart(8,'0')).join('').slice(0,12);
}

function deviceSummary(device,rows){
  const cers=values(rows,'text','cer'),mos=values(rows,'mos','overall',true),signals=values(rows,'mos','signal',true),backgrounds=values(rows,'mos','background',true),peaks=values(rows,'audio','true_peak_dbtp');
  const cerMean=mean(cers);
  return {device,n:rows.length,cer_n:cers.length,cer_mean:cerMean,cer_min:minimum(cers),cer_max:maximum(cers),
    cer_sd:cers.length>1?Math.sqrt(cers.reduce((sum,value)=>sum+(value-cerMean)**2,0)/(cers.length-1)):null,
    mos_mean:mean(mos),mos_min:minimum(mos),mos_max:maximum(mos),mos_n:mos.length,
    signal_mean:mean(signals),background_mean:mean(backgrounds),signal_min:minimum(signals),signal_max:maximum(signals),
    background_min:minimum(backgrounds),background_max:maximum(backgrounds),lufs_mean:mean(values(rows,'audio','integrated_lufs')),
    rms_mean:mean(values(rows,'audio','rms_dbfs')),true_peak_max:maximum(peaks),
    clipping_percent_mean:mean(values(rows,'audio','near_full_scale_percent')),keyword_mean:mean(values(rows,'text','keyword_accuracy')),
    content_score:mean(values(rows,'text','content_score')),recording_ids:rows.map(row=>row.id)};
}
function summaries(rows){
  const devices=new Map();for(const row of rows){if(!devices.has(row.device))devices.set(row.device,[]);devices.get(row.device).push(row);}
  return [...devices].map(([device,items])=>deviceSummary(device,items));
}
function repeatCaveats(items){
  const caveats=[];
  if(items.some(item=>item.n<3))caveats.push('至少一台设备不足 3 次重复；当前是初步比较。');
  if(new Set(items.map(item=>item.n)).size>1)caveats.push('各设备重复次数不一致，均值的不确定程度不同。');
  return caveats;
}

export function aggregate(job){
  const recordings=job.recordings||[],groups=new Map(),qualityGroups=new Map();
  for(const row of recordings){
    if(row.status!=='done')continue;
    if(!qualityGroups.has(row.scene))qualityGroups.set(row.scene,[]);qualityGroups.get(row.scene).push(row);
    const reference=normalize(row.reference||'');
    if(reference&&finite(row.result?.text?.cer)){
      const key=JSON.stringify([row.scene,reference]);
      if(!groups.has(key))groups.set(key,{scene:row.scene,reference,rows:[]});groups.get(key).rows.push(row);
    }
  }
  const completed=recordings.filter(row=>row.status==='done').length,incomplete=completed!==recordings.length,comparisons=[];
  for(const {scene,reference,rows} of groups.values()){
    const devices=summaries(rows).sort((a,b)=>a.cer_mean-b.cer_mean);
    let decision='只有一台设备，暂无同组对照。';
    if(devices.length>1){
      const [best,...others]=devices,completeMOS=devices.every(item=>item.mos_n===item.n);
      const clearCER=others.every(item=>item.cer_mean-best.cer_mean>=.01-1e-9);
      const clearMOS=completeMOS&&others.every(item=>best.mos_mean-item.mos_mean>=.1-1e-9);
      if(clearCER&&clearMOS)decision=`本组 ${best.device} 的内容识别和整体质量预测均更优，建议优先盲听验证。`;
      else if(clearCER)decision=`本组 ${best.device} 的识别字错率更低；音质证据未同时领先，不能确定全面更好。`;
      else decision='识别差异不足 1 个百分点，或各项指标各有优劣，暂不判定优胜。';
      if(!job.conditions_confirmed)decision='测试条件未确认一致：仅比较这些录音的指标，不能据此判定硬件优劣。';
      else if(incomplete)decision='本批仍有失败或未完成录音：以下为部分结果，暂不判定优胜。';
    }
    comparisons.push({scene,reference_preview:Array.from(reference).slice(0,70).join(''),reference_hash:referenceHash(reference),devices,decision,caveats:repeatCaveats(devices)});
  }
  const qualityComparisons=[];
  for(const [scene,rows] of qualityGroups){
    const devices=summaries(rows).sort((a,b)=>(a.mos_mean===null)-(b.mos_mean===null)||(b.mos_mean??0)-(a.mos_mean??0));
    const references=rows.map(row=>normalize(row.reference||'')),provided=references.filter(Boolean);
    const sameReference=provided.length===references.length&&new Set(provided).size===1;
    const referenceStatus=!provided.length?'no_reference':provided.length<references.length?'mixed_references':sameReference?'same_reference':'different_references';
    if(!sameReference)for(const device of devices){for(const key of ['cer_mean','cer_min','cer_max','cer_sd','keyword_mean','content_score'])device[key]=null;device.cer_n=0;}
    const caveats=repeatCaveats(devices);
    if(referenceStatus==='no_reference')caveats.push('未提供正确原稿，文案是否一致未校验；不计算字错率，模型分数也可能受讲话内容影响。');
    else if(referenceStatus==='mixed_references')caveats.push('部分录音未提供原稿，内容一致性未校验；字错率仅对有原稿录音单独计算。');
    else if(!sameReference)caveats.push('本组文案不同；可比较这些录音的音质预测，不应据此直接判定硬件优劣。');
    if(!job.conditions_confirmed)caveats.push('声源、距离和环境条件未经确认一致，差异不能直接归因于硬件。');
    const completeMOS=devices.every(item=>item.mos_n===item.n);
    let decision='只有一台设备，暂无同场景音质对照。',leadingDevice=null;
    if(devices.length>1){
      if(!completeMOS)decision='部分录音没有有效质量预测；保留已测指标，暂不比较优劣。';
      else if(incomplete)decision='本批仍有失败或未完成录音，当前为部分音质结果，暂不比较优劣。';
      else{
        const [best,...others]=devices;
        if(others.every(item=>best.mos_mean-item.mos_mean>=.1-1e-9)){leadingDevice=best.device;decision=`本组 ${best.device} 的整体质量预测较高，模型倾向这份录音；这不是硬件优胜或人工听懂率结论。`;}
        else decision='整体质量预测差异不足 0.1，暂不提示明确音质倾向。';
      }
    }
    qualityComparisons.push({scene,devices,decision,caveats,reference_status:referenceStatus,same_reference:sameReference,leading_device:leadingDevice,conditions_confirmed:!!job.conditions_confirmed});
  }
  return {groups:comparisons,quality_groups:qualityComparisons,completed,failed:recordings.filter(row=>row.status==='failed').length,
    note:'音质按场景比较；字错率只比较相同非空原稿。不同文案或未经控制的录音不生成硬件总排名。'};
}

const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const number=(value,decimals=2,suffix='')=>finite(value)?value.toFixed(decimals)+suffix:'未测得';
const percent=value=>finite(value)?number(value*100,2,'%'):'未测';
const evidence=value=>Array.isArray(value)?value.map(evidence).join('；'):value&&typeof value==='object'?JSON.stringify(value):String(value??'');
function time(value){if(!finite(value)||value<0)return '未定位';const cs=Math.round(value*100);return `${Math.floor(cs/6000)}:${((cs%6000)/100).toFixed(2).padStart(5,'0')}`;}
const period=item=>`${time(item.start)}—${time(item.end)}`;
const table=(headers,rows)=>`<div class="table-wrap"><table><thead><tr>${headers.map(label=>`<th>${esc(label)}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>`<tr>${row.map(cell=>`<td>${esc(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
const paragraphs=items=>(items||[]).map(item=>`<p>${esc(evidence(item))}</p>`).join('');

function timelineHTML(result){
  const timeline=result.timeline;
  let out='<h3>带时间的独立转写与模型疑点</h3><p>时间为模型估计，不是精确采样定位。低置信度仅为模型疑点，不代表对应字词或硬件发生故障。</p>';
  if(!timeline){
    out+='<p>这份结果没有词级时间线，可在保留原始录音的前提下重新分析。</p>';
    const segments=result.transcription?.segments||[];
    if(segments.length)out+=table(['模型估计时间','独立转写片段'],segments.map(item=>[period(item),item.text]));
    return out;
  }
  const words=timeline.words||[],events=timeline.events||[],eventMap=new Map(events.map(event=>[event.id,event]));
  if(timeline.available===false)out+='<p>本次没有可用的词级定位；请结合完整转写、提示和原录音回听。</p>';
  if(words.length){
    out+='<h4>完整词级时间表</h4>'+table(['转写字序（不计标点空格）','模型估计时间','识别词组','模型概率','复核提示'],words.map(word=>{
      const position=Number.isInteger(word.char_start)&&Number.isInteger(word.char_end)?word.char_start===word.char_end?word.char_start:`${word.char_start}～${word.char_end}`:'—';
      const labels=(word.event_ids||[]).flatMap(id=>eventMap.has(id)?[eventMap.get(id).label||eventMap.get(id).type||'模型疑点']:[]);
      if(word.uncertain)labels.push('模型不确定，建议回听；不是故障判断');
      return [position,period(word),word.text,number(word.probability,4),labels.join('；')||'未标记模型疑点'];
    }));
  }else out+='<p>未生成词级时间表；不能据此推断音频没有人声。</p>';
  out+='<h4>局部疑似异常时间表</h4>';
  if(events.length)out+=table(['模型估计时间','疑点类型','检测依据','重叠转写上下文','定位范围','单字分数影响'],events.map(event=>[period(event),event.label||event.type||'模型疑点',evidence(event.evidence),evidence(event.word_context),evidence(event.precision),'未计算，不作因果归因']));
  else out+='<p>本次未标出局部疑似异常。现有规则未触发，不证明录音没有问题。</p>';
  if(timeline.quality_windows?.length)out+='<h4>局部质量预测窗口</h4><p>DNSMOS使用9.01秒窗口；窗口覆盖多个字词，不能把质量下降归因于某一个字。循环补齐不是新增真实音频。</p>'+table(['窗口时间','人声预测','背景预测','整体预测','输入范围'],timeline.quality_windows.map(window=>[period(window),number(window.signal),number(window.background),number(window.overall),window.repeated_input?'含循环补齐输入':'原始时间范围']));
  if(timeline.global_issues?.length)out+='<h4>全局提示（不定位到单字）</h4>'+paragraphs(timeline.global_issues.map(item=>`${item.label||item.type}：${evidence(item.evidence)}`));
  out+='<h4>定位边界</h4><p>时间重叠用于帮助回听，不证明疑似异常导致该词识别错误；无正确原稿时不能判定漏字或实际说错。</p>'+paragraphs(timeline.limitations);
  if(timeline.timestamp_source)out+='<p>时间来源：'+esc(evidence(timeline.timestamp_source))+'</p>';
  return out;
}

function exportHTML(job){
  const summary=aggregate(job),parts=[`<h1>${esc(job.title||'收音对比报告')}</h1><p>VoiceBench Online · ${esc(job.created_at||'')} · 方法 ${esc(METHOD.version)}</p>`,
    `<p>${summary.completed}份完成，${summary.failed}份失败；共${(job.recordings||[]).length}份。</p>`,
    `<p><strong>范围：</strong>浏览器自动识别与模型预测，未经人工盲听，不等同于人的听懂率。条件一致确认：${job.conditions_confirmed?'是':'否'}。</p>`,
    '<p>浏览器ASR采用Xenova/whisper-tiny量化版，与本机版Whisper small不同，不应直接混合内容评分或排名。报告不内嵌音频。</p>'];
  if(job.notes)parts.push('<h2>测试条件与备注</h2><p class="text">'+esc(job.notes)+'</p>');
  for(const group of summary.quality_groups)parts.push(`<h2>音质对比：${esc(group.scene)}</h2><p>${esc(group.decision)}</p>`,table(['设备','次数','人声预测↑','背景预测↑','整体预测↑','整体范围','响度LUFS','RMS dBFS'],group.devices.map(item=>[item.device,item.n,number(item.signal_mean),number(item.background_mean),number(item.mos_mean),`${number(item.mos_min)}～${number(item.mos_max)}`,number(item.lufs_mean,1),number(item.rms_mean,1)])),paragraphs(group.caveats));
  for(const group of summary.groups)parts.push(`<h2>内容识别：${esc(group.scene)} <small>原稿 ${esc(group.reference_hash)}</small></h2><p>${esc(group.decision)}</p>`,table(['设备','次数','CER均值↓','CER范围','关键词正确率↑','DNSMOS整体↑'],group.devices.map(item=>[item.device,item.n,percent(item.cer_mean),`${percent(item.cer_min)}～${percent(item.cer_max)}`,percent(item.keyword_mean),number(item.mos_mean)])),paragraphs(group.caveats));
  for(const row of job.recordings||[]){
    parts.push(`<h2>${esc(row.device)} / ${esc(row.filename)}</h2><p>场景：${esc(row.scene)}；状态：${esc(row.status)}</p>`);
    const result=row.result;
    if(!result){parts.push(`<p>${esc(row.error||'未完成')}</p>`);continue;}
    if(row.status!=='done'||row.result_stale)parts.push(`<p><strong>当前显示上次成功结果。</strong>本轮新分析尚未成功。${esc(row.error||'')}</p>`);
    const audio=result.audio||{},text=result.text||{},mos=result.mos||{};
    if(finite(text.cer))parts.push(`<p>内容保真分${number(text.content_score,1)}/100；CER ${percent(text.cer)}；替换${esc(text.substitutions)}／漏字${esc(text.deletions)}／多字${esc(text.insertions)}。</p>`);
    else parts.push('<p>未提供正确原稿或未取得有效内容评分：CER、内容保真分和关键词正确率均为未测。独立转写未用作标准答案。</p>');
    parts.push(`<p>DNSMOS人声${number(mos.available?mos.signal:null)}，背景${number(mos.available?mos.background:null)}，整体${number(mos.available?mos.overall:null)}；响度${number(audio.integrated_lufs,1,' LUFS')}；真峰值${number(audio.true_peak_dbtp,1,' dBTP')}；接近满刻度采样${number(audio.near_full_scale_percent,4,'%')}。</p>`,
      `<h3>正确原稿</h3><p class="text">${esc(row.reference||'未提供原稿')}</p><h3>独立转写</h3><p class="text">${esc(result.transcription?.text||'（未识别出文字）')}</p>`);
    if(mos.available===false&&mos.reason)parts.push('<p>质量预测未测原因：'+esc(mos.reason)+'</p>');
    if(text.alignment?.length){parts.push('<h3>逐字对照</h3><p class="text">');for(const item of text.alignment)parts.push(item.type==='equal'?esc(item.reference):`<del>${esc(item.reference)}</del><ins>${esc(item.recognized)}</ins>`);parts.push('</p>');}
    if(text.keywords?.length)parts.push('<h3>关键词</h3>'+paragraphs(text.keywords.map(item=>`${item.term}：${item.excluded?'原稿无此词，不计分':`${item.correct}/${item.occurrences}`}`)));
    parts.push(paragraphs(result.warnings),timelineHTML(result),'<details><summary>可追溯信息与模型来源</summary><pre>'+esc(JSON.stringify(result.provenance||{},null,2))+'</pre></details>');
  }
  parts.push('<h2>评分方法与边界</h2>',...Object.entries(METHOD).map(([key,value])=>`<p><strong>${esc(key)}</strong>：${esc(value)}</p>`),
    '<h2>模型来源与归属</h2><p>ASR：Xenova/whisper-tiny q8，固定修订5332fcc35e32a33b86612b9a57a89be7906102b1，模型卡声明Apache-2.0；OpenAI Whisper基础项目采用MIT。Transformers.js 3.8.1在浏览器WASM中执行。实际资源与设置见每份结果的可追溯信息。</p><p>DNSMOS P.835：Microsoft DNS-Challenge，CC BY 4.0；上游修订785ab12275d5cf9341c5e946b0eee9f8825ece3b，非个性化模型及上游校准系数。响度/真峰值：ebur128-wasm 3.0.0，Apache-2.0。Vibe Recorder：SvenKunkka，MIT。此报告不表示任何上游机构背书。</p>');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; media-src 'none'; base-uri 'none'; form-action 'none'"><title>${esc(job.title||'收音对比报告')}</title><style>body{font:16px/1.75 system-ui,sans-serif;color:#17344a;max-width:1120px;margin:40px auto;padding:0 22px}h1{font-size:30px}h2{margin-top:36px}h3,h4{margin-top:24px}small{font-size:12px;color:#627681}.table-wrap{overflow:auto}table{border-collapse:collapse;width:100%;font-size:14px}th,td{padding:10px;text-align:left;border-bottom:1px solid #dce4e8;vertical-align:top}th{background:#edf4f6}p.text,pre{white-space:pre-wrap;overflow-wrap:anywhere}pre{font-size:12px}del{background:#ffe0dc;color:#912e21}ins{background:#d6eee7;color:#14604e;text-decoration:none}@media print{body{margin:0;font-size:12px}h2{break-after:avoid}tr{break-inside:avoid}.table-wrap{overflow:visible}}</style></head><body>${parts.join('')}</body></html>`;
}

function csvCell(value){
  let text=value===null||value===undefined?'':String(value);
  if(typeof value==='string'&&(/^[\s\u0000-\u001f]*[=+\-@]/u.test(text)||/^[\t\r\n]/u.test(text)))text="'"+text;
  return /[",\r\n]/u.test(text)?'"'+text.replaceAll('"','""')+'"':text;
}
const csv=rows=>'\ufeff'+rows.map(row=>row.map(csvCell).join(',')).join('\r\n')+'\r\n';
function exportCSV(job){
  const rows=[['设备','场景','文件','状态','内容保真分','CER百分比','关键词正确率百分比','DNSMOS人声','DNSMOS背景','DNSMOS整体','响度LUFS','真峰值dBTP','疑似削波采样百分比','原稿','转写','错误','原稿状态']];
  for(const row of job.recordings||[]){const result=row.result||{},text=result.text||{},mos=result.mos||{},audio=result.audio||{};
    rows.push([row.device,row.scene,row.filename,row.status,text.content_score??'未测',finite(text.cer)?text.cer*100:'未测',finite(text.keyword_accuracy)?text.keyword_accuracy*100:'未测',mos.available?mos.signal:null,mos.available?mos.background:null,mos.available?mos.overall:null,audio.integrated_lufs,audio.true_peak_dbtp,audio.near_full_scale_percent,row.reference||'',result.transcription?.text,row.error,(row.reference||'').trim()?'已提供原稿':'未提供原稿']);
  }
  return csv(rows);
}
function exportTimelineCSV(job){
  const rows=[['recording','device','start','end','type','evidence','context','precision','score_impact']];
  const write=(row,start,end,type,proof,context='',precision='')=>rows.push([row.filename||row.id,row.device,start,end,type,evidence(proof),evidence(context),(row.result_stale||row.status!=='done'?'上次成功结果；':'')+evidence(precision),'未计算单字分数影响']);
  for(const row of job.recordings||[]){
    const timeline=row.result?.timeline;
    if(!timeline){write(row,'','','结果无词级时间线','保留原录音后可重新分析。');continue;}
    for(const word of timeline.words||[])write(row,word.start,word.end,word.uncertain?'模型不确定词组':'模型估计词组',{probability:word.probability??null,event_ids:word.event_ids||[],char_start:word.char_start??null,char_end:word.char_end??null},word.text,'模型时间估计，非精确采样定位');
    for(const event of timeline.events||[])write(row,event.start,event.end,event.label||event.type||'模型疑点',event.evidence,event.word_context,event.precision);
    if(!timeline.events?.length)write(row,'','','未标出局部疑似异常','现有规则未触发，不证明录音没有问题。');
    for(const window of timeline.quality_windows||[])write(row,window.start,window.end,'9.01秒质量预测窗口',{signal:window.signal??null,background:window.background??null,overall:window.overall??null,repeated_input:!!window.repeated_input},'','窗口质量不能归因单字');
    for(const issue of timeline.global_issues||[])write(row,'','',issue.label||issue.type||'全局模型疑点',issue.evidence,'','全局，非单字定位');
  }
  return csv(rows);
}

export function reportFile(job,kind){
  if(kind==='html')return {content:exportHTML(job),mime:'text/html;charset=utf-8',filename:'voicebench-online-report.html'};
  if(kind==='csv')return {content:exportCSV(job),mime:'text/csv;charset=utf-8',filename:'voicebench-online-results.csv'};
  if(kind==='timeline-csv')return {content:exportTimelineCSV(job),mime:'text/csv;charset=utf-8',filename:'voicebench-online-timeline.csv'};
  if(kind==='json')return {content:JSON.stringify({...job,comparison:aggregate(job),method:METHOD},null,2),mime:'application/json;charset=utf-8',filename:'voicebench-online-results.json'};
  throw new TypeError('不支持的导出格式。');
}
