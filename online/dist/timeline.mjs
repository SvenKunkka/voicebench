// Conservative local diagnostics, ported from VoiceBench 1.2+ timeline.py.
const FRAME=.04,DROP=12,MIN_DIP=.08,MAX_DIP=.60,LOW_CONFIDENCE=.45,MOS_WINDOW=9.01;
const finite=(value,fallback=null)=>value!=null&&Number.isFinite(Number(value))?Number(value):fallback;
const rounded=(value,places=3)=>Number(value.toFixed(places));
function percentile(values,percent){if(!values.length)return 0;const sorted=Array.from(values).sort((a,b)=>a-b),index=(sorted.length-1)*percent/100,lower=Math.floor(index);return sorted[lower]+(sorted[Math.ceil(index)]-sorted[lower])*(index-lower);}
function filter(values,percent,size){const radius=Math.floor(size/2);return values.map((_,index)=>{const region=[];for(let i=-radius;i<=radius;i++)region.push(values[Math.max(0,Math.min(values.length-1,index+i))]);region.sort((a,b)=>a-b);return region[Math.min(region.length-1,Math.floor(region.length*percent/100))];});}
function runs(mask){const result=[];let start=-1;for(let i=0;i<=mask.length;i++){if(mask[i]&&start<0)start=i;if(!mask[i]&&start>=0){result.push([start,i]);start=-1;}}return result;}
function timedWords(transcription,duration){
  const raw=transcription.words?.length?transcription.words:(transcription.segments||[]).flatMap(segment=>segment.words||[]),words=[];let position=1;
  for(const item of raw){const text=String(item.text??item.word??'').trim(),start=finite(item.start),end=finite(item.end);
    if(!text||start==null||end==null||start<0||end<start||start>=duration)continue;
    const count=Array.from(text).filter(character=>/[\p{L}\p{N}]/u.test(character)).length;
    let probability=finite(item.probability);if(probability!=null&&(probability<0||probability>1))probability=null;
    words.push({index:words.length,text,start:rounded(start),end:rounded(Math.min(duration,end)),char_start:count?position:null,char_end:count?position+count-1:null,probability,uncertain:probability!=null&&probability<LOW_CONFIDENCE,event_ids:[]});position+=count;
  }return words;
}
function overlap(words,start,end,margin=0){return words.filter(word=>word.end>=start-margin&&word.start<=end+margin).map(word=>word.index);}
function context(words,indices){return indices.length?words.slice(Math.max(0,Math.min(...indices)-2),Math.min(words.length,Math.max(...indices)+3)).map(word=>word.text).join(''):'（没有可靠的字词时间定位）';}
function event(type,label,start,end,evidence,words,precision='40 ms 能量帧；字词边界为识别模型估计'){
  const indices=overlap(words,start,end,.08);
  return{type,label,start:rounded(start),end:rounded(end),severity:'review',evidence,word_indices:indices,word_context:context(words,indices),precision,score_impact:null,interpretation:'待回听候选；不能据此认定收音故障，也不能换算某字使总分下降多少。'};
}
function clippingEvents(audio,duration,words){
  const merged=[];for(const item of [...(audio.clipping_events||[])].sort((a,b)=>finite(a.start,0)-finite(b.start,0))){let start=finite(item.start),end=finite(item.end);if(start==null||end==null||start<0||end<start||start>duration)continue;start=Math.min(duration,start);end=Math.min(duration,end);const previous=merged.at(-1);if(previous&&start-previous[1]<=.08){previous[1]=Math.max(previous[1],end);previous[2]++;}else merged.push([start,end,1]);}
  return merged.map(([start,end,count])=>event('suspected_clipping','连续采样接近满刻度，疑似削波',start,end,`采样检查到 ${count} 组连续至少 3 个采样的绝对值 ≥ 0.999；相距不超过 80 ms 的组已合并。需回听判断是否失真。`,words,'源文件/解码后采样检测（以 audio.decode_method 为准）；时间保存至 1 ms，字词边界为模型估计'));
}
function levelEvents(samples,sampleRate,words,existing){
  const frameSize=Math.max(1,Math.round(sampleRate*FRAME)),count=Math.floor(samples.length/frameSize),duration=samples.length/sampleRate;if(count<12)return{events:[],envelope:[]};
  const levels=[],peaks=[],envelope=[];
  for(let frame=0;frame<count;frame++){let power=0,peak=0;for(let i=frame*frameSize;i<(frame+1)*frameSize;i++){power+=samples[i]**2;peak=Math.max(peak,Math.abs(samples[i]));}const db=20*Math.log10(Math.max(Math.sqrt(power/frameSize),1e-8)),peakDb=20*Math.log10(Math.max(peak,1e-8));levels.push(db);peaks.push(peakDb);envelope.push({start:rounded(frame*frameSize/sampleRate),end:rounded(Math.min(duration,(frame+1)*frameSize/sampleRate)),rms_dbfs:rounded(db,2),peak_dbfs:rounded(peakDb,2)});}
  const baseline=filter(levels,75,31),quiet=levels.map((value,i)=>value<=baseline[i]-DROP&&peaks[i]<=baseline[i]-6),activeFloor=Math.max(-80,percentile(levels,85)-18),events=[];
  for(const [a,b] of runs(quiet)){const start=a*frameSize/sampleRate,end=b*frameSize/sampleRate,length=end-start;if(length+1e-9<MIN_DIP||length>MAX_DIP+1e-9||a<5||b+5>count)continue;
    const left=percentile(levels.slice(a-5,a),50),right=percentile(levels.slice(b,b+5),50),bottom=percentile(levels.slice(a,b),50);
    if(Math.min(left,right)<activeFloor||Math.min(left,right)-bottom<DROP||levels[a-1]-levels[a]<6||levels[b]-levels[b-1]<6)continue;
    if(!words.some(word=>word.start<=start-.02&&word.end>=end+.02))continue;
    events.push(event('word_internal_level_dip','疑似词内电平突降，需回听',start,end,`持续 ${(length*1000).toFixed(0)} ms；区间 RMS 约 ${bottom.toFixed(1)} dBFS，前后 200 ms 中位值为 ${left.toFixed(1)} / ${right.toFixed(1)} dBFS；相对较低一侧下降 ${(Math.min(left,right)-bottom).toFixed(1)} dB。识别词组时间跨过该区间；也可能是正常发音、停顿或时间对齐偏差。`,words));
  }
  const local=filter(peaks,50,15),p95=percentile(peaks,95),prominent=peaks.map((value,i)=>value>=local[i]+20&&value>=p95+6);
  for(const [a,b] of runs(prominent)){const start=a*frameSize/sampleRate,end=b*frameSize/sampleRate;if(b-a>3||a<3||b+3>count||!overlap(words,start,end,.15).length||existing.some(item=>item.start<=end&&item.end>=start))continue;
    let prominence=0;for(let i=a;i<b;i++)prominence=Math.max(prominence,peaks[i]-local[i]);
    events.push(event('short_prominent_peak','短时突出峰值，需检查碰撞声或爆破音',start,end,`40 ms 帧峰值比周围约 600 ms 的中位峰值高 ${prominence.toFixed(1)} dB，且超过整段帧峰值第 95 百分位至少 6 dB；持续不超过 120 ms。也可能来自正常重音，不能仅凭峰值认定噪声或失真。`,words));
  }return{events,envelope};
}
function qualityWindows(mos,duration){
  const windows=[];if(!mos.available)return{windows,localizable:false};
  const values=item=>({signal:finite(item.signal),background:finite(item.background),overall:finite(item.overall)});
  if(mos.repeated_short_audio){const score=values(mos);if(score.overall!=null)windows.push({start:0,end:rounded(duration),...score,repeated_input:true,relative_low:false,precision:'短录音重复补齐后的整段参考，不能用于定位',score_impact:null});return{windows,localizable:false};}
  for(const item of mos.windows||[]){const start=finite(item.start),score=values(item);if(start==null||start<0||start+MOS_WINDOW>duration+.01||score.overall==null)continue;windows.push({start:rounded(start),end:rounded(Math.min(duration,start+MOS_WINDOW)),...score,repeated_input:false,relative_low:false,precision:'9.01 秒重叠窗口；不是逐秒或逐字分数',score_impact:null});}
  const scores=windows.map(window=>window.overall),high=scores.length?Math.max(...scores):0,low=scores.length?Math.min(...scores):0,localizable=new Set(windows.map(window=>window.start)).size>=3&&high-low>=.3;
  if(localizable){const median=percentile(scores,50);for(const window of windows)window.relative_low=window.overall<=median-.15&&window.overall<=high-.3;}
  return{windows,localizable};
}
export function buildTimeline(samples,sampleRate,transcription={},audio={},mos={}){
  if(typeof sampleRate!=='number'||!Number.isFinite(sampleRate)||sampleRate<=0)throw new Error('sample_rate 必须是有效的正采样率。');
  if(!samples||typeof samples.length!=='number'||typeof samples[Symbol.iterator]!=='function')throw new Error('时间轴需要有效单声道一维采样。');
  for(const value of samples)if(typeof value!=='number'||!Number.isFinite(value))throw new Error('时间轴需要有效单声道一维采样，不能包含无效数值。');
  const duration=samples.length/sampleRate,words=timedWords(transcription,duration),events=clippingEvents(audio,duration,words),level=levelEvents(samples,sampleRate,words,events);events.push(...level.events);events.sort((a,b)=>a.start-b.start||a.end-b.end||a.type.localeCompare(b.type));
  events.forEach((item,index)=>{item.id=`event-${index+1}`;for(const wordIndex of item.word_indices)words[wordIndex].event_ids.push(item.id);});
  const uncertain=words.filter(word=>word.uncertain).map(({index,text,start,end,char_start,char_end,probability})=>({index,text,start,end,char_start,char_end,probability,reason:'识别模型对该词组较不确定，可能受口音、专有名词、语言模型或声音影响；不等于收音质量差。'}));
  const {windows,localizable}=qualityWindows(mos,duration),global_issues=[],lufs=finite(audio.integrated_lufs);
  if(lufs!=null&&lufs<-30)global_issues.push({type:'low_recorded_level',label:'整段录音电平偏低，回听时注意音量',evidence:`整体响度 ${lufs.toFixed(1)} LUFS；低于 −30 LUFS 仅触发回听提示，不是合格线，也不代表声学声压、收音故障或听不懂。`,score_impact:null});
  if(audio.digital_silence)global_issues.push({type:'near_digital_silence',label:'接近数字静音',evidence:'没有足够有效信号用于判断人声可懂度。',score_impact:null});
  const lowest=windows.reduce((best,window)=>!best||window.overall<best.overall?window:best,null);
  const limitations=['字词时间来自 Whisper 对齐估计；多字词组共用一个时间区间，未均分或伪造单字时间。个别字的起止时间可能相同，表示模型未分开边界，不代表真实发音时长为零。','字序按转写中 Unicode 字母及数字从 1 计数，标点和空格不计；若模型漏字，无法推断未识别字的真实位置。','电平异常是工程启发式回听候选，正常发音、重音、停顿及对齐误差也可能触发；没有异常候选不等于音质合格。','识别不确定度不等于音质，不能证明某字被录坏；当前没有进行人工盲听或测量人工听懂率。','DNSMOS 评价 9.01 秒重叠窗口；无法把总分因果分配给某个字，score_impact 保持未测。'];
  if(!localizable)limitations.push('真实质量窗口不足 3 个或窗口分差未达到 0.3，不能定位“突然变差”的质量区间；现有分数只作粗粒度参考。');
  if(!words.length)limitations.push('本结果没有可用字词时间，波形异常不会冒充具体字词定位；需重新分析或回听。');
  return{version:'1.2.0-browser',available:!!samples.length,duration:rounded(duration),words,events,audio_faults_confirmed:[],quality_windows:windows,energy_envelope:level.envelope,uncertain_words:uncertain,global_issues,timestamp_source:words.length?'Whisper word_timestamps 模型对齐估计':'unavailable',limitations,
    heuristics:{frame_seconds:FRAME,energy_dip_db:DROP,dip_min_seconds:MIN_DIP,dip_max_seconds:MAX_DIP,dip_requires_spanning_word:true,flank_seconds:.20,onset_recovery_min_db:6,peak_local_prominence_db:20,peak_global_p95_margin_db:6,asr_uncertain_below:LOW_CONFIDENCE,quality_window_seconds:MOS_WINDOW,quality_min_real_windows:3,quality_min_range:.3,low_level_notice_lufs:-30},
    summary:{word_count:words.length,event_count:events.length,uncertain_word_count:uncertain.length,quality_window_count:windows.length,lowest_quality_window:lowest?{start:lowest.start,end:lowest.end,overall:lowest.overall}:null,quality_localization_available:localizable,no_event_reason:events.length?'':'没有达到当前阈值并与有效字词时间交叉验证的局部异常；仍需结合整段质量、转写及回听。'}};
}
