import asyncio
import hashlib
import json
import os
import queue
import re
import threading
import uuid
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse
from zoneinfo import ZoneInfo

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from .audio_metrics import ROOT
from .engine import Engine
from .reporting import METHOD, aggregate, export_csv, export_html, export_timeline_csv
from .text_metrics import normalize

DATA = ROOT/'data/jobs'
DATA.mkdir(parents=True, exist_ok=True)
jobs = {}
lock = threading.RLock()
pending = queue.Queue()
engine = Engine()


def save(job):
    with lock:
        directory = DATA/job['id']
        directory.mkdir(exist_ok=True)
        path = directory/'job.json'
        temporary = path.with_suffix('.tmp')
        temporary.write_text(json.dumps(job, ensure_ascii=False, allow_nan=False), encoding='utf-8')
        temporary.replace(path)


def worker():
    while True:
        job_id = pending.get()
        job = jobs[job_id]
        with lock:
            job['status'] = 'running'; save(job)
        for row in job['recordings']:
            if row.get('status') == 'done':
                continue
            with lock:
                row['status'] = 'running'; row.pop('error', None); save(job)
            def progress(message):
                with lock:
                    row['stage'] = message; save(job)
            try:
                result = engine.analyze(row, job, DATA/job_id/row['id'], progress)
                with lock:
                    row['result'] = result; row['status'] = 'done'; row['stage'] = '已完成'
                    row.pop('result_stale', None)
                    save(job)
            except Exception as error:
                with lock:
                    row['status'] = 'failed'; row['error'] = str(error); row['stage'] = '分析失败'; save(job)
        with lock:
            job['status'] = 'partial' if any(r['status'] == 'failed' for r in job['recordings']) else 'done'
            save(job)
        pending.task_done()


@asynccontextmanager
async def lifespan(app):
    for path in DATA.glob('*/job.json'):
        try:
            job = json.loads(path.read_text())
            if job['status'] in ('running', 'queued'):
                job['status'] = 'interrupted'
                for row in job['recordings']:
                    if row['status'] in ('running', 'pending'):
                        row['status'] = 'interrupted'
                save(job)
            jobs[job['id']] = job
        except (ValueError, KeyError):
            continue
    threading.Thread(target=worker, daemon=True, name='voicebench-analysis').start()
    yield
    if engine.process and engine.process.poll() is None:
        engine.process.terminate()


app = FastAPI(title='收音对比台', lifespan=lifespan, docs_url=None, redoc_url=None)


@app.middleware('http')
async def local_only(request: Request, call_next):
    host = request.headers.get('host', '').split(':')[0]
    origin = request.headers.get('origin')
    if host not in ('127.0.0.1', 'localhost', 'testserver'):
        return JSONResponse({'detail': '只允许本机访问。'}, status_code=403)
    if origin and origin != f'{request.url.scheme}://{request.headers.get("host")}':
        return JSONResponse({'detail': '请在本机工具页面内操作。'}, status_code=403)
    response = await call_next(request)
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['Referrer-Policy'] = 'no-referrer'
    response.headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'"
    return response


@app.get('/api/health')
def health():
    local_server = getattr(app.state, 'local_server', {})
    return {'name': '收音对比台', 'app_id': 'voicebench', 'version': '1.3.1',
            'pid': os.getpid(), 'instance_id': local_server.get('instance_id'),
            'server': dict(local_server), 'capabilities': engine.capabilities(), 'method': METHOD}


@app.get('/api/jobs')
def list_jobs():
    with lock:
        return [{'id': j['id'], 'title': j['title'], 'created_at': j['created_at'], 'status': j['status'],
                 'count': len(j['recordings']), 'completed': sum(r['status'] == 'done' for r in j['recordings'])}
                for j in sorted(jobs.values(), key=lambda j:j['created_at'], reverse=True)[:50]]


