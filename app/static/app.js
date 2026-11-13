'use strict';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt = (v, n=2, unit='') => v == null ? '—' : `${Number(v).toFixed(n)}${unit}`;
const pct = (v, n=1) => v == null ? '—' : `${(v*100).toFixed(n)}%`;
const stamp = (s) => `${String(Math.floor(Math.max(0,s)/60)).padStart(2,'0')}:${(Math.max(0,s)%60).toFixed(2).padStart(5,'0')}`;
const time = (s) => `${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,'0')}`;
const statusLabel = {queued:'排队中',running:'分析中',done:'已完成',partial:'部分失败',interrupted:'已中断',pending:'等待分析',failed:'失败'};
let recordings = [], activeJob = null, pollTimer = null, latestJob = null, health = null;

async function api(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    let detail;
    try { detail = (await response.json()).detail; } catch {}
    throw new Error(typeof detail === 'string' ? detail : `请求未完成（${response.status}），请稍后重试。`);
  }
  return response.json();
}
function toast(message) { $('toast').textContent=message; $('toast').hidden=false; setTimeout(()=>$('toast').hidden=true,4000); }
function formError(message) { $('form-error').textContent=message; $('form-error').hidden=!message; }

function addFiles(files) {
  formError('');
  for (const file of files) {
    if (recordings.length >= 20) { formError('每批最多 20 份录音。'); break; }
    if (file.size > 100*1024*1024) { formError(`${file.name} 超过 100 MB，请先分段。`); continue; }
    if (file.size === 0) { formError(`${file.name} 是空文件。`); continue; }
    recordings.push({id:crypto.randomUUID(),file,device:file.name.replace(/\.[^.]+$/,''),scene:'近距离人声',reference:''});
  }
  renderRecordings();
}
function renderRecordings() {
  $('recording-list').innerHTML=recordings.map((r,i)=>`<article class="recording-row" data-row="${r.id}">
  <div class="row-heading"><div class="recording-identity"><span class="letter-badge">${String.fromCharCode(65+i)}</span><div class="file-name">${esc(r.file.name)}<span class="file-size">${fmt(r.file.size/1024/1024,2)} MB · 待分析</span></div></div><button type="button" class="remove-file" data-remove="${r.id}" aria-label="移除 ${esc(r.file.name)}">移除</button></div>
  <div class="row-fields"><label>设备 / 版本<input data-field="device" value="${esc(r.device)}" maxlength="100" required></label><label>场景<input data-field="scene" value="${esc(r.scene)}" maxlength="200" required></label></div>
  <details ${r.reference?'open':''}><summary>这份录音的专属原稿${r.reference?'（已填写）':'（可选）'}</summary><div class="row-reference-tools"><span>留空时使用共用原稿；均未填写则仅做音质分析。</span><label class="file-link">导入 TXT<input type="file" accept=".txt,text/plain" data-row-reference="${r.id}"></label></div><textarea data-field="reference" rows="3" maxlength="20000" placeholder="这份录音实际朗读的文字">${esc(r.reference)}</textarea></details></article>`).join('');
  $('file-count').textContent=String(recordings.length);
  $('empty-guidance').hidden=!!recordings.length;
  $('drop-zone').classList.toggle('has-files',!!recordings.length);
  $('ready-hint').textContent=recordings.length?`${recordings.length} 份录音已就绪 · 没有原稿也可分析`:'添加录音即可开始，无需先填写原稿。';
}
$('recording-list').addEventListener('input', e=>{
  const row=e.target.closest('[data-row]');
  if(row && e.target.dataset.field) recordings.find(r=>r.id===row.dataset.row)[e.target.dataset.field]=e.target.value;
});
$('recording-list').addEventListener('click',e=>{
  const id=e.target.dataset.remove;
  if(id) {recordings=recordings.filter(r=>r.id!==id);renderRecordings();}
});
$('recording-list').addEventListener('change',async e=>{
  if(e.target.dataset.rowReference && e.target.files[0]) {
    if(e.target.files[0].size>200000) return formError('原稿 TXT 过大，请使用少于 20,000 字的原稿。');
    recordings.find(r=>r.id===e.target.dataset.rowReference).reference=await e.target.files[0].text();renderRecordings();
  }
});
$('reference-file').addEventListener('change',async e=>{
  if(e.target.files[0]) {
    if(e.target.files[0].size>200000) return formError('原稿 TXT 过大。');
    $('reference').value=await e.target.files[0].text();
  }
});
$('audio-files').addEventListener('change',e=>{addFiles(e.target.files);e.target.value='';});
$('drop-zone').addEventListener('click',()=>$('audio-files').click());
$('add-audio').addEventListener('click',()=>$('audio-files').click());
$('drop-zone').addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();$('audio-files').click();}});
for(const name of ['dragenter','dragover']) $('drop-zone').addEventListener(name,e=>{e.preventDefault();$('drop-zone').classList.add('dragging');});
for(const name of ['dragleave','drop']) $('drop-zone').addEventListener(name,e=>{e.preventDefault();$('drop-zone').classList.remove('dragging');});
$('drop-zone').addEventListener('drop',e=>addFiles(e.dataTransfer.files));

