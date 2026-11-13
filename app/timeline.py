"""Conservative time-local diagnostics; neither a word-level MOS nor fault proof."""
from __future__ import annotations

import math
import unicodedata

import numpy as np
from scipy.ndimage import percentile_filter

FRAME_SECONDS = 0.04
DROP_DB = 12.0
MIN_DIP_SECONDS = 0.08
MAX_DIP_SECONDS = 0.60
LOW_CONFIDENCE = 0.45
MOS_WINDOW_SECONDS = 9.01


def _finite(value, default=None):
    try:
        number = float(value)
        return number if math.isfinite(number) else default
    except (TypeError, ValueError):
        return default


def _count_characters(text):
    return sum(unicodedata.category(character)[0] in 'LN' for character in text)


def _words(transcription, duration):
    raw = transcription.get('words') or [word for segment in transcription.get('segments', [])
                                         for word in segment.get('words', [])]
    result = []
    char_position = 1
    for item in raw:
        text = str(item.get('text', item.get('word', ''))).strip()
        start, end = _finite(item.get('start')), _finite(item.get('end'))
        if not text or start is None or end is None or start < 0 or end < start or start >= duration:
            continue
        end = min(duration, end)
        # Punctuation shares the actual model token's time; it does not get invented time.
        characters = _count_characters(text)
        probability = _finite(item.get('probability'))
        if probability is not None and not 0 <= probability <= 1:
            probability = None
        result.append({'index': len(result), 'text': text, 'start': round(start, 3), 'end': round(end, 3),
                       'char_start': char_position if characters else None,
                       'char_end': char_position + characters - 1 if characters else None,
                       'probability': probability, 'uncertain': probability is not None and probability < LOW_CONFIDENCE,
                       'event_ids': []})
        char_position += characters
    return result


def _runs(mask):
    edges = np.diff(np.r_[False, mask, False].astype(np.int8))
    return list(zip(np.flatnonzero(edges == 1), np.flatnonzero(edges == -1)))


def _overlap_words(words, start, end, margin=0):
    return [word['index'] for word in words
            if word['end'] >= start - margin and word['start'] <= end + margin]


def _context(words, indices):
    if not indices:
        return '（没有可靠的字词时间定位）'
    lower, upper = max(0, min(indices) - 2), min(len(words), max(indices) + 3)
    return ''.join(word['text'] for word in words[lower:upper])


def _event(kind, label, start, end, evidence, words, severity='review', precision=None):
    indices = _overlap_words(words, start, end, margin=0.08)
    return {'type': kind, 'label': label, 'start': round(float(start), 3), 'end': round(float(end), 3),
            'severity': severity, 'evidence': evidence, 'word_indices': indices,
            'word_context': _context(words, indices),
            'precision': precision or '40 ms 能量帧；字词边界为识别模型估计',
            'score_impact': None,
            'interpretation': '待回听候选；不能据此认定收音故障，也不能换算某字使总分下降多少。'}


def _clipping_events(audio_metrics, duration, words):
    merged = []
    for item in sorted(audio_metrics.get('clipping_events', []), key=lambda value: _finite(value.get('start'), 0)):
        start, end = _finite(item.get('start')), _finite(item.get('end'))
        if start is None or end is None or start < 0 or end < start or start > duration:
            continue
        start, end = min(duration, start), min(duration, end)
        if merged and start - merged[-1][1] <= 0.08:
            merged[-1][1] = max(merged[-1][1], end)
            merged[-1][2] += 1
        else:
            merged.append([start, end, 1])
    return [_event('suspected_clipping', '连续采样接近满刻度，疑似削波', start, end,
                   f'原采样率检查到 {count} 组连续至少 3 个采样的绝对值 ≥ 0.999；相距不超过 80 ms 的组已合并。需回听判断是否失真。',
                   words, precision='源文件采样检测；时间保存至 1 ms，字词边界为模型估计')
            for start, end, count in merged]


