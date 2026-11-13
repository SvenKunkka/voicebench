import json

import numpy as np
import pytest

from app.timeline import build_timeline

SR = 16000


def voice(duration=3.0, amplitude=0.05):
    time = np.arange(round(SR * duration)) / SR
    return (amplitude * np.sin(2 * np.pi * 220 * time)).astype(np.float32)


def transcript(words):
    return {'text': ''.join(word.get('text', word.get('word', '')) for word in words), 'words': words}


def run(samples, words=None, audio=None, mos=None):
    return build_timeline(samples, SR, transcript(words or []), audio or {}, mos or {'available': False})


def test_constant_voice_has_no_spurious_dips_or_peaks():
    result = run(voice(), [{'text': '持续语音', 'start': 0.1, 'end': 2.9, 'probability': 0.95}])
    assert result['events'] == []
    assert result['summary']['event_count'] == 0
    assert result['summary']['no_event_reason']
    assert result['audio_faults_confirmed'] == []
    json.dumps(result, allow_nan=False)


def test_normal_pause_between_words_is_not_called_audio_fault():
    samples = voice()
    samples[round(1.2 * SR):round(1.4 * SR)] = 0
    result = run(samples, [{'text': '前半句', 'start': 0.1, 'end': 1.18},
                           {'text': '后半句', 'start': 1.43, 'end': 2.9}])
    assert result['events'] == []


def test_abrupt_internal_drop_maps_to_actual_word_without_score_attribution():
    samples = voice()
    samples[round(1.2 * SR):round(1.4 * SR)] *= 0.001
    result = run(samples, [{'text': '这段测试', 'start': 0.1, 'end': 2.9, 'probability': 0.9}])
    dips = [event for event in result['events'] if event['type'] == 'word_internal_level_dip']
    assert len(dips) == 1
    event = dips[0]
    assert event['start'] == pytest.approx(1.2, abs=0.04)
    assert event['end'] == pytest.approx(1.4, abs=0.04)
    assert event['word_indices'] == [0]
    assert event['word_context'] == '这段测试'
    assert event['score_impact'] is None
    assert '也可能是正常' in event['evidence']
    assert result['words'][0]['event_ids'] == [event['id']]
    assert result['words'][0]['char_start'] == 1
    assert result['words'][0]['char_end'] == 4


def test_no_word_alignment_does_not_invent_word_level_dip_location():
    samples = voice()
    samples[round(1.2 * SR):round(1.4 * SR)] = 0
    result = run(samples)
    assert result['events'] == []
    assert result['words'] == []
    assert result['timestamp_source'] == 'unavailable'
    assert any('没有可用字词时间' in text for text in result['limitations'])


def test_clipping_events_merge_and_map_to_nearby_word():
    result = run(voice(), [{'word': '别爆音', 'start': 0.9, 'end': 1.3}], audio={
        'clipping_events': [{'start': 1.0, 'end': 1.01}, {'start': 1.05, 'end': 1.06},
                            {'start': 2.2, 'end': 2.21}]})
    clipped = [event for event in result['events'] if event['type'] == 'suspected_clipping']
    assert len(clipped) == 2
    assert clipped[0]['start'] == 1.0 and clipped[0]['end'] == 1.06
    assert clipped[0]['word_indices'] == [0]
    assert clipped[1]['word_indices'] == []
    assert '没有可靠' in clipped[1]['word_context']
    assert all(event['score_impact'] is None for event in clipped)


def test_clipping_without_words_retains_signal_evidence_without_fabricated_text():
    result = run(voice(), audio={'clipping_events': [{'start': 0.5, 'end': 0.51}]})
    assert result['events'][0]['word_indices'] == []
    assert result['words'] == []


def test_ten_second_mos_window_cannot_claim_sudden_word_quality_change():
    result = run(voice(10.2), mos={'available': True, 'windows': [
        {'start': 0, 'signal': 3.5, 'background': 4.1, 'overall': 3.2}]})
    assert len(result['quality_windows']) == 1
    assert result['quality_windows'][0]['end'] == 9.01
    assert not result['summary']['quality_localization_available']
    assert not result['quality_windows'][0]['relative_low']
    assert result['events'] == []


