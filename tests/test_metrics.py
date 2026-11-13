import io
import json
import wave

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.audio_metrics import DNSMOS, inspect_audio
from app.reporting import aggregate, export_csv, export_html
from app.text_metrics import compare_text, normalize


def test_normalization_and_empty_reference():
    assert normalize(' ＡＢＣ，繁體測試！ G6 HE ') == 'abc繁体测试g6he'
    assert normalize('十五') != normalize('15')
    with pytest.raises(ValueError):
        compare_text('。！', '内容', [])


def test_known_edit_counts_and_cer_over_one():
    r = compare_text('今天下午开会', '今天上午开会啊', [])
    assert (r['substitutions'], r['deletions'], r['insertions']) == (1,0,1)
    assert r['cer'] == pytest.approx(2/6)
    r = compare_text('好', '很好很好很好', [])
    assert r['cer'] > 1 and r['content_score'] == 0


def test_keywords_require_the_correct_reference_position():
    r = compare_text('十五和十五', '五十和十五', ['十五', '不存在'])
    assert r['keywords'][0]['occurrences'] == 2
    assert r['keywords'][0]['correct'] == 1
    assert r['keyword_accuracy'] == .5
    assert r['keywords'][1]['excluded']
    assert compare_text('不可以', '不太可以', ['不可以'])['keyword_accuracy'] == 0


def record(device, reference, scene, cer, mos=3.5, status='done'):
    return {'id': device+reference+str(cer), 'device':device, 'reference':reference,'scene':scene,
            'status':status, 'filename':'test.wav','result': {'text': {'cer':cer,'content_score':max(0,100*(1-cer)), 'keyword_accuracy':None},
                                                          'mos':{'available':True,'overall':mos}}}


def test_groups_do_not_mix_different_texts_or_scenes_and_repeats_are_averaged():
    job = {'recordings':[record('A','你好','quiet',.1),record('A','你好','quiet',.3),record('B','你好','quiet',.4),
                         record('B','其他','quiet',0),record('B','你好','noise',0)],'conditions_confirmed':True}
    result = aggregate(job)
    assert len(result['groups']) == 3
    group = next(g for g in result['groups'] if g['scene']=='quiet' and len(g['devices'])==2)
    assert group['devices'][0]['cer_mean'] == pytest.approx(.2)
    assert group['devices'][0]['n'] == 2


def test_no_winner_without_controlled_conditions_or_complete_batch():
    job={'recordings':[record('A','你好','quiet',0,4),record('B','你好','quiet',.2,3)],'conditions_confirmed':False}
    assert '不能据此判定' in aggregate(job)['groups'][0]['decision']
    job['conditions_confirmed']=True
    job['recordings'].append(record('C','你好','quiet',0,status='failed'))
    assert '部分结果' in aggregate(job)['groups'][0]['decision']


def test_silence_not_given_fake_mos_and_native_clipping_detected(tmp_path):
    src=tmp_path/'test.wav'
    signal=np.zeros(16000,dtype='<i2');signal[100:150]=32767
    with wave.open(str(src),'wb') as f:
        f.setnchannels(1);f.setsampwidth(2);f.setframerate(16000);f.writeframes(signal.tobytes())
    stats,_,_=inspect_audio(src,tmp_path,'first')
    assert stats['near_full_scale_percent'] == pytest.approx(50/16000*100)
    assert len(stats['clipping_events'])==1
    assert not DNSMOS().score(np.zeros(16000,dtype=np.float32))['available']
    with pytest.raises(ValueError,match='第二声道'):
        inspect_audio(src,tmp_path,'second')


def test_csv_formula_injection_and_html_escaping():
    job={'title':'<script>alert(1)</script>','created_at':'2026-11-13','conditions_confirmed':False,
         'recordings':[{'id':'a','device':'=1+1','scene':'quiet','reference':'你好','filename':'x','status':'failed','error':'<bad>'}]}
    assert "'=1+1" in export_csv(job)
    report=export_html(job)
    assert '<script>' not in report and '&lt;script&gt;' in report


def test_loudness_json_survives_trailing_ffmpeg_log(tmp_path):
    signal=(np.sin(2*np.pi*1000*np.arange(32000)/16000)*3276).astype('<i2')
    src=tmp_path/'tone.wav'
    with wave.open(str(src),'wb') as f:
        f.setnchannels(1);f.setsampwidth(2);f.setframerate(16000);f.writeframes(signal.tobytes())
    stats,_,_=inspect_audio(src,tmp_path,'first')
    assert -30 < stats['integrated_lufs'] < -15
    assert stats['true_peak_dbtp'] == pytest.approx(-20,abs=.3)


def test_local_origin_and_invalid_upload():
    from app.server import app
    with TestClient(app) as client:
        assert client.get('/api/health').status_code==200
        assert client.post('/api/jobs',headers={'Origin':'https://evil.example'}).status_code==403
        assert client.get('/api/health',headers={'Host':'evil.example'}).status_code==403
        assert client.post('/api/jobs',data={'manifest':'not-json'},files={'files':('x.wav',b'data')}).status_code==400
        assert client.post('/api/jobs',data={'manifest':json.dumps({'recordings':[{'device':'A','scene':'quiet','reference':'!!!'}]})},
                           files={'files':('x.wav',b'data')}).status_code==400