async function refreshHistory() {
  const jobs=await api('/api/jobs');
  const item=j=>`<button class="history-item ${j.id===activeJob?'active':''}" data-job="${j.id}"><strong>${esc(j.title)}</strong><span>${esc(j.created_at.slice(5,16).replace('T',' '))} · ${j.completed}/${j.count} · ${statusLabel[j.status]}</span></button>`;
  const selfTests=jobs.filter(j=>/流程验证|故障重试自检/.test(j.title)),userJobs=jobs.filter(j=>!selfTests.includes(j));
  $('history').innerHTML=(userJobs.length?userJobs.map(item).join(''):'<p class="empty-state">你的对比报告会保存在这里。</p>')+(selfTests.length?`<details class="self-tests"><summary>软件自检记录 (${selfTests.length})</summary>${selfTests.map(item).join('')}</details>`:'');
}
$('history').addEventListener('click',e=>{const b=e.target.closest('[data-job]');if(b)openJob(b.dataset.job);});
$('new-test').addEventListener('click',()=>{
  activeJob=null;latestJob=null;clearTimeout(pollTimer);history.replaceState(null,'','/');
  $('setup-view').hidden=false;$('report-view').hidden=true;refreshHistory().catch(e=>toast(e.message));
});
$('test-form').addEventListener('submit',async e=>{
  e.preventDefault();formError('');
  if(!recordings.length) return formError('请先添加至少一份录音。');
  const rows=recordings.map(r=>({device:r.device.trim(),scene:r.scene.trim(),reference:(r.reference.trim()||$('reference').value.trim())}));
  if(rows.some(r=>!r.device||!r.scene))return formError('请填写每份录音的设备名称和场景。原稿可以留空。');
  if(!health?.capabilities.asr) return formError('本地语音识别尚未就绪，请先检查分析能力。');
  const data=new FormData();
  data.append('manifest',JSON.stringify({title:$('test-title').value,language:$('language').value,channel:$('channel').value,
    keywords:$('keywords').value.split(/[,，、;；\n]/).map(x=>x.trim()).filter(Boolean),notes:$('notes').value,
    conditions_confirmed:$('conditions').checked,recordings:rows}));
  recordings.forEach(r=>data.append('files',r.file));
  $('start-button').disabled=true;$('start-button').textContent='导入录音中…';
  try {const job=await api('/api/jobs',{method:'POST',body:data});await openJob(job.id);}
  catch(error){formError(error.message);}
  finally{$('start-button').disabled=false;$('start-button').textContent='开始分析';}
});

