import hashlib
import json
import os
import selectors
import shutil
import subprocess
import time
from pathlib import Path

import numpy as np

from scripts.setup_models import discover_whisper_python

from .audio_metrics import DNSMOS, ROOT, inspect_audio
from .text_metrics import compare_text, normalize


def unscored_text(transcript: str) -> dict:
    """Keep absent ground truth distinct from a zero-error transcription."""
    return {'available': False, 'reason': '未提供正确原稿，未计算字错率或内容保真分。',
            'cer': None, 'content_score': None, 'keyword_accuracy': None,
            'substitutions': None, 'deletions': None, 'insertions': None, 'correct': None,
            'reference_characters': None, 'recognized_characters': len(normalize(transcript)),
            'alignment': [], 'keywords': [], 'normalized_reference': None,
            'normalized_hypothesis': normalize(transcript)}


def whisper_python():
    return discover_whisper_python()


class Engine:
    def __init__(self):
        self.process = None
        self.mos = None
        self.model_hash = None
        self.model = Path.home()/'.cache/whisper/small.pt'
        self.cache = ROOT/'data/cache'
        self.cache.mkdir(parents=True, exist_ok=True)

    def capabilities(self):
        return {'ffmpeg': bool(shutil.which('ffmpeg')), 'ffprobe': bool(shutil.which('ffprobe')),
                'asr': bool(whisper_python() and self.model.is_file()),
                'asr_name': 'Whisper small · 本地独立转写',
                'dnsmos': (ROOT/'models/sig_bak_ovr.onnx').is_file(), 'local_only': True}

    def transcribe(self, path, language):
        if not self.capabilities()['asr']:
            raise RuntimeError('本地 Whisper small 不可用。请检查本机 Whisper 和 small.pt 模型。')
        if self.model_hash is None:
            self.model_hash = hashlib.sha256(self.model.read_bytes()).hexdigest()
        key = hashlib.sha256(path.read_bytes()+self.model_hash.encode()+language.encode()+b'whisper-small-cpu-beam5-t0-word-timing-v2').hexdigest()
        cached = self.cache/f'{key}.json'
        if cached.exists():
            return json.loads(cached.read_text())
        if self.process is None or self.process.poll() is not None:
            log = open(ROOT/'data/whisper.log', 'ab')
            self.process = subprocess.Popen([whisper_python(), '-u', str(ROOT/'app/whisper_worker.py')],
                                            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log, text=True,
                                            env={**os.environ, 'OMP_NUM_THREADS': '4', 'TOKENIZERS_PARALLELISM': 'false'})
            log.close()
        self.process.stdin.write(json.dumps({'path': str(path), 'language': language})+'\n')
        self.process.stdin.flush()
        with selectors.DefaultSelector() as selector:
            selector.register(self.process.stdout, selectors.EVENT_READ)
            if not selector.select(timeout=1200):
                self.process.kill(); self.process = None
                raise RuntimeError('本地转写超过 20 分钟，请缩短录音后重试。')
            line = self.process.stdout.readline()
        if not line:
            raise RuntimeError('本地转写进程意外结束，详细记录在 data/whisper.log；可重试任务。')
        response = json.loads(line)
        if not response['ok']:
            raise RuntimeError('转写失败：'+response['error'])
        result = response['result']
        result['model_sha256'] = self.model_hash
        temporary = cached.with_suffix('.tmp')
        temporary.write_text(json.dumps(result, ensure_ascii=False)); temporary.replace(cached)
        return result

    def analyze(self, row, job, folder, progress):
        started = time.monotonic()
        progress('检查电平与音频完整性')
        audio, samples, decoded = inspect_audio(folder/'source', folder, job['channel'])
        progress('本地转写人声，与原稿独立')
        if audio['digital_silence']:
            transcription = {'text': '', 'segments': [], 'words': [], 'engine': 'digital-silence guard',
                             'version': '1.0', 'settings': {},
                             'timing_note': '接近数字静音，没有可用的字词时间。'}
        else:
            transcription = self.transcribe(decoded, job['language'])
        reference = row.get('reference') or ''
        if reference.strip():
            text = {'available': True, **compare_text(reference, transcription['text'], job['keywords'])}
        else:
            text = unscored_text(transcription['text'])
        progress('预测人声、背景与整体质量')
        try:
            if self.mos is None:
                self.mos = DNSMOS()
            mos = self.mos.score(samples)
        except Exception as error:
            mos = {'available': False, 'reason': str(error)}
        warnings = list(audio['warnings'])
        loudness = audio.get('integrated_lufs')
        if isinstance(loudness, (int, float)) and loudness < -30:
            warnings.append(f'整体响度较低（{loudness:.1f} LUFS），正常播放时可能需要提高音量；建议匹配试听电平后复核清晰度。−30 LUFS 仅为本工具的工程提示阈值，不是产品合格线或平台标准。')
        if audio['duration'] < 9.01:
            warnings.append('录音不足 9.01 秒，DNSMOS 需要重复补齐；建议使用 15～60 秒以上的测试语音。')
        if not transcription['text'].strip() and not audio['digital_silence']:
            warnings.append('模型没有识别出文字；请确认目标声道及录音内容，不能直接认定人类听不懂。')
            mos = {'available': False, 'reason': '未识别出有效文字，不将该录音的 MOS 用于人声比较。'}
        if text['cer'] is not None and text['cer'] > 1:
            warnings.append('CER 超过 100%，可能存在背景人声、识别幻觉或原稿与录音不匹配。')
        excluded = [k['term'] for k in text['keywords'] if k['excluded']]
        if excluded:
            warnings.append('原稿无以下关键词，未计分：'+'、'.join(excluded))
        progress('定位字词时间与待回听片段')
        # Import lazily so an incomplete timeline module cannot stop app startup.
        try:
            from .timeline import build_timeline
            timeline = build_timeline(samples, 16000, transcription, audio, mos)
        except Exception as error:
            timeline = {'available': False, 'reason': '问题时间轴未能生成：'+str(error),
                        'events': [], 'words': [], 'quality_windows': [], 'uncertain_words': [],
                        'global_issues': [], 'summary': {}, 'limitations': []}
            warnings.append(timeline['reason'])
        # Fixed gain only, with headroom. This is RMS matching, not loudness normalization.
        rms = float(np.sqrt(np.mean(samples.astype(np.float64)**2)))
        peak = float(np.max(np.abs(samples)))
        gain = min(10**(-23/20)/max(rms, 1e-12), .95/max(peak, 1e-12)) if peak > 1e-5 else 1.
        p = subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(decoded), '-af', f'volume={gain}',
                            str(folder/'matched.wav')], capture_output=True, timeout=30)
        if p.returncode:
            warnings.append('匹配音量试听副本未生成，仍可试听原始电平副本。')
        audio['preview_gain_db'] = float(20*np.log10(gain))
        audio['preview_note'] = '固定增益匹配 RMS 至 -23 dBFS；采样峰值保留余量时可能达不到目标。不是 LUFS 等响或降噪。'
        model_manifest = json.loads((ROOT/'models/manifest.json').read_text())
        return {'audio': audio, 'text': text, 'mos': mos, 'transcription': transcription,
                'timeline': timeline, 'warnings': warnings,
                'elapsed_seconds': round(time.monotonic()-started, 2),
                'provenance': {'source_sha256': row['sha256'], 'analysis_version': '1.3.1',
                               'asr': {k:v for k,v in transcription.items() if k not in ('text','segments','words')},
                               'dnsmos_commit': model_manifest['commit'],
                               'dnsmos_sha256': model_manifest['files']['sig_bak_ovr.onnx']['sha256'],
                               'channel': job['channel'], 'reference_provided': bool(reference.strip()),
                               'reference_sent_to_asr': False,
                               'ffmpeg_version': subprocess.run(['ffmpeg','-version'],capture_output=True,text=True).stdout.splitlines()[0]}}