def _level_events(samples, sample_rate, words, existing):
    """Locate abrupt relative energy changes, excluding between-word ordinary pauses."""
    frame_size = max(1, round(sample_rate * FRAME_SECONDS))
    count = len(samples) // frame_size
    if count < 12:
        return [], []
    frames = samples[:count * frame_size].reshape(count, frame_size).astype(np.float64)
    levels = np.sqrt(np.mean(frames * frames, axis=1))
    peaks = np.max(np.abs(frames), axis=1)
    db = 20 * np.log10(np.maximum(levels, 1e-8))
    peak_db = 20 * np.log10(np.maximum(peaks, 1e-8))
    duration = len(samples) / sample_rate
    envelope = [{'start': round(index * frame_size / sample_rate, 3),
                 'end': round(min(duration, (index + 1) * frame_size / sample_rate), 3),
                 'rms_dbfs': round(float(value), 2), 'peak_dbfs': round(float(peak_db[index]), 2)}
                for index, value in enumerate(db)]
    # A 1.24-second neighborhood is a local comparison baseline, not noise estimation.
    baseline = percentile_filter(db, percentile=75, size=31, mode='nearest')
    quiet = (db <= baseline - DROP_DB) & (peak_db <= baseline - 6)
    active_floor = max(-80.0, float(np.percentile(db, 85)) - 18)
    found = []
    for a, b in _runs(quiet):
        start, end = a * frame_size / sample_rate, b * frame_size / sample_rate
        length = end - start
        if length + 1e-9 < MIN_DIP_SECONDS or length > MAX_DIP_SECONDS + 1e-9 or a < 5 or b + 5 > count:
            continue
        left, right = float(np.median(db[a - 5:a])), float(np.median(db[b:b + 5]))
        bottom = float(np.median(db[a:b]))
        if min(left, right) < active_floor or min(left, right) - bottom < DROP_DB:
            continue
        if db[a - 1] - db[a] < 6 or db[b] - db[b - 1] < 6:
            continue
        # A model word must span both sides. Gaps between words remain ordinary pauses.
        spanning = [word for word in words if word['start'] <= start - 0.02 and word['end'] >= end + 0.02]
        if not spanning:
            continue
        found.append(_event('word_internal_level_dip', '疑似词内电平突降，需回听', start, end,
                            f'持续 {length * 1000:.0f} ms；区间 RMS 约 {bottom:.1f} dBFS，前后 200 ms 中位值为 {left:.1f} / {right:.1f} dBFS；'
                            f'相对较低一侧下降 {min(left, right) - bottom:.1f} dB。识别词组时间跨过该区间；也可能是正常发音、停顿或时间对齐偏差。', words))
    # Very short prominent peaks can be clicks/plosives. They are candidates, not noise labels.
    local_peak = percentile_filter(peak_db, percentile=50, size=15, mode='nearest')
    prominent = (peak_db >= local_peak + 20) & (peak_db >= float(np.percentile(peak_db, 95)) + 6)
    for a, b in _runs(prominent):
        start, end = a * frame_size / sample_rate, b * frame_size / sample_rate
        if b - a > 3 or a < 3 or b + 3 > count:
            continue
        if not _overlap_words(words, start, end, margin=0.15):
            continue
        if any(item['start'] <= end and item['end'] >= start for item in existing):
            continue
        prominence = float(np.max(peak_db[a:b] - local_peak[a:b]))
        found.append(_event('short_prominent_peak', '短时突出峰值，需检查碰撞声或爆破音', start, end,
                            f'40 ms 帧峰值比周围约 600 ms 的中位峰值高 {prominence:.1f} dB，且超过整段帧峰值第 95 百分位至少 6 dB；'
                            '持续不超过 120 ms。也可能来自正常重音，不能仅凭峰值认定噪声或失真。', words))
    return found, envelope


def _quality_windows(mos, duration):
    windows = []
    if not mos.get('available'):
        return windows, False
    repeated = bool(mos.get('repeated_short_audio'))
    if repeated:
        # Upstream repeats the source. Its artificial extension has no real timestamps.
        values = {name: _finite(mos.get(name)) for name in ('signal', 'background', 'overall')}
        if values['overall'] is not None:
            windows.append({'start': 0.0, 'end': round(duration, 3), **values,
                            'repeated_input': True, 'relative_low': False,
                            'precision': '短录音重复补齐后的整段参考，不能用于定位', 'score_impact': None})
        return windows, False
    for item in mos.get('windows', []):
        start = _finite(item.get('start'))
        if start is None or start < 0 or start + MOS_WINDOW_SECONDS > duration + 0.01:
            continue
        values = {name: _finite(item.get(name)) for name in ('signal', 'background', 'overall')}
        if values['overall'] is None:
            continue
        windows.append({'start': round(start, 3), 'end': round(min(duration, start + MOS_WINDOW_SECONDS), 3),
                        **values, 'repeated_input': False, 'relative_low': False,
                        'precision': '9.01 秒重叠窗口；不是逐秒或逐字分数', 'score_impact': None})
    scores = [window['overall'] for window in windows]
    enough = len({window['start'] for window in windows}) >= 3
    localizable = enough and max(scores, default=0) - min(scores, default=0) >= 0.3
    if localizable:
        median = float(np.median(scores))
        high = max(scores)
        for window in windows:
            window['relative_low'] = window['overall'] <= median - 0.15 and window['overall'] <= high - 0.3
    return windows, bool(localizable)