def get_job(job_id):
    if job_id not in jobs:
        raise HTTPException(404, '找不到这个测试。')
    return jobs[job_id]


@app.get('/api/jobs/{job_id}')
def read_job(job_id: str):
    with lock:
        job = json.loads(json.dumps(get_job(job_id)))
    return {**job, 'comparison': aggregate(job), 'method': METHOD}


@app.post('/api/jobs', status_code=202)
async def create_job(manifest: str = Form(...), files: list[UploadFile] = File(...)):
    try:
        settings = json.loads(manifest)
    except ValueError:
        raise HTTPException(400, '测试信息格式错误。')
    if not isinstance(settings, dict):
        raise HTTPException(400, '测试信息格式错误。')
    rows = settings.get('recordings')
    if not isinstance(rows, list) or len(files) != len(rows) or not 1 <= len(files) <= 20:
        raise HTTPException(400, '每批支持 1～20 份录音，每份需要对应的设备与场景；原稿可选。')
    language = settings.get('language', 'zh')
    channel = settings.get('channel', 'first')
    if language not in ('zh', 'en', 'auto') or channel not in ('first', 'second', 'mix'):
        raise HTTPException(400, '语言或声道选项无效。')
    keywords = settings.get('keywords', [])
    if not isinstance(keywords, list) or len(keywords) > 100 or any(not isinstance(k,str) or len(k)>100 for k in keywords):
        raise HTTPException(400, '关键词最多 100 个，每个不超过 100 字。')
    normalized_rows = []
    for r in rows:
        if not isinstance(r,dict):
            raise HTTPException(400, '录音信息格式错误。')
        device = str(r.get('device', '')).strip()
        scene = str(r.get('scene', '')).strip()
        reference_value = r.get('reference')
        reference = '' if reference_value is None else str(reference_value).strip()
        if not device or not scene:
            raise HTTPException(400, '请为每份录音填写设备与场景。')
        if reference and not normalize(reference):
            raise HTTPException(400, '已填写的原稿没有可评分的文字；请补充有效原稿，或留空只分析音质。')
        if len(device)>100 or len(scene)>200 or len(reference)>20000:
            raise HTTPException(400, '设备名称或原稿过长（原稿最多 20,000 字）。')
        normalized_rows.append({'device': device, 'scene': scene, 'reference': reference})
    with lock:
        if sum(j['status'] in ('queued','running') for j in jobs.values()) >= 3:
            raise HTTPException(429, '已有 3 批测试排队，请等当前测试完成。')
    job_id = uuid.uuid4().hex
    directory = DATA/job_id
    directory.mkdir()
    recordings = []
    try:
        total = 0
        for upload, row in zip(files, normalized_rows):
            rec_id = uuid.uuid4().hex
            folder = directory/rec_id; folder.mkdir()
            digest = hashlib.sha256(); size = 0
            with open(folder/'source', 'wb') as output:
                while chunk := await upload.read(1024*1024):
                    size += len(chunk); total += len(chunk)
                    if size > 100*1024**2 or total > 500*1024**2:
                        raise HTTPException(413, '单份录音最多 100 MB，每批最多 500 MB。')
                    digest.update(chunk); output.write(chunk)
            if not size:
                raise HTTPException(400, '录音文件为空。')
            recordings.append({**row, 'id': rec_id, 'filename': Path(upload.filename or '录音').name[:200],
                               'sha256': digest.hexdigest(), 'bytes': size, 'status': 'pending'})
        job = {'id': job_id, 'title': str(settings.get('title') or '收音对比测试')[:120],
               'created_at': datetime.now(ZoneInfo('Asia/Shanghai')).isoformat(timespec='seconds'),
               'status': 'queued', 'conditions_confirmed': settings.get('conditions_confirmed') is True,
               'notes': str(settings.get('notes') or '')[:2000], 'language': language, 'channel': channel,
               'keywords': keywords, 'recordings': recordings}
        with lock:
            jobs[job_id] = job; save(job)
        pending.put(job_id)
        return {'id': job_id}
    except Exception:
        # Only remove the newly created, unpublished upload staging object.
        import shutil
        shutil.rmtree(directory)
        raise
    finally:
        for upload in files:
            await upload.close()


