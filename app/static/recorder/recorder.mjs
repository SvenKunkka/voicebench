// Adapted from Vibe Recorder by SvenKunkka, MIT; see LICENSE in this directory.
import { wavHeader } from './wav.mjs';
import { listRecordings, readRecording, saveRecording } from './recording-store.mjs';
const mountedRecorders = new WeakMap();
const recorderTemplate = `    <section class="vr-intro"><h1>录音与录音库</h1><p>录制后自动保存在本机。选择录音，即可加入音质对比流程。</p></section>
    <section class="vr-recorder" aria-label="录音控制">
      <div class="vr-device-picker"><label class="vr-picker-field">录音设备<select data-recorder="deviceSelect" aria-label="录音设备"><option value="">浏览器默认</option></select></label><button type="button" data-recorder="refreshDevices" class="vr-secondary">刷新设备</button></div>
      <p data-recorder="deviceStatus" class="vr-device-status" role="status" aria-live="polite">允许麦克风后，可查看完整设备名称。</p>
      <div class="vr-device-row"><div class="vr-device-field"><label>实际录音输入</label><strong data-recorder="actualInput" class="vr-current-input vr-pending" aria-live="polite">尚未连接</strong></div><button type="button" data-recorder="authorize" class="vr-secondary">允许麦克风</button></div>
      <div data-recorder="connection" class="vr-connection" hidden><span>已连接，可直接开始录音</span><button type="button" data-recorder="disconnect" class="vr-secondary">断开麦克风</button></div>
      <div data-recorder="notice" class="vr-notice" role="status" aria-live="polite">选择录音设备后允许麦克风，实际使用的输入名称会显示在上方。</div>
      <p class="vr-device-help">选择设备会断开旧输入并立即连接新设备。浏览器默认会使用浏览器当前默认麦克风；更改系统默认输入后，请点击「重新连接」。</p>
      <div class="vr-tape">
        <div class="vr-tape-top"><span class="vr-state" data-recorder="state"><i></i><span data-recorder="stateText">准备录音</span></span><span class="vr-format">WAV / 16 位 PCM</span></div>
        <div data-recorder="clock" class="vr-clock" aria-label="录音时间">00:00<span>.0</span></div>
        <div class="vr-wave-wrap"><canvas data-recorder="wave" aria-label="声音波形，录制后可点击定位回放"></canvas><span data-recorder="emptyWave">声音波形会出现在这里</span></div>
        <div class="vr-scale"><span>00:00</span><span data-recorder="level">输入电平 —</span><span data-recorder="duration">00:00</span></div>
      </div>
      <div class="vr-transport"><button type="button" data-recorder="record" class="vr-primary"><span class="vr-record-dot"></span><span data-recorder="recordText">开始录音</span></button><button type="button" data-recorder="stop" class="vr-stop" disabled><span class="vr-stop-square"></span>停止并生成 WAV</button><span data-recorder="technical">保留停顿，不自动裁剪</span></div>
      <div data-recorder="error" class="vr-error" role="alert" hidden></div>
    </section>
    <section class="vr-result" data-recorder="result" hidden aria-label="回放录音">
      <div class="vr-result-head"><div><h2 data-recorder="resultTitle">回听这段录音</h2><p data-recorder="fileInfo"></p></div><button type="button" data-recorder="compareCurrent" class="vr-primary">加入分析</button><a data-recorder="download" class="vr-download" download>下载 WAV <span aria-hidden="true">↓</span></a></div>
      <audio data-recorder="player" controls preload="metadata"></audio>
      <p class="vr-replay-tip">拖动播放进度，或点击上方波形，定位到需要核对的时间。</p>
      <button type="button" data-recorder="retrySave" class="vr-secondary vr-retry-save" hidden>重试保存到录音库</button><button type="button" data-recorder="confirmDownload" class="vr-secondary" hidden>已确认下载成功</button>
    </section>
    <section class="vr-library" aria-label="录音库"><div class="vr-library-head"><div><h2>我的录音</h2><p data-recorder="libraryStatus" aria-live="polite">正在读取录音库…</p></div><button type="button" data-recorder="libraryRefresh" class="vr-secondary">刷新录音库</button></div><p data-recorder="libraryError" class="vr-error" role="alert" hidden></p><div data-recorder="libraryEmpty" class="vr-library-empty">录完第一段后，会自动保存在这里。</div><div class="vr-library-selection"><span data-recorder="selectionStatus" aria-live="polite">已选 0 / 20 段</span><button type="button" data-recorder="compareSelected" class="vr-primary" disabled>将所选录音加入对比</button></div><div data-recorder="libraryList"></div><p class="vr-library-note">录音保存在当前浏览器中。刷新或重新打开同一页面后仍可回听；清除浏览器数据会清空录音库。重要录音可以另行下载 WAV 保存。</p></section>
    <section class="vr-guide"><h2>录音与回听</h2><ol><li><span>开始录音</span>选择录音设备，允许麦克风即可。</li><li><span>停止保存</span>自动加入录音库，可直接录下一段。</li><li><span>回听与对比</span>勾选下方录音，加入分析。</li></ol><p>用于分析的录音请控制在 10 分钟、100 MB 内；录音最长支持 30 分钟。正在录制时请勿关闭页面，停止并显示保存成功后再关闭。</p></section>
`;