def build_timeline(samples: np.ndarray, sample_rate: int, transcription: dict, audio_metrics: dict, mos: dict) -> dict:
    """Map conservative acoustic candidates to actual ASR word/group timestamps.

    ``word_indices`` use the zero-based ``words[].index`` values. Character positions
    are one-based Unicode letter/number positions, excluding punctuation/whitespace.
    """
    if not isinstance(sample_rate, (int, float)) or not math.isfinite(sample_rate) or sample_rate <= 0:
        raise ValueError('sample_rate 必须是有效的正采样率。')
    samples = np.asarray(samples, dtype=np.float32)
    if samples.ndim != 1:
        raise ValueError('时间轴需要单声道一维采样。')
    if not np.isfinite(samples).all():
        raise ValueError('时间轴采样包含无效数值。')
    duration = len(samples) / sample_rate
    words = _words(transcription, duration)
    events = _clipping_events(audio_metrics, duration, words)
    relative, envelope = _level_events(samples, int(sample_rate), words, events)
    events += relative
    events.sort(key=lambda item: (item['start'], item['end'], item['type']))
    for index, event in enumerate(events):
        event['id'] = f'event-{index + 1}'
        for word_index in event['word_indices']:
            words[word_index]['event_ids'].append(event['id'])
    uncertain = [{key: word[key] for key in ('index', 'text', 'start', 'end', 'char_start', 'char_end', 'probability')}
                 | {'reason': '识别模型对该词组较不确定，可能受口音、专有名词、语言模型或声音影响；不等于收音质量差。'}
                 for word in words if word['uncertain']]
    windows, quality_localization = _quality_windows(mos, duration)
    global_issues = []
    lufs = _finite(audio_metrics.get('integrated_lufs'))
    if lufs is not None and lufs < -30:
        global_issues.append({'type': 'low_recorded_level', 'label': '整段录音电平偏低，回听时注意音量',
                              'evidence': f'整体响度 {lufs:.1f} LUFS；低于 −30 LUFS 仅触发回听提示，不是合格线，也不代表声学声压、收音故障或听不懂。',
                              'score_impact': None})
    if audio_metrics.get('digital_silence'):
        global_issues.append({'type': 'near_digital_silence', 'label': '接近数字静音',
                              'evidence': '没有足够有效信号用于判断人声可懂度。', 'score_impact': None})
    lowest = min(windows, key=lambda value: value['overall']) if windows else None
    limitations = [
        '字词时间来自 Whisper 对齐估计；多字词组共用一个时间区间，未均分或伪造单字时间。个别字的起止时间可能相同，表示模型未分开边界，不代表真实发音时长为零。',
        '字序按转写中 Unicode 字母及数字从 1 计数，标点和空格不计；若模型漏字，无法推断未识别字的真实位置。',
        '电平异常是工程启发式回听候选，正常发音、重音、停顿及对齐误差也可能触发；没有异常候选不等于音质合格。',
        '识别不确定度不等于音质，不能证明某字被录坏；当前没有进行人工盲听或测量人工听懂率。',
        'DNSMOS 评价 9.01 秒重叠窗口；无法把总分因果分配给某个字，score_impact 保持未测。',
    ]
    if not quality_localization:
        limitations.append('真实质量窗口不足 3 个或窗口分差未达到 0.3，不能定位“突然变差”的质量区间；现有分数只作粗粒度参考。')
    if not words:
        limitations.append('本结果没有可用字词时间，波形异常不会冒充具体字词定位；需重新分析或回听。')
    no_event_reason = ('没有达到当前阈值并与有效字词时间交叉验证的局部异常；仍需结合整段质量、转写及回听。' if not events else '')
    return {'version': '1.2.0', 'available': bool(len(samples)), 'duration': round(duration, 3),
            'words': words, 'events': events, 'audio_faults_confirmed': [],
            'quality_windows': windows, 'energy_envelope': envelope,
            'uncertain_words': uncertain, 'global_issues': global_issues,
            'timestamp_source': 'Whisper word_timestamps 模型对齐估计' if words else 'unavailable',
            'limitations': limitations,
            'heuristics': {'frame_seconds': FRAME_SECONDS, 'energy_dip_db': DROP_DB,
                           'dip_min_seconds': MIN_DIP_SECONDS, 'dip_max_seconds': MAX_DIP_SECONDS,
                           'dip_requires_spanning_word': True, 'flank_seconds': 0.20,
                           'onset_recovery_min_db': 6, 'peak_local_prominence_db': 20,
                           'peak_global_p95_margin_db': 6, 'asr_uncertain_below': LOW_CONFIDENCE,
                           'quality_window_seconds': MOS_WINDOW_SECONDS,
                           'quality_min_real_windows': 3, 'quality_min_range': 0.3,
                           'low_level_notice_lufs': -30},
            'summary': {'word_count': len(words), 'event_count': len(events),
                        'uncertain_word_count': len(uncertain), 'quality_window_count': len(windows),
                        'lowest_quality_window': ({key: lowest[key] for key in ('start', 'end', 'overall')} if lowest else None),
                        'quality_localization_available': quality_localization,
                        'no_event_reason': no_event_reason}}
