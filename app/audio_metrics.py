import hashlib
import json
import math
import subprocess
from pathlib import Path

import numpy as np
import onnxruntime as ort
from scipy.signal import resample_poly

ROOT = Path(__file__).resolve().parents[1]


def command(args, timeout=120):
    p = subprocess.run(args, capture_output=True, timeout=timeout)
    if p.returncode:
        raise ValueError('无法解码音频，请检查文件是否完整，或改用 WAV／MP3／M4A。')
    return p.stdout, p.stderr


def db(value):
    return float(20*np.log10(value)) if value > 0 else None


def inspect_audio(path: Path, directory: Path, channel: str) -> tuple[dict, np.ndarray, Path]:
    raw, _ = command(['ffprobe', '-v', 'error', '-select_streams', 'a:0', '-show_streams',
                      '-show_format', '-of', 'json', str(path)])
    probe = json.loads(raw)
    if not probe.get('streams'):
        raise ValueError('文件中没有音频轨道。')
    stream = probe['streams'][0]
    sr, channels = int(stream['sample_rate']), int(stream['channels'])
    duration = float(stream.get('duration') or probe.get('format', {}).get('duration') or 0)
    if not 0 < duration <= 600:
        raise ValueError('每份录音需要在 0～10 分钟之间；请先分段。')
    if channels > 8 or sr > 192000:
        raise ValueError('最多支持 8 声道、192 kHz；请先导出需要比较的声道。')
    if duration*sr*channels > 60_000_000:
        raise ValueError('这份多声道或高采样率录音解码后过大，请先缩短或导出需要的声道。')
    # Decode at native sample rate so clipping statistics are not altered by resampling.
    raw, _ = command(['ffmpeg', '-v', 'error', '-i', str(path), '-map', '0:a:0', '-t', '600',
                      '-f', 'f32le', '-acodec', 'pcm_f32le', '-'])
    audio = np.frombuffer(raw, dtype='<f4').reshape(-1, channels)
    if not len(audio) or not np.isfinite(audio).all():
        raise ValueError('音频为空，或包含无效采样值。')
    if channel == 'second' and channels < 2:
        raise ValueError('已选择第二声道，但这份录音只有一个声道。')
    if channel == 'mix':
        selected = audio.mean(axis=1)
        selection = '所有声道平均混合'
    else:
        index = 1 if channel == 'second' else 0
        selected = audio[:, index].copy()
        selection = f'第 {index+1} 声道'
    peak = float(np.max(np.abs(selected)))
    rms = float(np.sqrt(np.mean(selected.astype(np.float64)**2)))
    clipping = np.abs(selected) >= 0.999
    transitions = np.diff(np.r_[False, clipping, False].astype(np.int8))
    starts, ends = np.where(transitions == 1)[0], np.where(transitions == -1)[0]
    events = [{'start': round(float(a/sr), 3), 'end': round(float(b/sr), 3)}
              for a, b in zip(starts, ends) if b-a >= 3]
    target_sr = 16000
    divisor = math.gcd(sr, target_sr)
    mono = resample_poly(selected, target_sr//divisor, sr//divisor).astype(np.float32)
    pcm_path = directory/'analysis.wav'
    # The analysis WAV is floating point and retains the original level.
    # ffmpeg writes an interoperable PCM WAV for ASR/browser playback; no gain adjustment.
    p = subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'f32le', '-ar', str(target_sr),
                        '-ac', '1', '-i', '-', '-c:a', 'pcm_s16le', str(pcm_path)],
                       input=mono.tobytes(), capture_output=True, timeout=30)
    if p.returncode:
        raise ValueError('分析副本生成失败。')
    frames = len(mono)//320
    frame_rms = np.sqrt(np.mean(mono[:frames*320].reshape(-1, 320).astype(np.float64)**2, axis=1)) if frames else np.array([rms])
    # This is an absolute energy threshold, not VAD or a speech/noise separation.
    quiet = frame_rms < 10**(-50/20)
    qtrans = np.diff(np.r_[False, quiet, False].astype(np.int8))
    quiet_events = [{'start': round(float(a*.02), 2), 'end': round(float(b*.02), 2)}
                    for a, b in zip(np.where(qtrans == 1)[0], np.where(qtrans == -1)[0]) if b-a >= 25]
    waveform = [float(np.max(np.abs(x))) for x in np.array_split(mono, min(400, len(mono))) if len(x)]
    spectrum = []
    if len(mono) >= 1024:
        from scipy.signal import welch
        freqs, powers = welch(mono, fs=target_sr, nperseg=1024)
        for a, b in zip(np.geomspace(80, 7900, 65)[:-1], np.geomspace(80, 7900, 65)[1:]):
            mask = (freqs >= a) & (freqs < b)
            spectrum.append({'hz': float(np.sqrt(a*b)), 'db': float(10*np.log10(max(float(powers[mask].mean()) if mask.any() else 0, 1e-15)))})
    # Measure selected native-rate audio, keeping LUFS separate from resampled ASR input.
    p = subprocess.run(['ffmpeg', '-hide_banner', '-f', 'f32le', '-ar', str(sr), '-ac', '1',
                        '-i', '-', '-af', 'loudnorm=I=-23:TP=-1:LRA=7:print_format=json',
                        '-f', 'null', '-'], input=selected.astype('<f4').tobytes(),
                       capture_output=True, timeout=120)
    loudness = {}
    loudness_warning = None
    if p.returncode == 0:
        stderr = p.stderr.decode(errors='replace')
        try:
            # FFmpeg prints summary lines after its JSON object on some builds.
            out, _ = json.JSONDecoder().raw_decode(stderr[stderr.rfind('{'):])
            for key, name in [('input_i', 'integrated_lufs'), ('input_tp', 'true_peak_dbtp'), ('input_lra', 'loudness_range_lu')]:
                val = float(out[key])
                loudness[name] = val if math.isfinite(val) else None
        except (ValueError, KeyError):
            loudness_warning = '响度分析输出未能解析，LUFS 与真峰值不计分。'
    else:
        loudness_warning = '响度分析未成功，LUFS 与真峰值不计分。'
    warnings = [loudness_warning] if loudness_warning else []
    if events:
        warnings.append(f'发现 {len(events)} 处连续接近满刻度的采样，疑似削波，需回听确认。')
    if peak < 1e-5:
        warnings.append('录音接近数字静音，无法评价有效人声质量。')
    if channels > 1:
        levels = [db(float(np.sqrt(np.mean(audio[:, i].astype(np.float64)**2)))) for i in range(channels)]
        if channel == 'mix' and all(x is not None for x in levels[:2]) and rms < max(np.sqrt(np.mean(audio[:, i].astype(np.float64)**2)) for i in range(channels))*.3:
            warnings.append('混合后能量明显下降，可能存在声道反相；建议分别分析声道。')
        warnings.append(f'源文件为 {channels} 声道，本次使用{selection}；请确认该声道承载目标人声。')
    return {'duration': len(selected)/sr, 'sample_rate': sr, 'channels': channels, 'channel_selection': selection,
            'codec': stream.get('codec_name'), 'sample_peak_dbfs': db(peak), 'rms_dbfs': db(rms),
            'near_full_scale_percent': float(clipping.mean()*100), 'clipping_events': events[:100],
            'low_energy_percent': float(quiet.mean()*100), 'low_energy_events': quiet_events[:100],
            'waveform': waveform, 'spectrum': spectrum, 'warnings': warnings,
            'digital_silence': peak < 1e-5, **loudness}, mono, pcm_path


