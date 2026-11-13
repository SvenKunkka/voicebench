import copy
import json
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def refresh_context(monkeypatch, tmp_path):
    from app import server
    previous = {'transcription': {'text': '旧转写'}, 'provenance': {'analysis_version': '1.1.0'}}
    row = {'id': 'recording-a', 'device': '设备 A', 'scene': '近距离', 'filename': 'original.wav',
           'reference': '', 'sha256': 'test-digest', 'status': 'done', 'result': previous}
    job = {'id': 'test-refresh', 'title': '更新测试', 'created_at': '2026-11-13T15:00:00+08:00',
           'status': 'done', 'recordings': [row], 'conditions_confirmed': False}
    directory = tmp_path/job['id']/row['id']
    directory.mkdir(parents=True)
    source = directory/'source'
    source.write_bytes(b'untouched-original-audio')
    queued = []
    monkeypatch.setattr(server, 'DATA', tmp_path)
    monkeypatch.setattr(server, 'jobs', {job['id']: job})
    monkeypatch.setattr(server, 'pending', SimpleNamespace(put=queued.append))
    # Deliberately do not enter TestClient's lifespan: no real analysis worker or ASR.
    return SimpleNamespace(server=server, client=TestClient(server.app), job=job,
                           row=row, previous=copy.deepcopy(previous), source=source,
                           queued=queued, tmp_path=tmp_path)


@pytest.mark.parametrize('status', ['done', 'partial', 'interrupted'])
def test_refresh_queues_originals_and_keeps_previous_result(refresh_context, status):
    context = refresh_context
    context.job['status'] = status
    response = context.client.post('/api/jobs/test-refresh/refresh')
    assert response.status_code == 202
    assert response.json()['preserving_previous_results'] is True
    assert context.queued == ['test-refresh']
    assert context.job['status'] == 'queued'
    assert context.row['status'] == 'pending' and context.row['result_stale'] is True
    assert context.row['result'] == context.previous
    assert context.source.read_bytes() == b'untouched-original-audio'
    saved = json.loads((context.tmp_path/'test-refresh/job.json').read_text())
    assert saved['recordings'][0]['result'] == context.previous


@pytest.mark.parametrize('status', ['queued', 'running'])
def test_refresh_rejects_active_jobs_without_mutating_them(refresh_context, status):
    context = refresh_context
    context.job['status'] = status
    previous = copy.deepcopy(context.job)
    assert context.client.post('/api/jobs/test-refresh/refresh').status_code == 409
    assert context.job == previous and context.queued == []


def test_refresh_respects_three_active_job_limit(refresh_context):
    context = refresh_context
    for number in range(3):
        context.server.jobs[f'active-{number}'] = {'status': 'running' if number == 0 else 'queued'}
    assert context.client.post('/api/jobs/test-refresh/refresh').status_code == 429
    assert context.job['status'] == 'done' and context.queued == []


def test_refresh_missing_source_keeps_existing_result(refresh_context):
    context = refresh_context
    context.source.unlink()
    response = context.client.post('/api/jobs/test-refresh/refresh')
    assert response.status_code == 409 and 'original.wav' in response.json()['detail']
    assert context.row['result'] == context.previous and context.queued == []


def test_refresh_unknown_job_returns_404(refresh_context):
    assert refresh_context.client.post('/api/jobs/not-present/refresh').status_code == 404


def test_refresh_api_reports_new_method_version(refresh_context):
    response = refresh_context.client.get('/api/health')
    assert response.status_code == 200
    assert response.json()['version'] == '1.2.0'
    assert response.json()['method']['version'] == '1.2.0'


def run_one_worker(monkeypatch, context, analyze):
    class QueueFinished(Exception):
        pass
    calls = iter([context.job['id']])
    def get():
        try:
            return next(calls)
        except StopIteration:
            raise QueueFinished()
    monkeypatch.setattr(context.server, 'pending', SimpleNamespace(get=get, task_done=lambda: None))
    monkeypatch.setattr(context.server, 'engine', SimpleNamespace(analyze=analyze))
    with pytest.raises(QueueFinished):
        context.server.worker()


def test_refresh_worker_failure_retains_last_valid_result(refresh_context, monkeypatch):
    context = refresh_context
    context.client.post('/api/jobs/test-refresh/refresh')
    def fail(*args):
        raise RuntimeError('模拟分析失败')
    run_one_worker(monkeypatch, context, fail)
    assert context.job['status'] == 'partial' and context.row['status'] == 'failed'
    assert context.row['result'] == context.previous and context.row['result_stale'] is True
    assert context.source.read_bytes() == b'untouched-original-audio'


def test_refresh_worker_success_replaces_result_after_analysis(refresh_context, monkeypatch):
    context = refresh_context
    context.client.post('/api/jobs/test-refresh/refresh')
    fresh = {'transcription': {'text': '新转写'}, 'timeline': {'words': [], 'events': []}}
    def analyze(row, job, directory, progress):
        assert row['result'] == context.previous
        assert context.source.read_bytes() == b'untouched-original-audio'
        progress('获取模型疑点')
        assert row['result'] == context.previous
        return fresh
    run_one_worker(monkeypatch, context, analyze)
    assert context.row['result'] == fresh and context.row['status'] == 'done'
    assert 'result_stale' not in context.row