async function openJob(id) {
  clearTimeout(pollTimer);activeJob=id;history.replaceState(null,'',`/#test=${id}`);
  $('setup-view').hidden=true;$('report-view').hidden=false;
  try {
    const job=await api(`/api/jobs/${id}`);
    if(activeJob!==id)return;
    latestJob=job;renderReport(job);await refreshHistory();
    if(['queued','running'].includes(job.status))pollTimer=setTimeout(()=>openJob(id),2200);
  }catch(error){$('report-view').innerHTML=`<div class="error-message">${esc(error.message)}</div>`;}
}
function waveSvg(values,id) {
  const width=800,height=64;
  const path=values.map((v,i)=>{const x=(i+.5)*width/values.length,y=Math.max(.6,Math.min(26,v/Math.max(.00001,...values)*26));return `M${x.toFixed(2)} ${32-y}v${2*y}`;}).join('');
  return `<svg class="waveform" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="录音波形，点击可定位试听" data-wave="${id}"><path d="${path}"/></svg>`;
}
function spectrumSvg(values) {
  const points=values.map((v,i)=>`${i*600/Math.max(1,values.length-1)},${85-Math.max(0,Math.min(75,(v.db+100)*.8))}`).join(' ');
  return `<svg class="spectrum" viewBox="0 0 600 90" preserveAspectRatio="none" role="img" aria-label="80 Hz 到 8 kHz 的录音频谱，仅描述文件，不代表麦克风频响"><polyline points="${points}"/></svg><p class="muted small">80 Hz → 8 kHz · 文件平均频谱，不能视为麦克风频率响应。</p>`;
}
function comparisonHtml(group) {
  return `<section class="comparison"><div class="comparison-heading"><h2>${esc(group.scene)}</h2><small>原稿 ${group.reference_hash} · ${esc(group.reference_preview)}${group.reference_preview.length>=70?'…':''}</small></div>
    <p class="table-hint">左右滑动表格，查看其余指标</p><div class="table-scroll" tabindex="0" aria-label="设备评分对比，可横向滚动"><table><thead><tr><th>设备 / 重复次数</th><th>内容保真分 ↑</th><th>识别字错率 ↓</th><th>关键信息正确率 ↑</th><th>整体质量预测 ↑</th></tr></thead><tbody>${group.devices.map(d=>`<tr><td>${esc(d.device)}<span class="metric-sub">${d.n} 次录音</span></td><td><span class="metric-value">${fmt(d.content_score,1)}</span><span class="metric-sub">由 CER 换算 / 100</span></td><td><span class="metric-value">${pct(d.cer_mean)}</span><span class="metric-sub">范围 ${pct(d.cer_min)}～${pct(d.cer_max)}</span><div class="cer-track"><span style="width:${Math.min(100,d.cer_mean*100)}%"></span></div></td><td><span class="metric-value">${pct(d.keyword_mean)}</span><span class="metric-sub">自动识别 / 未设词时不计</span></td><td><span class="metric-value">${fmt(d.mos_mean)}</span><span class="metric-sub">DNSMOS · 有效 ${d.mos_n}/${d.n}</span></td></tr>`).join('')}</tbody></table></div>
    <div class="decision">${esc(group.decision)}</div>${group.caveats.length?`<p class="caveat">${esc(group.caveats.join(' '))}</p>`:''}</section>`;
}
function qualityHtml(group) {
  return `<section class="comparison"><div class="comparison-heading"><h2>${esc(group.scene)} · 音质对比</h2><small>分数越高，模型预测质量越好。响度与峰值只表示电平，不直接决定优劣。</small></div><p class="table-hint">左右滑动，查看全部指标</p><div class="table-scroll" tabindex="0" aria-label="音质评分对比，可横向滚动"><table><thead><tr><th>设备 / 版本</th><th>人声质量 ↑</th><th>背景质量 ↑</th><th>整体质量 ↑</th><th>响度</th><th>真峰值</th><th>疑似削波采样</th></tr></thead><tbody>${group.devices.map(d=>`<tr><td>${esc(d.device)}<span class="metric-sub">${d.n} 次录音</span></td><td><span class="metric-value">${fmt(d.signal_mean)}</span></td><td><span class="metric-value">${fmt(d.background_mean)}</span></td><td><span class="metric-value">${fmt(d.mos_mean)}</span><div class="score-bar"><span style="width:${Math.max(0,Math.min(100,((d.mos_mean||1)-1)/4*100))}%"></span></div><span class="metric-sub">范围 ${fmt(d.mos_min)}～${fmt(d.mos_max)}</span></td><td>${fmt(d.lufs_mean,1)}<span class="metric-sub">LUFS</span></td><td>${fmt(d.true_peak_max,1)}<span class="metric-sub">dBTP</span></td><td>${fmt(d.clipping_percent_mean,4)}%</td></tr>`).join('')}</tbody></table></div><div class="decision">${esc(group.decision)}</div>${group.caveats.length?`<p class="caveat">${esc(group.caveats.join(' '))}</p>`:''}</section>`;
}
function previewHtml(row,job,index) {
  const r=row.result,a=r.audio,m=r.mos;
  return `<article class="preview-card"><div class="preview-head"><div class="preview-identity"><span class="letter-badge">${String.fromCharCode(65+index)}</span><div><strong>${esc(row.device)}</strong><small>${esc(row.filename)} · ${fmt(a.duration,1)} 秒</small></div></div><div class="preview-score">${fmt(m.overall)}<small>整体质量预测 / 5</small></div></div>${waveSvg(a.waveform,row.id)}<div class="audio-row"><audio controls preload="none" data-audio="${row.id}" src="/api/jobs/${job.id}/audio/${row.id}/original"></audio><small data-gain="${row.id}">原始电平 · 分析副本 · 波形按各自峰值缩放</small></div><dl class="preview-stats"><div><dt>人声质量</dt><dd>${fmt(m.signal)}</dd></div><div><dt>背景质量</dt><dd>${fmt(m.background)}</dd></div><div><dt>响度</dt><dd>${fmt(a.integrated_lufs,1)} <small>LUFS</small></dd></div></dl></article>`;
}
function detailHtml(row,job) {
  const r=row.result,a=r.audio,t=r.text||{},m=r.mos;
  const hasReference=t.available!==false&&t.cer!=null;
  const alignment=(t.alignment||[]).map(d=>d.type==='equal'?esc(d.reference):`<del title="原稿中未正确识别的内容">${esc(d.reference)}</del><ins title="识别为">${esc(d.recognized)}</ins>`).join('');
  return `<details class="recording-detail"><summary><span class="detail-title"><strong>${esc(row.device)} · 转写与详细数据</strong><small>${esc(row.filename)} · ${esc(row.scene)} · ${a.sample_rate/1000} kHz / ${a.channels} 声道</small></span><span class="score-chip">${hasReference?pct(t.cer):fmt(m.overall)}<small>${hasReference?'识别字错率':'整体质量预测'} / 展开</small></span></summary><div class="detail-body">
  <dl class="metrics-grid"><div><dt>人声质量预测 ↑</dt><dd>${fmt(m.signal)}</dd></div><div><dt>背景质量预测 ↑</dt><dd>${fmt(m.background)}</dd></div><div><dt>整体质量预测 ↑</dt><dd>${fmt(m.overall)}</dd></div><div><dt>识别字错率 ↓</dt><dd>${hasReference?pct(t.cer):'<small>未提供原稿</small>'}</dd></div><div><dt>整体响度</dt><dd>${fmt(a.integrated_lufs,1)} <small>LUFS</small></dd></div><div><dt>真峰值</dt><dd>${fmt(a.true_peak_dbtp,1)} <small>dBTP</small></dd></div><div><dt>接近满刻度采样比例</dt><dd>${fmt(a.near_full_scale_percent,4)} <small>%</small></dd></div><div><dt>低于 −50 dBFS 时段</dt><dd>${fmt(a.low_energy_percent,1)} <small>%（非掉字率）</small></dd></div></dl>
  <div class="text-pair ${hasReference?'':'single'}">${hasReference?`<div><h3>正确原稿 · ${t.reference_characters} 个计分字符</h3><p>${esc(row.reference)}</p></div>`:''}<div><h3>独立转写 · ${esc(r.transcription.engine)} · 需人工核对</h3><p>${esc(r.transcription.text)||'（未识别出文字）'}</p></div></div>
  ${hasReference?`<div class="diff-block"><h3>逐字对照 · 替换 ${t.substitutions} / 漏字 ${t.deletions} / 多字 ${t.insertions}</h3><div class="diff-legend"><span>删除线：未正确识别的原文</span><span>绿色：识别出的不同内容</span></div><p class="diff-text">${alignment}</p></div>`:'<p class="no-reference">未提供正确原稿，因此不计算字错率、内容保真分或关键词正确率。以上是模型转写，不是已核实原文。</p>'}
  ${(t.keywords||[]).length?`<div class="keyword-list">${t.keywords.map(k=>`<span class="keyword-tag ${k.correct<k.occurrences?'miss':''}">${esc(k.term)} ${k.excluded?'未在原稿中':`${k.correct}/${k.occurrences}`}</span>`).join('')}</div>`:''}
  ${r.warnings.length?`<div class="warnings">${r.warnings.map(w=>`<p>${esc(w)}</p>`).join('')}</div>`:''}
  ${!m.available?`<p class="muted small">质量预测未计分：${esc(m.reason)}</p>`:''}
  ${a.clipping_events.length?`<div class="segments-block"><h3>疑似削波片段（需回听）</h3>${a.clipping_events.slice(0,12).map(s=>`<div class="segment"><button data-seek="${row.id}" data-time="${Math.max(0,s.start-.5)}">${time(s.start)}</button><span>连续采样接近满刻度 · ${fmt(s.end-s.start,3)} 秒</span></div>`).join('')}</div>`:''}
  <details class="segments-block"><summary>按转写片段定位回听（时间为模型估计）</summary>${r.transcription.segments.map(s=>`<div class="segment"><button data-seek="${row.id}" data-time="${s.start}">${time(s.start)}—${time(s.end)}</button><span>${esc(s.text)}</span></div>`).join('')}</details>
  <details class="provenance"><summary>频谱与可追溯记录</summary>${spectrumSvg(a.spectrum)}<pre>${esc(JSON.stringify(r.provenance,null,2))}</pre></details></div></details>`;
}
function evidenceText(value) { return Array.isArray(value)?value.join('；'):typeof value==='object'?JSON.stringify(value):String(value||''); }
function timelineHtml(row) {
  const result=row.result,t=result.timeline||{},words=t.words||[],events=t.events||[],uncertain=t.uncertain_words||[];
  const tokens=words.length?`<div class="timed-transcript">${words.map(w=>`<button class="word-token ${(w.event_ids||[]).length?'audio-suspect':''} ${w.uncertain?'text-uncertain':''}" data-seek="${row.id}" data-time="${Math.max(0,w.start-.25)}" title="${stamp(w.start)}—${stamp(w.end)} · ${w.char_start?`转写第 ${w.char_start}～${w.char_end} 字（不计标点空格）`:'字词对齐估计'}${w.uncertain?' · 识别存在歧义，需核对':''}"><span>${esc(w.text)}</span><small>${stamp(w.start)}</small></button>`).join('')}</div>`:`<p class="unlocated-transcript">${esc(result.transcription.text)||'（未识别出文字）'}</p>`;
  const eventList=events.length?`<div class="timeline-events">${events.map(event=>`<article class="timeline-event"><div class="event-head"><strong>${esc(event.label)}</strong><button data-seek="${row.id}" data-time="${Math.max(0,event.start-.6)}">${stamp(event.start)}—${stamp(event.end)} · 回听</button></div><p class="event-context">对应转写：${esc(event.word_context||'该区间没有可靠的字词对齐')}</p><p>${esc(evidenceText(event.evidence))}</p><small>定位依据：${esc(event.precision||'信号启发式')} · 待回听确认，未计算该字词的独立扣分。</small></article>`).join('')}</div>`:`<p class="timeline-empty">${t.available?'未检测到符合当前规则的局部音频异常。可点击文字自行回听；这不代表所有字词都清楚。':'尚未生成字词时间与异常定位，请更新分析。'}</p>`;
  return `<section class="transcript-card"><div class="transcript-heading"><h3>${esc(row.device)}${row.result_stale?'（上次结果）':''}</h3><span>${events.length} 处音频疑点 · ${uncertain.length} 个转写疑点</span></div>${tokens}
  <p class="timeline-key">文字下方为开始时间；词组时间为模型估计。橙色标记音频疑点覆盖处，虚线表示转写存疑，两者含义不同。</p>
  ${(t.global_issues||[]).length?`<div class="global-issues">${t.global_issues.map(x=>`<p><strong>${esc(x.label)}</strong> ${esc(evidenceText(x.evidence))}</p>`).join('')}</div>`:''}${eventList}
  ${uncertain.length?`<details class="uncertain-details"><summary>需核对的转写字词（不等于收音故障）</summary>${uncertain.map(w=>`<div class="uncertain-row"><button data-seek="${row.id}" data-time="${Math.max(0,w.start-.3)}">${stamp(w.start)}—${stamp(w.end)}</button><span>“${esc(w.text)}”${w.char_start?` · 转写第 ${w.char_start}～${w.char_end} 字`:''}</span></div>`).join('')}</details>`:''}
  ${(t.quality_windows||[]).length?`<details class="quality-windows"><summary>查看质量评分实际覆盖的时间区间（${t.quality_windows.length} 个窗口）</summary><p>每个 DNSMOS 窗口约 9.01 秒。窗口分数覆盖多个字词，不能作为某一个字的分数。</p>${t.quality_windows.slice(0,60).map(w=>`<div class="window-row"><button data-seek="${row.id}" data-time="${w.start}">${stamp(w.start)}—${stamp(w.end)}</button><span>人声 ${fmt(w.signal)} / 背景 ${fmt(w.background)} / 整体 ${fmt(w.overall)}${w.repeated_input?' · 短音频重复补齐，仅作整段参考':''}</span></div>`).join('')}${t.quality_windows.length>60?'<p>其余窗口见完整数据导出。</p>':''}</details>`:''}
  ${t.limitations?.length?`<details class="timeline-method"><summary>定位规则与精度</summary>${t.limitations.map(x=>`<p>${esc(x)}</p>`).join('')}<p>${esc(t.timestamp_source||'')}</p></details>`:''}</section>`;
}
function renderReport(job) {
  const c=job.comparison,busy=['queued','running'].includes(job.status),current=job.recordings.find(r=>r.status==='running');
  const finished=job.recordings.filter(r=>r.status==='done'||(r.result_stale&&r.result)),needsTimeline=job.recordings.some(r=>r.result&&!r.result?.timeline?.available),withReference=finished.filter(r=>r.result.text?.cer!=null).length;
  $('report-view').innerHTML=`<div class="report-heading"><div><h1>${esc(job.title)}</h1><p>${esc(job.created_at.slice(0,16).replace('T',' '))} · ${job.recordings.length} 份录音 · ${statusLabel[job.status]}</p></div><div class="export-actions">${!busy&&needsTimeline?'<button class="button" id="refresh-button">更新字词定位</button>':''}<a class="button" href="/api/jobs/${job.id}/export/html">导出报告</a><a class="button" href="/api/jobs/${job.id}/export/csv">评分 CSV</a>${finished.some(r=>r.result?.timeline?.available)?`<a class="button" href="/api/jobs/${job.id}/export/timeline-csv">定位 CSV</a>`:''}<a class="button" href="/api/jobs/${job.id}/export/json">完整数据</a>${['partial','interrupted'].includes(job.status)?'<button class="button" id="retry-button">重试未完成录音</button>':''}</div></div>
  <div class="report-context"><span class="context-tag ${job.conditions_confirmed?'verified':''}">${job.conditions_confirmed?'测试条件已确认一致':'录制条件未确认一致'}</span><span class="context-tag">${withReference?`${withReference} 份有原稿`:'无原稿 · 仅做音质分析'}</span>${job.notes?`<span>${esc(job.notes)}</span>`:''}</div>
  ${busy?`<div class="progress-panel"><div class="progress-top"><strong>${job.status==='queued'?'等待本机分析':'正在分析录音'}</strong><span>${c.completed}/${job.recordings.length}</span></div><div class="progress-track"><span style="width:${c.completed/job.recordings.length*100}%"></span></div><p>${current?`${esc(current.device)}：${esc(current.stage||'准备中')}`:'任务已排队。'} · 保持本地服务运行，完成后自动显示结果。</p></div>`:''}
  ${finished.length?`<div class="report-section-title"><div><h2>先试听，再看指标</h2><p>波形按各自峰值缩放；音量匹配只改变试听副本。</p></div><label class="toggle-label"><input id="match-levels" type="checkbox">匹配试听音量（固定增益 / RMS）</label></div><div class="preview-grid">${finished.map((r,i)=>previewHtml(r,job,i)).join('')}</div>`:''}
  ${(c.quality_groups||[]).map(qualityHtml).join('')}
  ${finished.length?`<div class="report-section-title"><div><h2>文字与问题时间轴</h2><p>点击字词或时间回听。转写并非正确原稿；音频疑点与识别歧义分别标记。</p></div></div><div class="transcript-grid">${finished.map(timelineHtml).join('')}</div>`:''}
  ${c.groups.length?`<div class="report-section-title"><h2>内容识别对比</h2><p>仅同场景、同一正确原稿的录音分组比较。</p></div>${c.groups.map(comparisonHtml).join('')}`:''}
  ${job.recordings.some(r=>r.status!=='done')?`<div class="status-list">${job.recordings.filter(r=>r.status!=='done').map(r=>`<div class="status-row ${r.status==='failed'?'failed':''}"><span>${esc(r.device)} / ${esc(r.filename)}</span><span>${esc(r.error||r.stage||statusLabel[r.status])}</span></div>`).join('')}</div>`:''}
  ${finished.length?`<div class="detail-heading"><h2>转写与分析依据</h2><span class="muted small">展开查看文字、异常与频谱</span></div>${finished.map(r=>detailHtml(r,job)).join('')}`:''}
  <p class="print-note">质量分是 DNSMOS 模型预测，不是人工听懂率。不同文案、音量和录制条件可能影响评分。无正确原稿不计算字错率；无干净参考不计算 STOI / PESQ 或真实声学信噪比。</p>`;
}
$('report-view').addEventListener('click',async e=>{
  if(e.target.id==='refresh-button'){e.target.disabled=true;try{await api(`/api/jobs/${activeJob}/refresh`,{method:'POST'});await openJob(activeJob);}catch(error){toast(error.message);e.target.disabled=false;}}
  if(e.target.id==='retry-button') {
    try{await api(`/api/jobs/${activeJob}/retry`,{method:'POST'});await openJob(activeJob);}catch(error){toast(error.message);}
  }
  const button=e.target.closest('[data-seek]');
  if(button){const audio=document.querySelector(`[data-audio="${button.dataset.seek}"]`);audio.currentTime=Number(button.dataset.time);audio.play().catch(()=>toast('请点击播放器开始试听。'));}
  const wave=e.target.closest('[data-wave]');
  if(wave){const audio=document.querySelector(`[data-audio="${wave.dataset.wave}"]`);const row=latestJob.recordings.find(r=>r.id===wave.dataset.wave);audio.currentTime=(e.clientX-wave.getBoundingClientRect().left)/wave.getBoundingClientRect().width*row.result.audio.duration;audio.play().catch(()=>toast('请点击播放器开始试听。'));}
});
$('report-view').addEventListener('play',e=>{
  if(e.target.tagName==='AUDIO')document.querySelectorAll('audio').forEach(a=>{if(a!==e.target)a.pause();});
},true);
$('report-view').addEventListener('change',e=>{
  if(e.target.id==='match-levels'){
    document.querySelectorAll('[data-audio]').forEach(audio=>{
      const position=audio.currentTime,row=latestJob.recordings.find(r=>r.id===audio.dataset.audio),matched=e.target.checked;
      audio.pause();audio.src=`/api/jobs/${activeJob}/audio/${row.id}/${matched?'matched':'original'}`;
      audio.addEventListener('loadedmetadata',()=>{audio.currentTime=Math.min(position,audio.duration||0);},{once:true});
      document.querySelector(`[data-gain="${row.id}"]`).textContent=matched?`匹配 RMS 电平 · 固定增益 ${fmt(row.result.audio.preview_gain_db,1)} dB · 保留峰值余量`:`原始电平分析副本 · ${row.result.audio.channel_selection} · 已转为 16 kHz 单声道`;
    });
  }
});

