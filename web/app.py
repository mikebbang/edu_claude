"""공정 조합 퍼널 웹 서버: raw.csv 업로드 → 판정 실행(백그라운드, 한 번에 하나) → funnel · 순위표 · 상세 화면"""
import json
import os
import shutil
import threading
import time
import traceback
import uuid
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import combi
from combi import views

BASE = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get('COMBI_DATA_DIR', BASE.parent / 'data')).resolve()   # 올린 파일을 두는 곳
UPLOADS = DATA_DIR / 'uploads'
UPLOADS.mkdir(parents=True, exist_ok=True)
KEEP_RESULTS = int(os.environ.get('COMBI_KEEP_RESULTS', '3'))   # 상세 화면용 데이터를 메모리에 남겨 둘 실행 수

app = FastAPI(title='공정 조합 퍼널', docs_url=None, redoc_url=None, openapi_url=None)
worker = ThreadPoolExecutor(max_workers=1)     # 판정은 무거워서 한 번에 하나씩 차례로 돌린다
runs = OrderedDict()                           # run_id → 실행 상태 · 결과
lock = threading.Lock()


class RunRequest(BaseModel):
    file_id: str
    settings: dict = {}


class DetailRequest(BaseModel):
    step: int
    items: list[list[int]]


def _csv(fid):
    path = UPLOADS / f'{fid}.csv'
    if not fid.isalnum() or not path.exists():
        raise HTTPException(404, '파일이 없습니다. 다시 올려 주세요.')
    return path


@app.post('/api/upload')
def upload(file: UploadFile = File(...)):
    name = Path(file.filename or 'raw.csv').name
    if not name.lower().endswith('.csv'):
        raise HTTPException(400, 'CSV 파일만 올릴 수 있습니다.')
    fid = uuid.uuid4().hex[:12]
    dest = UPLOADS / f'{fid}.csv'
    with dest.open('wb') as f:
        shutil.copyfileobj(file.file, f, 8 * 1024 * 1024)
    meta = {'id': fid, 'name': name, 'size': dest.stat().st_size, 'uploaded': datetime.now().isoformat(timespec='seconds')}
    (UPLOADS / f'{fid}.json').write_text(json.dumps(meta, ensure_ascii=False), encoding='utf-8')
    return meta


@app.get('/api/files')
def files():
    out = []
    for p in sorted(UPLOADS.glob('*.json'), key=lambda p: p.stat().st_mtime, reverse=True):
        try:
            meta = json.loads(p.read_text(encoding='utf-8'))
        except (OSError, ValueError):
            continue
        if (UPLOADS / f"{meta.get('id')}.csv").exists():
            out.append(meta)
    return out[:20]


def _job(rid):
    run = runs[rid]
    run.update(status='running', started=time.time())

    def say(stage, text=''):
        run.update(stage=stage, text=text)
    try:
        result = combi.run(UPLOADS / f"{run['file_id']}.csv", run['cfg'], progress=say)
        say('payload', '화면에 보낼 값을 만드는 중')
        payload = views.run_payload(result)
        views.compact(result)
        run.update(status='done', result=result, payload=payload, finished=time.time(), text='')
    except Exception as e:                      # 화면에 원인을 보여 주고 서버는 계속 돈다
        run.update(status='error', error=f'{type(e).__name__}: {e}', trace=traceback.format_exc(), finished=time.time())
    with lock:                                  # 오래된 실행의 상세용 데이터는 비운다 (순위표 · funnel은 남김)
        done = [k for k, v in runs.items() if v.get('result') is not None]
        for k in done[:-KEEP_RESULTS]:
            runs[k]['result'] = None


@app.post('/api/runs')
def start_run(req: RunRequest):
    _csv(req.file_id)
    try:
        cfg = combi.Settings.from_dict(req.settings)
    except (TypeError, ValueError) as e:
        raise HTTPException(400, str(e))
    with lock:
        for rid, v in reversed(runs.items()):   # 같은 파일 · 같은 설정으로 돌고 있거나 끝난 실행은 그대로 쓴다
            if v['file_id'] == req.file_id and v['cfg'] == cfg and (v['status'] in ('queued', 'running')
                                                                      or (v['status'] == 'done' and v.get('result') is not None)):
                return {'run_id': rid}
        rid = uuid.uuid4().hex[:12]
        runs[rid] = {'id': rid, 'file_id': req.file_id, 'cfg': cfg, 'status': 'queued', 'stage': 'queued',
                     'text': '차례를 기다리는 중', 'created': time.time()}
    worker.submit(_job, rid)
    return {'run_id': rid}


def _run(rid):
    v = runs.get(rid)
    if v is None:
        raise HTTPException(404, '실행 기록이 없습니다. 서버가 다시 시작됐으면 Run을 다시 눌러 주세요.')
    return v


@app.get('/api/runs/{rid}')
def run_status(rid: str):
    v = _run(rid)
    ahead = sum(1 for k, x in runs.items() if x['status'] in ('queued', 'running') and x['created'] < v['created'])
    t0 = v.get('started') or v['created']
    return {'id': rid, 'status': v['status'], 'stage': v.get('stage'), 'text': v.get('text'), 'error': v.get('error'),
            'ahead': ahead if v['status'] == 'queued' else 0, 'elapsed': round((v.get('finished') or time.time()) - t0, 1)}


@app.get('/api/runs/{rid}/result')
def run_result(rid: str):
    v = _run(rid)
    if v['status'] != 'done':
        raise HTTPException(409, '아직 끝나지 않았습니다.')
    return v['payload']


@app.post('/api/runs/{rid}/detail')
def run_detail(rid: str, req: DetailRequest):
    v = _run(rid)
    if v['status'] != 'done' or v.get('result') is None:
        raise HTTPException(409, '상세 계산용 데이터가 비워졌습니다. Run을 다시 눌러 주세요.')
    try:
        return views.detail_payload(v['result'], req.step, req.items)
    except (ValueError, IndexError) as e:
        raise HTTPException(400, str(e))


app.mount('/', StaticFiles(directory=BASE / 'static', html=True), name='static')