def report_job(timeline=True):
    result = {'audio': {'near_full_scale_percent': 0.}, 'text': {},
              'mos': {'available': True, 'signal': 3.5, 'background': 3.0, 'overall': 3.2},
              'transcription': {'text': '完整转写内容', 'segments': [{'start': .2, 'end': 1.4, 'text': '历史片段全部保留'}]},
              'warnings': [], 'provenance': {}}
    if timeline:
        result['timeline'] = {
            'available': True, 'words': [
                {'index': 0, 'text': '完整', 'start': .2, 'end': .8, 'probability': .98, 'uncertain': False, 'event_ids': [], 'char_start': 1, 'char_end': 2},
                {'index': 1, 'text': '<转写>', 'start': .8, 'end': 1.4, 'probability': .45, 'uncertain': True, 'event_ids': ['e1'], 'char_start': 3, 'char_end': 4}],
            'events': [{'id': 'e1', 'type': 'recognition_uncertain', 'label': '模型识别疑点',
                        'start': .8, 'end': 1.4, 'severity': 'review', 'evidence': ['概率较低', '<需回听>'],
                        'word_indices': [1], 'word_context': '<转写>', 'precision': '模型词组时间范围', 'score_impact': None}],
            'quality_windows': [{'start': 0., 'end': 9.01, 'signal': 3.5, 'background': 3.0, 'overall': 3.2, 'repeated_input': False}],
            'global_issues': [{'type': 'level', 'label': '全局电平提示', 'evidence': '不能归因某字'}],
            'limitations': ['时间估计不是精确采样定位'], 'timestamp_source': 'Whisper word timestamps'}
    row = {'id': 'r1', 'device': '设备甲', 'scene': '近距离', 'filename': 'original.wav',
           'reference': '', 'status': 'done', 'result': result}
    return {'title': '词级定位报告', 'created_at': '2026-11-13T15:00:00+08:00',
            'status': 'done', 'conditions_confirmed': False, 'recordings': [row]}


def test_timeline_html_exports_complete_words_evidence_and_limitations():
    from app.reporting import export_html
    html = export_html(report_job())
    assert '完整词级时间表' in html and '0:00.20—0:00.80' in html
    assert '转写字序（不计标点空格）' in html and '<td>1～2</td>' in html and '<td>3～4</td>' in html
    assert '&lt;转写&gt;' in html and '<转写>' not in html
    assert '概率较低；&lt;需回听&gt;' in html
    assert '0.4500' in html and '模型不确定，建议回听；不是故障判断' in html
    assert '未计算单字分数影响' in html
    assert '9.01 秒窗口' in html and '不能据此把质量下降归因于某一个字' in html
    assert 'Whisper word timestamps' in html


def test_timeline_html_handles_empty_events_legacy_and_stale_results():
    from app.reporting import export_html
    job = report_job()
    job['recordings'][0]['result']['timeline']['events'] = []
    assert '本次未标出局部疑似异常' in export_html(job)
    legacy = report_job(timeline=False)
    legacy['recordings'][0]['status'] = 'failed'
    legacy['recordings'][0]['result_stale'] = True
    html = export_html(legacy)
    assert '当前显示上次成功结果' in html
    assert '历史结果尚无词级时间线' in html and '更新分析' in html
    assert '0:00.20—0:01.40' in html and '历史片段全部保留' in html


def test_timeline_csv_exports_all_evidence_and_escapes_formulas():
    import csv
    import io
    from app.reporting import export_timeline_csv
    job = report_job()
    job['recordings'][0]['device'] = '=SUM(1,2)'
    job['recordings'][0]['result_stale'] = True
    table = list(csv.DictReader(io.StringIO(export_timeline_csv(job).lstrip('\ufeff'))))
    assert len(table) == 5  # Two words, event, quality window and global issue.
    assert all(row['device'].startswith("'=") for row in table)
    assert table[1]['start'] == '0.8' and table[1]['context'] == '<转写>'
    assert json.loads(table[1]['evidence'])['char_start'] == 3
    assert json.loads(table[1]['evidence'])['char_end'] == 4
    assert all('上次成功结果' in row['precision'] for row in table)
    assert table[2]['score_impact'] == '未计算单字分数影响'


def test_timeline_csv_endpoint_and_legacy_export(refresh_context):
    context = refresh_context
    context.job.update(report_job(timeline=False))
    context.job['id'] = 'test-refresh'
    response = context.client.get('/api/jobs/test-refresh/export/timeline-csv')
    assert response.status_code == 200
    assert 'voicebench-timeline.csv' in response.headers['content-disposition']
    assert '历史结果无词级时间线' in response.text


def test_character_position_handles_single_character_and_missing_legacy_fields():
    from app.reporting import _word_character_position
    assert _word_character_position({'char_start': 9, 'char_end': 9}) == '9'
    assert _word_character_position({'index': 2}) == '—'