function openMethod(){
  const labels={text:'文字归一化',content_score:'内容保真分',keywords:'关键词核对',grouping:'对比范围',decision:'差异提示规则',limits:'解释边界',timeline:'字词定位与时间精度',refresh:'更新分析与结果保留'};
  $('method-content').innerHTML=Object.entries(health?.method||{}).filter(([k])=>k!=='version').map(([k,v])=>`<p><strong>${esc(labels[k]||k)}</strong><br>${esc(v)}</p>`).join('')+'<p><strong>人工可懂度</strong><br>本工具没有招募听众进行听写测试，因此不会自动生成“人工听懂率”。建议用同一原稿做盲听复核。</p><p>DNSMOS 模型与校准来自 Microsoft DNS-Challenge（CC BY 4.0）；Whisper 来自 OpenAI（MIT）。版本及校验值保存在每份结果中。</p>';
  $('method-dialog').showModal();
}
$('method-button').addEventListener('click',openMethod);
$('help-method').addEventListener('click',e=>{e.preventDefault();openMethod();});
$('close-method').addEventListener('click',()=>$('method-dialog').close());
async function init(){
  try{
    health=await api('/api/health');const ready=Object.entries(health.capabilities).filter(([k])=>['ffmpeg','ffprobe','asr','dnsmos'].includes(k)).every(([,v])=>v);
    $('engine-state').textContent=ready?'本地分析已就绪':'部分分析能力未就绪';$('engine-state').classList.toggle('ready',ready);
    await refreshHistory();const match=location.hash.match(/^#test=([a-f0-9]{32})$/);if(match)await openJob(match[1]);
  }catch(error){$('engine-state').textContent='本地服务连接失败';formError(error.message);}
}
init();