@app.post('/api/jobs/{job_id}/retry', status_code=202)
def retry(job_id: str):
    with lock:
        job = get_job(job_id)
        if job['status'] not in ('partial', 'interrupted'):
            raise HTTPException(409, '只有失败或中断的测试可以重试。')
        job['status'] = 'queued'
        for row in job['recordings']:
            if row['status'] != 'done':
                row['status'] = 'pending'
        save(job)
    pending.put(job_id)
    return {'id': job_id}


@app.post('/api/jobs/{job_id}/refresh', status_code=202)
def refresh(job_id: str):
    """Reanalyse retained originals; replace each previous result only on success."""
    with lock:
        job = get_job(job_id)
        if job['status'] not in ('done', 'partial', 'interrupted'):
            raise HTTPException(409, '当前测试正在排队或分析，请完成后再更新分析。')
        if sum(j['status'] in ('queued', 'running') for j in jobs.values()) >= 3:
            raise HTTPException(429, '已有 3 批测试排队，请等当前测试完成。')
        missing = [r.get('filename') or r['id'] for r in job['recordings']
                   if not (DATA/job_id/r['id']/'source').is_file()]
        if missing:
            raise HTTPException(409, '保留的原始音频不存在，无法更新：'+'、'.join(missing))
        requested_at = datetime.now(ZoneInfo('Asia/Shanghai')).isoformat(timespec='seconds')
        job['status'] = 'queued'
        job['refresh_requested_at'] = requested_at
        for row in job['recordings']:
            row['status'] = 'pending'
            row['stage'] = '等待更新分析'
            row.pop('error', None)
            if row.get('result') is not None:
                row['result_stale'] = True
        save(job)
    pending.put(job_id)
    return {'id': job_id, 'status': 'queued', 'preserving_previous_results': True}


@app.get('/api/jobs/{job_id}/export/{kind}')
def export(job_id: str, kind: str):
    with lock:
        job = json.loads(json.dumps(get_job(job_id)))
    if kind == 'html':
        return Response(export_html(job), media_type='text/html', headers={'Content-Disposition': 'attachment; filename="voicebench-report.html"'})
    if kind == 'csv':
        return Response(export_csv(job), media_type='text/csv', headers={'Content-Disposition': 'attachment; filename="voicebench-results.csv"'})
    if kind == 'timeline-csv':
        return Response(export_timeline_csv(job), media_type='text/csv', headers={'Content-Disposition': 'attachment; filename="voicebench-timeline.csv"'})
    if kind == 'json':
        return Response(json.dumps({**job, 'comparison': aggregate(job), 'method': METHOD}, ensure_ascii=False, indent=2),
                        media_type='application/json', headers={'Content-Disposition': 'attachment; filename="voicebench-results.json"'})
    raise HTTPException(404, '不支持的导出格式。')


@app.get('/api/jobs/{job_id}/audio/{recording_id}/{variant}')
def audio(job_id: str, recording_id: str, variant: str):
    job = get_job(job_id)
    if not any(r['id'] == recording_id for r in job['recordings']):
        raise HTTPException(404)
    names = {'original': 'analysis.wav', 'matched': 'matched.wav'}
    if variant not in names:
        raise HTTPException(404)
    path = DATA/job_id/recording_id/names[variant]
    if not path.exists():
        raise HTTPException(404, '试听文件尚未生成。')
    return FileResponse(path, media_type='audio/wav')


app.mount('/static', StaticFiles(directory=ROOT/'app/static'), name='static')


@app.get('/')
def index():
    return FileResponse(ROOT/'app/static/index.html')