def no_reference_record(device, overall, reference=''):
    return {'id':device, 'device':device, 'scene':'桌面近距离', 'reference':reference,
            'filename':device+'.wav', 'status':'done', 'result':{
                'text':{'available':False,'cer':None,'content_score':None,'keyword_accuracy':None,
                        'alignment':[],'keywords':[]},
                'mos':{'available':True,'signal':overall+.1,'background':overall+.2,'overall':overall},
                'audio':{'integrated_lufs':-30.,'rms_dbfs':-32.,'true_peak_dbtp':-10.,
                         'near_full_scale_percent':0.},
                'transcription':{'text':'这是独立识别的文字，不是正确原稿'},
                'warnings':[],'provenance':{'reference_sent_to_asr':False}}}


def test_no_reference_keeps_quality_comparison_but_never_fabricates_cer():
    job={'title':'真实录音','created_at':'2026-11-13','conditions_confirmed':False,
         'recordings':[no_reference_record('A',3.4),no_reference_record('B',2.1)]}
    result=aggregate(job)
    assert result['groups']==[]
    group=result['quality_groups'][0]
    assert group['reference_status']=='no_reference'
    assert group['leading_device']=='A'
    assert '不是硬件优胜' in group['decision']
    assert any('未经确认' in caveat for caveat in group['caveats'])
    assert all(d['cer_mean'] is None and d['content_score'] is None for d in group['devices'])
    assert group['devices'][0]['rms_mean']==-32.
    assert group['devices'][0]['clipping_percent_mean']==0.
    report=export_html(job)
    assert '未提供正确原稿' in report and '音质对比' in report
    assert 'CER 0.00%' not in report
    csv_report=export_csv(job)
    assert '未测' in csv_report and '未提供原稿' in csv_report


def test_different_scripts_quality_metrics_never_pool_cer():
    job={'recordings':[record('A','不同的原稿','桌面',.01,4),record('B','另外一份','桌面',.2,3)],
         'conditions_confirmed':True}
    result=aggregate(job)
    assert len(result['groups'])==2
    assert all(len(group['devices'])==1 for group in result['groups'])
    quality=result['quality_groups'][0]
    assert quality['reference_status']=='different_references' and not quality['same_reference']
    assert all(d['cer_mean'] is None for d in quality['devices'])
    assert any('文案不同' in caveat for caveat in quality['caveats'])


def test_missing_mos_is_not_ranked_as_zero_or_winner():
    a=no_reference_record('A',3.4);b=no_reference_record('B',2.1)
    b['result']['mos']={'available':False,'reason':'未测得'}
    group=aggregate({'recordings':[a,b],'conditions_confirmed':True})['quality_groups'][0]
    assert group['leading_device'] is None
    assert group['devices'][1]['mos_mean'] is None
    assert '没有有效质量预测' in group['decision']


def test_optional_reference_upload_and_punctuation_validation(monkeypatch,tmp_path):
    from app import server
    monkeypatch.setattr(server,'DATA',tmp_path)
    monkeypatch.setattr(server,'jobs',{})
    queued=[]
    monkeypatch.setattr(server.pending,'put',queued.append)
    client=TestClient(server.app)
    rows=[{'device':'A','scene':'桌面','reference':None},{'device':'B','scene':'桌面'}]
    response=client.post('/api/jobs',data={'manifest':json.dumps({'recordings':rows})},
                         files=[('files',('A.wav',b'data')),('files',('B.wav',b'data'))])
    assert response.status_code==202
    job_id=response.json()['id']
    assert queued==[job_id]
    saved=json.loads((tmp_path/job_id/'job.json').read_text())
    assert [r['reference'] for r in saved['recordings']]==['','']
    rows[0]['reference']='！？'
    response=client.post('/api/jobs',data={'manifest':json.dumps({'recordings':rows})},
                         files=[('files',('A.wav',b'data')),('files',('B.wav',b'data'))])
    assert response.status_code==400 and '没有可评分' in response.json()['detail']


def test_engine_without_reference_does_not_call_text_comparison(monkeypatch,tmp_path):
    from app import engine as engine_module
    decoded=tmp_path/'analysis.wav'
    samples=(.1*np.sin(2*np.pi*300*np.arange(16000)/16000)).astype(np.float32)
    with wave.open(str(decoded),'wb') as f:
        f.setnchannels(1);f.setsampwidth(2);f.setframerate(16000)
        f.writeframes((samples*32767).astype('<i2').tobytes())
    audio={'digital_silence':False,'duration':1.,'warnings':[]}
    monkeypatch.setattr(engine_module,'inspect_audio',lambda *a:(audio,samples,decoded))
    def cannot_compare(*args):
        raise AssertionError('reference-free audio must not call text comparison')
    monkeypatch.setattr(engine_module,'compare_text',cannot_compare)
    instance=engine_module.Engine()
    monkeypatch.setattr(instance,'transcribe',lambda *a:{'text':'独立转写内容','segments':[],'engine':'test'})
    class FakeMOS:
        def score(self,_):
            return {'available':True,'signal':3.,'background':3.,'overall':3.}
    instance.mos=FakeMOS()
    result=instance.analyze({'reference':'','sha256':'a'*64},{'language':'zh','channel':'first','keywords':['内容']},tmp_path,lambda _:None)
    assert result['text']['available'] is False
    assert result['text']['cer'] is None and result['text']['content_score'] is None
    assert result['text']['keyword_accuracy'] is None
    assert result['transcription']['text']=='独立转写内容'
    assert result['provenance']['reference_provided'] is False
    assert result['provenance']['reference_sent_to_asr'] is False