def test_short_audio_repeated_padding_is_not_mapped_to_artificial_real_time():
    result = run(voice(2), mos={'available': True, 'repeated_short_audio': True,
                              'signal': 3, 'background': 3.5, 'overall': 2.8,
                              'windows': [{'start': 0, 'signal': 3, 'background': 3.5, 'overall': 2.8},
                                          {'start': 1, 'signal': 3, 'background': 3.5, 'overall': 2.8}]})
    assert len(result['quality_windows']) == 1
    assert result['quality_windows'][0]['start'] == 0
    assert result['quality_windows'][0]['end'] == 2
    assert result['quality_windows'][0]['repeated_input']
    assert not result['summary']['quality_localization_available']


def test_mos_needs_three_real_windows_and_sufficient_range():
    windows = [{'start': index, 'signal': score, 'background': score, 'overall': score}
               for index, score in enumerate([3.5, 3.4, 2.8])]
    result = run(voice(12), mos={'available': True, 'windows': windows})
    assert result['summary']['quality_localization_available']
    assert result['quality_windows'][-1]['relative_low']
    assert result['quality_windows'][-1]['score_impact'] is None
    assert result['summary']['lowest_quality_window'] == {'start': 2, 'end': 11.01, 'overall': 2.8}
    result = run(voice(12), mos={'available': True, 'windows': windows[:2]})
    assert not result['summary']['quality_localization_available']
    assert not any(window['relative_low'] for window in result['quality_windows'])


def test_low_asr_confidence_is_separate_from_acoustic_faults_and_positions_are_not_split():
    result = build_timeline(voice(), SR, {'segments': [{'words': [
        {'word': ' 好的，', 'start': 0.2, 'end': 0.5, 'probability': 0.9},
        {'word': 'G6 HE', 'start': 0.6, 'end': 1.8, 'probability': 0.2},
        {'word': '。', 'start': 1.8, 'end': 1.8}]}]}, {}, {'available': False})
    assert result['events'] == []
    assert result['words'][0]['char_start'] == 1 and result['words'][0]['char_end'] == 2
    assert result['words'][1]['char_start'] == 3 and result['words'][1]['char_end'] == 6
    assert result['words'][1]['start'] == 0.6 and result['words'][1]['end'] == 1.8
    assert result['words'][2]['char_start'] is None
    assert result['uncertain_words'][0]['index'] == 1
    assert '不等于收音质量差' in result['uncertain_words'][0]['reason']


def test_low_file_level_is_global_notice_not_sudden_fault_or_measured_score_penalty():
    result = run(voice(), audio={'integrated_lufs': -41.8})
    assert result['events'] == []
    assert result['global_issues'][0]['type'] == 'low_recorded_level'
    assert '不是合格线' in result['global_issues'][0]['evidence']
    assert result['global_issues'][0]['score_impact'] is None


def test_invalid_and_empty_inputs_are_explicit_and_json_safe():
    with pytest.raises(ValueError, match='采样率'):
        build_timeline(voice(), 0, {}, {}, {})
    with pytest.raises(ValueError, match='一维'):
        build_timeline(np.ones((3, 2)), SR, {}, {}, {})
    with pytest.raises(ValueError, match='无效'):
        build_timeline(np.array([np.nan]), SR, {}, {}, {})
    result = run(np.array([], dtype=np.float32), [{'text': '无效', 'start': float('nan'), 'end': float('inf')}])
    assert not result['available'] and not result['words']
    json.dumps(result, allow_nan=False)


def test_short_prominent_click_is_review_candidate_not_noise_verdict():
    samples = voice()
    samples[round(1.2 * SR):round(1.202 * SR)] = 0.95
    result = run(samples, [{'text': '测试中', 'start': 0.8, 'end': 1.8}])
    peaks = [event for event in result['events'] if event['type'] == 'short_prominent_peak']
    assert len(peaks) == 1
    assert peaks[0]['word_indices'] == [0]
    assert '也可能来自正常重音' in peaks[0]['evidence']