export function mountRecorder(container, {onCompare, onStateChange} = {}) {
  if (!container?.querySelector) throw new TypeError('需要有效的录音界面容器。');
  if (mountedRecorders.has(container)) return mountedRecorders.get(container);
  const document = container.ownerDocument || globalThis.document;
  container.classList.add('recorder-workspace');
  container.innerHTML = recorderTemplate;
  const supported = !!(window.isSecureContext && navigator.mediaDevices?.getUserMedia && window.AudioWorkletNode);
  const listeners = [];
  const listen = (target,type,handler) => {
    target?.addEventListener?.(type,handler);
    listeners.push(()=>target?.removeEventListener?.(type,handler));
  };
  let stateSignature = '';
  function canLeave() {
    if (stopping) return {allowed:false,reason:'正在生成并保存录音，请稍候。'};
    if (recording) return {allowed:false,reason:'正在录音，请先停止并保存录音。'};
    if (busy) return {allowed:false,reason:'正在连接麦克风或读取录音，请完成后再切换。'};
    if (unsaved) return {allowed:false,reason:'当前录音尚未保存。请重试保存，或下载并确认副本后再切换。'};
    return {allowed:true,reason:''};
  }
  function notifyState() {
    const state={state:stopping?'saving':recording?'recording':busy?'connecting':unsaved?'unsaved':'ready',
      recording,saving:stopping,unsaved,connected:!!(authorizedStream?.active || stream?.active),canLeave:canLeave()};
    const signature=JSON.stringify(state);
    if (stateSignature===signature) return;
    stateSignature=signature;
    try { onStateChange?.(state); } catch (error) { console.error('录音状态显示未能更新',error); }
  }
const $ = id => container.querySelector(`[data-recorder="${id}"]`);
const ui = Object.fromEntries(['authorize','record','stop','recordText','state','stateText','clock','wave','emptyWave','duration','level','error','notice','result','download','fileInfo','player','technical','actualInput','connection','disconnect','libraryList','libraryStatus','libraryEmpty','libraryError','libraryRefresh','retrySave','resultTitle','compareCurrent','compareSelected','selectionStatus','confirmDownload','deviceSelect','refreshDevices','deviceStatus'].map(id => [id, $(id)]));
let stream, context, source, worklet, sink, wakeLock;
let recording = false, stopping = false, busy = false, savedURL, chunks = [], peaks = [], frames = 0, sampleRate = 48000;
let startedAt = 0, lastChunk = 0, missingFrames = 0, stopAck, watch, unsaved = false, fatal = false;
let deviceLabel = '', capturedSettings = {}, recordingDate;
let authorizedStream = null, authorizedSelection = null;
let selectedDeviceId = '', devices = [], enumerationGeneration = 0, connectionEpoch = 0, refreshingDevices = false, disposed = false;
const deviceNames = new Map();
let currentTakeId = null, pendingTake = null, libraryEntries = [], visibleTake = null;
const selectedTakeIds = new Set();
function stamp(time, tenth = false) {
  const v = Math.max(0, Number.isFinite(time) ? time : 0);
  const base = `${String(Math.floor(v / 60)).padStart(2,'0')}:${String(Math.floor(v % 60)).padStart(2,'0')}`;
  return tenth ? `${base}<span>.${Math.floor((v % 1) * 10)}</span>` : base;
}
function error(message) { ui.error.textContent = message; ui.error.hidden = !message; }
function humanError(e) {
  return ({NotAllowedError:'麦克风权限未开启。请点击地址栏左侧的网站设置，允许使用麦克风，再重试。',NotFoundError:'没有找到麦克风，请连接录音设备后重试。',NotReadableError:'无法读取麦克风。请检查设备连接，以及其他软件是否独占了设备。',OverconstrainedError:'所选输入当前不可用，请检查设备连接，刷新设备后重试。',SecurityError:'浏览器阻止了录音权限，请用本机地址或 HTTPS 页面打开。'})[e.name] || e.message || '录音失败，请检查设备后重试。';
}
function controls() {
  ui.record.disabled = !supported || recording || busy || stopping;
  ui.stop.disabled = !recording || stopping;
  ui.authorize.disabled = !supported || recording || busy || stopping;
  ui.connection.hidden = !authorizedStream?.active;
  ui.authorize.textContent = authorizedStream?.active ? '重新连接' : '允许麦克风';
  ui.disconnect.disabled = recording || busy || stopping;
  ui.deviceSelect.disabled = !supported || recording || busy || stopping;
  ui.refreshDevices.disabled = !supported || typeof navigator.mediaDevices?.enumerateDevices !== 'function' || recording || busy || stopping || refreshingDevices;
  ui.refreshDevices.textContent = refreshingDevices ? '正在刷新…' : '刷新设备';
  ui.libraryRefresh.disabled = recording || busy || stopping;
  ui.retrySave.disabled = recording || busy || stopping;
  ui.libraryList.querySelectorAll('button,input').forEach(button => { button.disabled = recording || busy || stopping; });
  ui.recordText.textContent = busy ? '正在连接…' : '开始录音';
  ui.state.classList.toggle('vr-recording', recording);
  ui.compareCurrent.disabled = !visibleTake || recording || busy || stopping || unsaved;
  ui.compareSelected.disabled = !selectedTakeIds.size || recording || busy || stopping || unsaved;
  ui.selectionStatus.textContent = `已选 ${selectedTakeIds.size} / 20 段`;
  notifyState();
}
// The default option has no deviceId constraint. Explicit selections are held
// only for this page session and always request an exact input without fallback.
const constraints = () => ({audio:{channelCount:{exact:1},echoCancellation:false,noiseSuppression:false,autoGainControl:false,
  ...(selectedDeviceId ? {deviceId:{exact:selectedDeviceId}} : {})},video:false});
function liveTrack() {
  const active = authorizedStream?.active ? authorizedStream : stream?.active ? stream : null;
  const track = active?.getAudioTracks()[0];
  return track?.readyState === 'live' ? track : null;
}
function actualInputName(track) {
  const id = track?.getSettings?.().deviceId;
  return track?.label || deviceNames.get(id) || '麦克风（浏览器未提供名称）';
}
function renderDeviceOptions() {
  const options = [{id:'',label:'浏览器默认'}];
  const seen = new Set(['']);
  for (const device of devices) {
    // Chrome's "default" entry is represented by our default-without-ID option.
    if (!device.deviceId || device.deviceId === 'default' || seen.has(device.deviceId)) continue;
    seen.add(device.deviceId);
    options.push({id:device.deviceId,label:device.label || deviceNames.get(device.deviceId) || `麦克风 ${options.length}`});
  }
  if (selectedDeviceId && !seen.has(selectedDeviceId)) {
    const track = liveTrack(), currentId = track?.getSettings?.().deviceId;
    const connected = !!track && authorizedSelection === selectedDeviceId && (!currentId || currentId === selectedDeviceId);
    const name = connected ? actualInputName(track) : deviceNames.get(selectedDeviceId) || '已选麦克风';
    options.push({id:selectedDeviceId,label:connected ? name : `${name}（暂未列出，请重连确认）`});
  }
  ui.deviceSelect.replaceChildren();
  for (const option of options) {
    const element = document.createElement('option'); element.value=option.id; element.textContent=option.label;
    ui.deviceSelect.append(element);
  }
  ui.deviceSelect.value = selectedDeviceId;
}
async function refreshDeviceList({silent=false} = {}) {
  if (typeof navigator.mediaDevices?.enumerateDevices !== 'function') {
    ui.deviceStatus.textContent='浏览器暂不支持列出设备；仍可使用浏览器默认麦克风。';
    return false;
  }
  const generation=++enumerationGeneration, epoch=connectionEpoch;
  refreshingDevices=true; controls();
  try {
    const listed=await navigator.mediaDevices.enumerateDevices();
    if(disposed || generation!==enumerationGeneration || epoch!==connectionEpoch)return false;
    const inputs=listed.filter(device=>device.kind==='audioinput');
    const usable=inputs.filter(device=>device.deviceId && device.deviceId!=='default');
    if (!usable.length) {
      // Permission-limited and transient empty enumerations must not erase a
      // successfully connected track's identity or a user's explicit selection.
      ui.deviceStatus.textContent=liveTrack() ? '暂未获得完整设备列表，当前实际输入仍以已连接麦克风为准。' : '暂未列出可选设备。请先允许麦克风，或连接设备后点击刷新设备。';
      return false;
    }
    devices=inputs;
    for(const device of inputs)if(device.deviceId && device.label)deviceNames.set(device.deviceId,device.label);
    renderDeviceOptions();
    const missing=selectedDeviceId && !inputs.some(device=>device.deviceId===selectedDeviceId);
    ui.deviceStatus.textContent=missing ? '所选设备暂未出现在列表中；请检查连接后重连，网页不会自动切换到其他输入。' : `发现 ${usable.length} 个录音输入。选择后立即连接；实际输入名称显示在下方。`;
    return true;
  } catch(e) {
    if(disposed || generation!==enumerationGeneration || epoch!==connectionEpoch)return false;
    ui.deviceStatus.textContent='设备列表未能更新，现有选择保持不变。';
    if(!silent)error(`无法刷新录音设备：${humanError(e)}`);
    return false;
  } finally {
    if(generation===enumerationGeneration) {refreshingDevices=false; controls();}
  }
}
function disconnectInput() {
  ++connectionEpoch; ++enumerationGeneration; refreshingDevices=false;
  authorizedStream?.getTracks().forEach(track => { track.onended = null; track.stop(); });
  authorizedStream = null; authorizedSelection = null;
  ui.actualInput.textContent = '尚未连接'; ui.actualInput.classList.add('vr-pending');
}
function showConnectedInput() {
  const track = liveTrack();
  if (!track) { ui.actualInput.textContent = '尚未连接'; ui.actualInput.classList.add('vr-pending'); return; }
  ui.actualInput.textContent = actualInputName(track); ui.actualInput.classList.remove('vr-pending');
  ui.notice.textContent = `当前实际输入：${actualInputName(track)}，可直接开始录音。`;
}
function watchConnectedInput() {
  const idleStream = authorizedStream;
  const track = idleStream?.getAudioTracks()[0];
  if (track) track.onended = () => {
    if (authorizedStream !== idleStream) return;
    disconnectInput();
    ui.notice.textContent = '所选麦克风连接已结束，请检查设备后重新连接。';
    error('录音输入已断开，网页没有自动切换到其他设备。');
    void refreshDeviceList({silent:true}); controls();
  };
}
async function connectInput(reconnect = false) {
  const requested=selectedDeviceId;
  if (reconnect || authorizedSelection !== requested || !authorizedStream?.active) disconnectInput();
  if (!authorizedStream?.active) {
    const epoch=++connectionEpoch; ++enumerationGeneration; refreshingDevices=false;
    let candidate;
    try {
      candidate=await navigator.mediaDevices.getUserMedia(constraints());
      const track=candidate.getAudioTracks()[0];
      if(disposed || epoch!==connectionEpoch || selectedDeviceId!==requested)throw new Error('录音输入选择已变化，请重新连接。');
      if(!track || track.readyState!=='live')throw new Error('未收到有效的所选麦克风输入，请检查设备连接后重试。');
      const actualId=track.getSettings?.().deviceId;
      if(requested && actualId && actualId!==requested)throw new Error('浏览器返回的实际输入与所选设备不一致，已停止该输入；请刷新设备后重新选择。');
      authorizedStream=candidate; authorizedSelection=requested;
      if(requested && track.label)deviceNames.set(requested,track.label);
    } catch(e) {
      candidate?.getTracks().forEach(track=>{track.onended=null;track.stop();});
      authorizedStream=null; authorizedSelection=null;
      throw e;
    }
    renderDeviceOptions();
    void refreshDeviceList({silent:true});
  }
  watchConnectedInput(); showConnectedInput();
}
async function reconnectSelected() {
  if (busy || recording || stopping) return;
  busy = true; error(''); controls();
  ui.notice.textContent = selectedDeviceId ? '正在连接所选录音设备…' : '正在请求浏览器默认麦克风，请允许使用麦克风。';
  try { await connectInput(true); }
  catch(e) { showConnectedInput(); ui.notice.textContent='所选输入未连接，网页不会自动改用其他设备。';error(humanError(e)); }
  finally { busy=false; controls(); }
}
ui.deviceSelect.onchange = async () => {
  if(recording || busy || stopping) {
    ui.deviceSelect.value=selectedDeviceId;
    error('录音、连接或保存期间不能更换输入，请完成当前操作后再选择。');
    return;
  }
  const next=ui.deviceSelect.value;
  if(next===selectedDeviceId)return;
  selectedDeviceId=next;
  await reconnectSelected();
};
ui.refreshDevices.onclick = async () => {
  if(recording || busy || stopping)return;
  await refreshDeviceList();
};
ui.authorize.onclick = reconnectSelected;
ui.disconnect.onclick = async () => {
  if (recording || busy || stopping) return;
  disconnectInput();
  ui.notice.textContent = '麦克风已断开；需要录音时可选择设备或重新连接。';
  controls();
};
ui.record.onclick = start;
async function start() {
  if (recording || busy || stopping) return;
  if (unsaved && !confirm('上一段录音尚未成功保存到录音库，也没有下载。开始新录音会丢失这段未保存的录音，是否继续？')) return;
  busy = true; error(''); controls(); ui.player.pause();
  try {
    ui.actualInput.textContent = '正在连接麦克风…'; ui.actualInput.classList.add('vr-pending');
    await connectInput();
    const retainedTrack = authorizedStream?.getAudioTracks()[0];
    if (retainedTrack?.readyState !== 'live') throw new Error('麦克风连接已断开，请重新连接。');
    stream = authorizedStream; authorizedStream = null;
    const track = stream.getAudioTracks()[0]; capturedSettings = track.getSettings(); deviceLabel = actualInputName(track);
    if (track !== retainedTrack) throw new Error('已授权输入发生变化，请重新连接。');
    context = new AudioContext({sampleRate:capturedSettings.sampleRate || 48000});
    try { await context.audioWorklet.addModule('/static/recorder/pcm-worklet.js', {credentials:'omit'}); }
    catch(e) { throw new Error(`录音模块无法加载，请刷新此本机页面后重试。${e.message}`); }
    source = context.createMediaStreamSource(stream);
    worklet = new AudioWorkletNode(context, 'vibe-pcm', {numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[1],channelCount:1,channelCountMode:'explicit'});
    sink = context.createGain(); sink.gain.value = 0;
    await context.resume();
    if (context.state !== 'running') throw new Error('浏览器音频未能启动，请重新点击开始录音。');
    // Retain the previous completed take until the new input is ready.
    if (savedURL) URL.revokeObjectURL(savedURL); savedURL = null;
    ui.player.removeAttribute('src'); ui.player.load(); ui.result.hidden = true;
    chunks = []; peaks = []; frames = 0; missingFrames = 0; fatal = false; unsaved = false; currentTakeId = null; pendingTake = null; visibleTake = null; ui.retrySave.hidden = true; ui.confirmDownload.hidden = true;
    renderLibrary();
    sampleRate = context.sampleRate; recordingDate = new Date(); startedAt = performance.now(); lastChunk = startedAt;
    worklet.port.onmessage = ({data}) => {
      if (data.type === 'stopped') { stopAck?.(); return; }
      if (data.type !== 'pcm') return;
      chunks.push(data.buffer); peaks.push({start:frames,frames:data.frames,peak:data.peak}); frames += data.frames; missingFrames += data.missing; lastChunk = performance.now();
      ui.level.textContent = `输入电平 ${Math.round(data.peak * 100)}%`;
      ui.clock.innerHTML = stamp(frames / sampleRate, true); ui.duration.textContent = stamp(frames / sampleRate); draw();
      if (frames >= sampleRate * 1800 && recording && !stopping) { error('已达到 30 分钟上限，本段录音已停止。请下载后继续录下一段。'); stop(); }
    };
    worklet.onprocessorerror = () => fail('音频处理发生异常，已停止并保留收到的部分。请下载后重新录制。');
    track.onended = () => fail('录音设备已断开，已停止并保留收到的部分。');
    context.onstatechange = () => { if (recording && !stopping && context.state !== 'running') fail('浏览器音频已中断，已停止并保留收到的部分。请保持电脑唤醒后重新录制。'); };
    source.connect(worklet); worklet.connect(sink); sink.connect(context.destination);
    recording = true; busy = false; ui.emptyWave.hidden = true; ui.stateText.textContent = '正在录音';
    ui.actualInput.textContent = `${deviceLabel || '默认麦克风（浏览器未提供名称）'}（正在使用）`; ui.actualInput.classList.remove('vr-pending');
    ui.notice.textContent = `正在录制 ${deviceLabel || '默认麦克风'}，停顿也会保留。`;
    const dsp = ['echoCancellation','noiseSuppression','autoGainControl'];
    ui.technical.textContent = `${sampleRate / 1000} kHz · 单声道`;
    if (dsp.some(k => capturedSettings[k] === true)) error('浏览器仍启用了声音处理，本次录音可能受到影响。请检查浏览器和系统麦克风设置。');
    watch = setInterval(() => {
      if (recording && !stopping && performance.now() - lastChunk > 4000) fail('超过 4 秒没有收到音频数据，已停止并保留收到的部分。');
    }, 1000);
    controls();
    navigator.wakeLock?.request('screen').then(lock => { if (recording) wakeLock = lock; else lock.release(); }).catch(() => {});
  } catch(e) { await cleanup(true); busy = false; showConnectedInput(); ui.stateText.textContent = savedURL ? '已停止' : '准备录音'; error(humanError(e)); controls(); }
}
function fail(message) { if (!recording || stopping) return; fatal = true; error(message); stop(); }
ui.stop.onclick = stop;
async function stop() {
  if (!recording || stopping) return;
  stopping = true; ui.stateText.textContent = '正在生成 WAV…'; controls(); clearInterval(watch);
  let acknowledged = false;
  try {
    await new Promise(resolve => {
      let timer;
      stopAck = () => { acknowledged = true; clearTimeout(timer); resolve(); };
      timer = setTimeout(resolve, 1500); worklet.port.postMessage('stop');
    });
    if (!acknowledged) { fatal = true; error('音频线程未及时结束，已保留收到的音频，末尾可能不完整。'); }
  } finally {
    recording = false; await cleanup(!fatal);
  }
  try {
    if (!frames) throw new Error('没有收到音频数据，未生成空录音。请检查设备后重试。');
    const blob = new Blob([wavHeader(frames, sampleRate), ...chunks], {type:'audio/wav'}); chunks = [];
    savedURL = URL.createObjectURL(blob); ui.player.src = savedURL;
    ui.download.href = savedURL; ui.download.download = `Vibe_${localDate(recordingDate)}.wav`;
    ui.fileInfo.textContent = `${deviceLabel} · ${stamp(frames / sampleRate)} · ${sampleRate / 1000} kHz · 单声道 · ${(blob.size / 1048576).toFixed(2)} MB`;
    ui.result.hidden = false; unsaved = true;
    ui.resultTitle.textContent = '本次录音';
    ui.clock.innerHTML = stamp(frames / sampleRate, true);
    ui.stateText.textContent = fatal ? '录音中断，部分可下载' : '录音已生成';
    ui.notice.textContent = '正在自动保存到录音库…';
    const metadata = {id:crypto.randomUUID(),createdAt:recordingDate.getTime(),title:displayDate(recordingDate),
      device:deviceLabel,sampleRate,frames,bytes:blob.size,filename:ui.download.download,interrupted:fatal};
    pendingTake = {metadata,blob,peaks:[...peaks]}; visibleTake = {...metadata,blob,peaks:[...peaks]};
    await savePendingTake();
    ui.level.textContent = '点击波形可定位';
    if (missingFrames > 0 && !fatal) error(`本段有 ${(missingFrames / sampleRate).toFixed(3)} 秒未收到输入声道，文件中已保留对应静音，请核对。`);
  } catch(e) { error(humanError(e)); ui.stateText.textContent = '未生成录音'; }
  stopping = false; stopAck = null; controls(); draw();
}
async function cleanup(keepInput = false) {
  clearInterval(watch); source?.disconnect(); worklet?.disconnect(); sink?.disconnect();
  stream?.getTracks().forEach(t => { t.onended = null; if (!keepInput) t.stop(); });
  if (keepInput && stream?.active) { authorizedStream = stream; watchConnectedInput(); }
  stream = null;
  if (!keepInput) showConnectedInput();
  if (context) { context.onstatechange = null; try { await context.close(); } catch {} context = null; }
  try { await wakeLock?.release(); } catch {} wakeLock = null;
}
function localDate(date) { const p = n => String(n).padStart(2,'0'); return `${date.getFullYear()}-${p(date.getMonth()+1)}-${p(date.getDate())}_${p(date.getHours())}-${p(date.getMinutes())}-${p(date.getSeconds())}`; }
ui.download.onclick = () => {
  ui.notice.textContent = '已发起 WAV 下载，请在浏览器下载列表中确认文件保存完成。';
  if (unsaved) { ui.confirmDownload.hidden = false; ui.notice.textContent += ' 保存成功后，点击「已确认下载成功」再切换页面。'; }
};
ui.confirmDownload.onclick = () => { unsaved = false; ui.confirmDownload.hidden = true; ui.notice.textContent = '已确认下载副本，当前录音仍可重试加入录音库。'; controls(); };
function displayDate(date) {
  return new Intl.DateTimeFormat('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(date);
}
function libraryMessage(message) { ui.libraryError.textContent = message; ui.libraryError.hidden = !message; }
async function refreshLibrary() {
  try {
    libraryEntries = await listRecordings();
    for (const id of selectedTakeIds) if (!libraryEntries.some(entry => entry.id === id)) selectedTakeIds.delete(id);
    renderLibrary(); libraryMessage('');
  } catch(e) { libraryMessage(`录音库暂时不可用：${humanError(e)} 新录音仍可手动下载 WAV。`); }
}
function renderLibrary() {
  ui.libraryList.replaceChildren();
  ui.libraryEmpty.hidden = libraryEntries.length > 0;
  const total = libraryEntries.reduce((n,entry)=>n+entry.bytes,0);
  ui.libraryStatus.textContent = `${libraryEntries.length} 段录音 · ${(total/1048576).toFixed(2)} MB`;
  for (const entry of libraryEntries) {
    const row = document.createElement('article'); row.className = 'vr-recording-row'; row.dataset.recordingId = entry.id;
    const selected = entry.id === currentTakeId; row.classList.toggle('vr-selected',selected);
    const choose = document.createElement('input'); choose.type='checkbox'; choose.checked=selectedTakeIds.has(entry.id);
    choose.setAttribute('aria-label',`选择 ${entry.title} 加入对比`); choose.dataset.takeId=entry.id;
    choose.onchange=()=>{
      if (choose.checked) {
        if (selectedTakeIds.size >= 20) { choose.checked=false; libraryMessage('每次最多选择 20 段录音。'); return; }
        selectedTakeIds.add(entry.id);
      } else selectedTakeIds.delete(entry.id);
      libraryMessage(''); controls();
    };
    const play = document.createElement('button'); play.className='vr-recording-play'; play.type='button';
    play.setAttribute('aria-label',`播放 ${entry.title}`); play.setAttribute('aria-pressed',String(selected));
    const icon = document.createElement('span'); icon.className='vr-play-icon'; icon.textContent='▶'; icon.setAttribute('aria-hidden','true');
    const text = document.createElement('span'); text.className='vr-recording-text';
    const title = document.createElement('strong'); title.textContent=entry.title;
    const details = document.createElement('span'); details.textContent=`${stamp(entry.frames/entry.sampleRate)} · ${entry.device || '麦克风'} · ${(entry.bytes/1048576).toFixed(2)} MB${entry.interrupted?' · 中断录音':''}`;
    text.append(title,details); play.append(icon,text);
    const download = document.createElement('button'); download.type='button'; download.className='vr-library-download';
    download.textContent='下载 WAV'; download.setAttribute('aria-label',`下载 ${entry.title}`);
    play.onclick=()=>openTake(entry.id,true); download.onclick=()=>downloadTake(entry.id);
    row.append(choose,play,download); ui.libraryList.append(row);
  }
  controls();
}
async function savePendingTake() {
  if (!pendingTake) return;
  const take = pendingTake;
  try {
    await saveRecording(take.metadata,take.blob,take.peaks);
    currentTakeId = take.metadata.id; pendingTake = null; unsaved = false; ui.retrySave.hidden = true; ui.confirmDownload.hidden = true;
    ui.stateText.textContent = take.metadata.interrupted ? '中断前的录音已保存' : '已保存到录音库';
    ui.notice.textContent = '本段已自动保存，可以直接录下一段；下方录音库可随时回听。';
    await refreshLibrary();
  } catch(e) {
    unsaved = true; ui.retrySave.hidden = false;
    ui.stateText.textContent = '录音已生成，自动保存未成功';
    const cause = e.name === 'QuotaExceededError' ? '浏览器存储空间不足' : humanError(e);
    libraryMessage(`本次录音尚未保存：${cause}。请先下载 WAV 保留；已有录音不会被替换。`);
    ui.notice.textContent = '自动保存未成功，请下载本次录音，或点击「重试保存」。';
  }
}
async function openTake(id,autoplay=false) {
  if (recording || busy || stopping) return;
  if (unsaved) { error('当前录音还未保存，请先下载 WAV 或重试保存，再打开历史录音。'); return; }
  busy=true; controls(); ui.player.pause(); error('');
  try {
    const take=await readRecording(id); visibleTake = take;
    if (savedURL) URL.revokeObjectURL(savedURL);
    savedURL=URL.createObjectURL(take.blob); ui.player.src=savedURL;
    ui.download.href=savedURL; ui.download.download=take.filename;
    frames=take.frames; sampleRate=take.sampleRate; peaks=take.peaks;
    currentTakeId=id; ui.result.hidden=false; ui.resultTitle.textContent=`回听 ${take.title}`;
    ui.fileInfo.textContent=`${take.device} · ${stamp(frames/sampleRate)} · ${sampleRate/1000} kHz · 单声道 · ${(take.bytes/1048576).toFixed(2)} MB`;
    ui.clock.innerHTML=stamp(0,true); ui.duration.textContent=stamp(frames/sampleRate); ui.emptyWave.hidden=true;
    ui.level.textContent='点击波形可定位'; ui.stateText.textContent='回听历史录音';
    ui.notice.textContent='这段录音已保存在录音库中，回听后可直接开始下一段。';
    draw(); renderLibrary();
    if (autoplay) {
      try { await ui.player.play(); } catch { ui.notice.textContent='录音已载入，点击播放器的播放按钮即可回听。'; }
    }
  } catch(e) { libraryMessage(humanError(e)); }
  finally { busy=false; controls(); }
}
async function downloadTake(id) {
  if (recording || busy || stopping) return;
  busy=true; controls();
  try {
    const take=await readRecording(id); const url=URL.createObjectURL(take.blob);
    const link=document.createElement('a'); link.href=url; link.download=take.filename;
    document.body.append(link); link.click(); link.remove(); setTimeout(()=>URL.revokeObjectURL(url),60000);
  } catch(e) { libraryMessage(humanError(e)); }
  finally { busy=false; controls(); }
}
ui.libraryRefresh.onclick=refreshLibrary;
ui.retrySave.onclick=async()=>{if(busy||recording||stopping)return;busy=true;controls();try{await savePendingTake();}finally{busy=false;controls();}};
listen(window, 'focus',()=>{if(!recording&&!busy&&!stopping)refreshLibrary();});
function draw() {
  const canvas = ui.wave, rect = canvas.getBoundingClientRect(), dpr = devicePixelRatio || 1;
  if (!rect.width) return;
  canvas.width = Math.round(rect.width * dpr); canvas.height = Math.round(rect.height * dpr);
  const ctx = canvas.getContext('2d'); ctx.scale(dpr,dpr);
  const w = rect.width, h = rect.height;
  ctx.strokeStyle = '#e0e7ec'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0,h/2);ctx.lineTo(w,h/2);ctx.stroke();
  const buckets = new Float32Array(Math.max(1, Math.floor(w / 2)));
  const span = Math.max(sampleRate * 5, frames);
  for (const p of peaks) { const index = Math.min(buckets.length-1, Math.floor(p.start / span * buckets.length)); buckets[index] = Math.max(buckets[index],p.peak); }
  ctx.strokeStyle = '#087f8c'; ctx.lineWidth = 1.4; ctx.beginPath();
  for(let i=0;i<buckets.length;i++) if(buckets[i]>0) {const x=i/buckets.length*w,y=Math.max(1,buckets[i]*h*.45);ctx.moveTo(x,h/2-y);ctx.lineTo(x,h/2+y);} ctx.stroke();
  if (frames) {const pos=recording?frames:ui.player.currentTime*sampleRate;const x=Math.min(w,pos/span*w);ctx.strokeStyle=recording?'#d84151':'#db8b36';ctx.lineWidth=1.5;ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,h);ctx.stroke();}
}
ui.wave.onclick = e => {
  if (recording || stopping || !savedURL) return;
  const rect = ui.wave.getBoundingClientRect(); ui.player.currentTime = Math.min(frames/sampleRate, Math.max(0,(e.clientX-rect.left)/rect.width*Math.max(5,frames/sampleRate)));
  ui.clock.innerHTML = stamp(ui.player.currentTime,true); draw();
};
ui.player.ontimeupdate = () => { ui.clock.innerHTML = stamp(ui.player.currentTime,true); draw(); };
ui.player.onseeked = () => { ui.clock.innerHTML = stamp(ui.player.currentTime,true); draw(); };
const resizeObserver = new ResizeObserver(draw); resizeObserver.observe(ui.wave);
listen(window, 'pagehide', () => { authorizedStream?.getTracks().forEach(t => t.stop()); stream?.getTracks().forEach(t => t.stop()); });
listen(window, 'beforeunload',e => {if(recording||busy||stopping||unsaved){e.preventDefault();e.returnValue='';}});
listen(navigator.mediaDevices, 'devicechange', () => {
  // Refresh the choices, never replace a live recording or fall back silently.
  void refreshDeviceList({silent:true});
  if(!recording && !busy && !stopping)ui.notice.textContent='检测到录音设备变化。可重新选择设备，或点击「重新连接」确认当前输入。';
});
if (!supported) { error('当前浏览器不支持此录音方式，请用最新版 Chrome / Edge 打开，或使用本机网页入口。'); ui.record.disabled=true;ui.authorize.disabled=true; }
draw();
renderDeviceOptions();
const ready = Promise.all([refreshLibrary(),refreshDeviceList({silent:true})]);
async function compareTakes(takes) {
  if (typeof onCompare !== 'function') { error('当前页面未连接录音分析功能。'); return; }
  if (!takes.length || takes.length > 20) { libraryMessage('请选择 1～20 段录音。'); return; }
  const items=takes.map(take=>({id:take.id,blob:take.blob,filename:take.filename,device:take.device||'默认麦克风',createdAt:take.createdAt,
    duration:take.sampleRate>0 && take.frames>=0?take.frames/take.sampleRate:null}));
  await onCompare(items);
}
ui.compareCurrent.onclick = async () => {
  if (!canLeave().allowed || !visibleTake) return;
  ui.player.pause();
  try { await compareTakes([visibleTake]); } catch(e) { error(humanError(e)); }
};
ui.compareSelected.onclick = async () => {
  if (!canLeave().allowed || !selectedTakeIds.size) return;
  busy=true; controls(); ui.player.pause(); libraryMessage('');
  let takes;
  try { takes=await Promise.all([...selectedTakeIds].map(id=>readRecording(id))); }
  catch(e) { libraryMessage(humanError(e)); }
  finally { busy=false; controls(); }
  if (takes) { try { await compareTakes(takes); } catch(e) { libraryMessage(humanError(e)); } }
};
const controller={ready,canLeave,pausePlayback:()=>ui.player.pause(),
  refresh:async()=>{if(recording||busy||stopping)return false;await refreshLibrary();return true;},
  destroy:()=>{
    const permission=canLeave(); if(!permission.allowed)return permission;
    disposed=true; ui.player.pause(); disconnectInput(); clearInterval(watch); resizeObserver.disconnect();
    for(const remove of listeners)remove();
    if(savedURL)URL.revokeObjectURL(savedURL);
    mountedRecorders.delete(container); container.replaceChildren();
    return {allowed:true,reason:''};
  }};
mountedRecorders.set(container,controller);
controls();
return controller;
}