# Adapted from Microsoft DNS-Challenge; this class retains CC BY 4.0.
# See THIRD_PARTY_NOTICES.md and models/DNS-Challenge-LICENSE.txt.
class DNSMOS:
    """DNSMOS P.835 non-personalized, polynomial calibration from Microsoft.

    Adaptation: mono audio is decoded separately; scores are also returned per window.
    P.808 is deliberately not approximated. Source and model hashes: models/manifest.json.
    """
    def __init__(self):
        self.model = ROOT/'models/sig_bak_ovr.onnx'
        manifest = json.loads((ROOT/'models/manifest.json').read_text())
        digest = hashlib.sha256(self.model.read_bytes()).hexdigest()
        if digest != manifest['files'][self.model.name]['sha256']:
            raise ValueError('DNSMOS 模型校验失败。')
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = 2
        self.session = ort.InferenceSession(str(self.model), sess_options=opts, providers=['CPUExecutionProvider'])
        self.digest = digest

    def score(self, audio: np.ndarray) -> dict:
        original_length = len(audio)
        if not original_length or np.max(np.abs(audio)) < 1e-5:
            return {'available': False, 'reason': '接近数字静音，不计算人声质量分数。'}
        length = int(9.01*16000)
        while len(audio) < length:
            audio = np.concatenate([audio, audio])
        # Preserve the upstream window count and one-second stride exactly.
        hops = int(np.floor(len(audio)/16000)-9.01)+1
        windows = []
        for index in range(hops):
            segment = audio[index*16000:index*16000+length]
            if len(segment) != length:
                continue
            sig, bak, overall = self.session.run(None, {self.session.get_inputs()[0].name: segment[np.newaxis].astype(np.float32)})[0][0]
            values = [np.polyval([-0.08397278, 1.22083953, 0.0052439], sig),
                      np.polyval([-0.13166888, 1.60915514, -0.39604546], bak),
                      np.polyval([-0.06766283, 1.11546468, 0.04602535], overall)]
            windows.append({'start': index, 'signal': float(values[0]), 'background': float(values[1]), 'overall': float(values[2])})
        return {'available': True, 'signal': float(np.mean([x['signal'] for x in windows])),
                'background': float(np.mean([x['background'] for x in windows])),
                'overall': float(np.mean([x['overall'] for x in windows])), 'windows': windows,
                'repeated_short_audio': original_length < length, 'model_sha256': self.digest,
                'note': '模型预测 MOS，通常按 1～5 分解读；不是人工听懂率。少于 9.01 秒的录音按上游方法重复补齐。'}
