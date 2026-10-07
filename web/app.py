"""UNIT_COMMONALITY 웹 서버: Job ID로 DB에서 이력 가져오기 → 판정 실행(따로 프로세스에서, 여러 개 동시에) → funnel · 순위표 · 상세 화면.
실행마다 data/runs/<id>/에 설정 · 결과 · 상세용 데이터를 저장해 두어, 실행 기록에서 고르면 다시 계산하지 않고 연다"""
import hashlib
import json
import multiprocessing as mp
import os
import pickle
import re
import shutil
import threading
import time
import uuid
from collections import OrderedDict
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import combi
from combi import db, views

from . import worker

BASE = Path(__file__).resolve().parent


def _load_env(path):
    """KEY=VALUE 줄로 된 .env 파일을 환경 변수로 읽는다 (이미 있는 값은 그대로). DB 접속 정보처럼 git에 올리면 안 되는 값을 둔다"""
    try:
        lines = path.read_text(encoding='utf-8').splitlines()
    except OSError:
        return
    for line in lines:
        m = re.match(r'\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$', line)
        if not m or line.lstrip().startswith('#'):
            continue
        k, v = m.groups()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in '"\'':
            v = v[1:-1]
        os.environ.setdefault(k, v)


_load_env(BASE.parent / '.env')
DATA_DIR = Path(os.environ.get('COMBI_DATA_DIR', BASE.parent / 'data')).resolve()   # 올린 파일 · 실행 기록을 두는 곳
UPLOADS, RUNS = DATA_DIR / 'uploads', DATA_DIR / 'runs'
for _p in (UPLOADS, RUNS):
    _p.mkdir(parents=True, exist_ok=True)
WORKERS = max(1, int(os.environ.get('COMBI_WORKERS', '4')))            # 동시에 돌리는 판정 수 (넘으면 먼저 누른 순서대로 기다림)
KEEP_RESULTS = max(1, int(os.environ.get('COMBI_KEEP_RESULTS', '3')))  # 상세 화면용 데이터를 메모리에 올려 두는 실행 수 (나머지는 디스크에서 다시 읽음)
ACTIVE = ('queued', 'running')


def _code_version():
    """판정 코드의 지문: 코드가 바뀐 뒤에는 같은 파일 · 같은 설정이어도 예전 기록을 다시 쓰지 않고 새로 계산한다"""
    h = hashlib.sha1()
    for p in sorted((BASE.parent / 'combi').glob('*.py')) + [BASE / 'worker.py']:
        h.update(p.read_bytes())
    return h.hexdigest()[:10]


CODE = _code_version()
spawn = mp.get_context('spawn')      # 계산마다 새 프로세스: 여럿이 함께 돌고, 끝나면 쓴 메모리를 프로세스째 돌려준다
slots = threading.Semaphore(WORKERS)
runs = {}                            # run_id → 실행 기록 (meta.json 내용)
procs = {}                           # run_id → 돌고 있는 계산 프로세스
states = OrderedDict()               # run_id → 상세 계산용 데이터 (최근에 연 것만)
lock, state_lock = threading.Lock(), threading.Lock()


def _save(v):
    worker.write_json(RUNS / v['id'] / 'meta.json', v)


def _settle(v, exitcode=None):
    """계산 프로세스가 남긴 outcome.json을 실행 기록에 합친다"""
    d = RUNS / v['id']
    try:
        out = json.loads((d / 'outcome.json').read_text(encoding='utf-8'))
    except (OSError, ValueError):
        out = {'ok': False, 'error': '계산이 중간에 멈췄습니다 (서버를 다시 켰거나 메모리가 모자랐을 수 있습니다). Run을 다시 누르세요.'
               if exitcode is None or exitcode < 0 else f'계산 프로세스가 비정상으로 끝났습니다 (종료 코드 {exitcode}).'}
    ok = out.pop('ok')
    v.update(out, status='done' if ok else 'error', finished=time.time())
    v['seconds'] = round(v['finished'] - v.get('started', v['created']), 1)
    csv = UPLOADS / f"{v['file_id']}.csv"
    if v.get('job_source') and csv.exists():          # DB에서 가져온 raw.csv 크기
        v['file_size'] = csv.stat().st_size
    for name in ('progress.json', 'outcome.json'):
        (d / name).unlink(missing_ok=True)
    _save(v)


def _scan():
    """서버를 켤 때 저장된 실행 기록을 읽는다. 끝나지 못한 실행은 중단으로 표시"""
    for path in RUNS.glob('*/meta.json'):
        try:
            v = json.loads(path.read_text(encoding='utf-8'))
        except (OSError, ValueError):
            continue
        if v.get('status') in ACTIVE:
            if (path.parent / 'outcome.json').exists():
                _settle(v)
            else:
                v.update(status='error', error='서버가 다시 시작되어 중단됐습니다. Run을 다시 누르세요.', finished=time.time())
                (path.parent / 'progress.json').unlink(missing_ok=True)
                _save(v)
        runs[v['id']] = v


def _stop():
    with lock:
        for p in procs.values():
            if p.is_alive():
                p.terminate()


@asynccontextmanager
async def lifespan(_):
    _scan()
    yield
    _stop()


app = FastAPI(title='UNIT_COMMONALITY', docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)


@app.middleware('http')
async def revalidate_pages(request, call_next):
    """화면 파일(HTML · JS · CSS)은 쓸 때마다 바뀌었는지 서버에 묻게 한다. 새 버전을 올린 뒤 브라우저가 예전 파일을 쓰지 않게"""
    resp = await call_next(request)
    if not request.url.path.startswith('/api/'):
        resp.headers['Cache-Control'] = 'no-cache'
    return resp


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


def _file_meta(fid):
    try:
        return json.loads((UPLOADS / f'{fid}.json').read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return {}


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
    with slots:                                  # 동시에 WORKERS개까지 돈다
        with lock:
            v = runs.get(rid)
            if v is None:                        # 기다리는 동안 지운 실행
                return
            p = spawn.Process(target=worker.main, args=(str(RUNS / rid), str(UPLOADS / f"{v['file_id']}.csv"), v['settings'], v.get('job_source')),
                              name=f'combi-{rid}', daemon=True)
            p.start()
            procs[rid] = p
            v.update(status='running', started=time.time())
            _save(v)
        p.join()
    with lock:
        procs.pop(rid, None)
        v = runs.get(rid)
        if v is not None:                        # 실행 중에 지운 기록이면 v가 없다
            _settle(v, p.exitcode)


@app.post('/api/runs')
def start_run(req: RunRequest):
    _csv(req.file_id)
    try:
        cfg = combi.Settings.from_dict(req.settings).to_dict()
    except (TypeError, ValueError) as e:
        raise HTTPException(400, str(e))
    with lock:
        for v in sorted(runs.values(), key=lambda x: x['created'], reverse=True):   # 같은 파일 · 같은 설정 · 같은 코드면 그 기록을 연다
            if (v['file_id'] == req.file_id and v['settings'] == cfg and v.get('code') == CODE
                    and (v['status'] in ACTIVE or (v['status'] == 'done' and (RUNS / v['id'] / 'result.json').exists()))):
                return {'run_id': v['id'], 'reused': True}
        rid = uuid.uuid4().hex[:12]
        (RUNS / rid).mkdir()
        fm = _file_meta(req.file_id)
        v = {'id': rid, 'file_id': req.file_id, 'file_name': fm.get('name', ''), 'file_size': fm.get('size'), 'settings': cfg,
             'code': CODE, 'status': 'queued', 'created': time.time()}
        runs[rid] = v
        _save(v)
    threading.Thread(target=_job, args=(rid,), daemon=True).start()
    return {'run_id': rid, 'reused': False}


class JobRequest(BaseModel):
    job_id: str
    settings: dict = {}


@app.post('/api/jobs')
def start_job(req: JobRequest):
    """job_id로 DB에서 데이터를 가져와 실행한다. 가져온 raw.csv는 올린 파일 목록에도 남아 설정만 바꿔 다시 돌릴 수 있다"""
    try:
        jid = db.check_job_id(req.job_id)
        cfg = combi.Settings.from_dict(req.settings).to_dict()
    except (TypeError, ValueError) as e:
        raise HTTPException(400, str(e))
    if not db.db_url():
        raise HTTPException(503, 'DB 접속 정보가 없어 job_id로 가져올 수 없습니다. 서버의 .env 파일에 COMBI_DB_URL을 넣고 서버를 다시 켜 주세요.')
    with lock:
        for v in runs.values():                       # 같은 job_id · 같은 설정으로 가져오는 중이면 그 실행을 같이 본다
            if v.get('job_source') == jid and v['settings'] == cfg and v['status'] in ACTIVE and v.get('code') == CODE:
                return {'run_id': v['id'], 'reused': True}
        rid, fid = uuid.uuid4().hex[:12], uuid.uuid4().hex[:12]
        (RUNS / rid).mkdir()
        v = {'id': rid, 'file_id': fid, 'file_name': f'job_{jid}.csv', 'file_size': None, 'settings': cfg, 'code': CODE,
             'status': 'queued', 'created': time.time(), 'job_source': jid, 'job_ids': [jid]}
        runs[rid] = v
        _save(v)
    threading.Thread(target=_job, args=(rid,), daemon=True).start()
    return {'run_id': rid, 'reused': False}


def _progress(rid):
    try:
        return json.loads((RUNS / rid / 'progress.json').read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return None


def _brief(v):
    """실행 기록 목록 · 상태 조회에 보내는 값"""
    out = {k: v.get(k) for k in ('id', 'file_id', 'file_name', 'file_size', 'settings', 'status', 'created', 'started', 'finished',
                                 'seconds', 'error', 'targets', 'wafers', 'job_ids', 'analysis_dates', 'job_source', 'no_data', 'rows')}
    out.update(old=v.get('code') != CODE, file_exists=(UPLOADS / f"{v['file_id']}.csv").exists(), stage=None, text='', ahead=0)
    now = time.time()
    if v['status'] == 'running':
        p = _progress(v['id']) or {'stage': 'start', 'text': '계산 프로세스를 띄우는 중'}
        out.update(stage=p['stage'], text=p['text'], seconds=round(now - v['started'], 1))
    elif v['status'] == 'queued':                # 먼저 누른 실행이 WORKERS개 이상 남아 있으면 기다린다
        ahead = max(0, sum(1 for x in runs.values() if x['status'] in ACTIVE and x['created'] < v['created']) - WORKERS + 1)
        out.update(stage='queued', ahead=ahead, seconds=round(now - v['created'], 1), text='시작하는 중' if not ahead else
                   f'동시 실행 {WORKERS}개가 모두 돌고 있어 기다리는 중')
    return out


def _run(rid):
    v = runs.get(rid)
    if v is None:
        raise HTTPException(404, '실행 기록이 없습니다. 지워졌으면 Run을 다시 눌러 주세요.')
    return v


@app.get('/api/runs')
def run_list():
    with lock:
        out = [_brief(v) for v in runs.values()]
    out.sort(key=lambda x: x['created'], reverse=True)
    return {'runs': out, 'workers': WORKERS, 'defaults': combi.Settings().to_dict(), 'db': bool(db.db_url())}


@app.get('/api/runs/{rid}')
def run_status(rid: str):
    with lock:
        return _brief(_run(rid))


@app.get('/api/runs/{rid}/result')
def run_result(rid: str):
    with lock:
        done = _run(rid)['status'] == 'done'
    path = RUNS / rid / 'result.json'
    if not done or not path.exists():
        raise HTTPException(409, '아직 끝나지 않았습니다.')
    return FileResponse(path, media_type='application/json')


def _state(rid):
    """상세 계산용 데이터: 최근에 연 KEEP_RESULTS개는 메모리에 두고, 나머지는 state.pkl에서 다시 읽는다"""
    with state_lock:
        if rid in states:
            states.move_to_end(rid)
            return states[rid]
        try:
            with open(RUNS / rid / 'state.pkl', 'rb') as f:
                st = pickle.load(f)
        except OSError:
            raise HTTPException(409, '상세 계산용 데이터가 없습니다. Run을 다시 눌러 주세요.')
        except Exception:
            raise HTTPException(409, '예전 코드로 저장된 기록이라 상세를 열 수 없습니다. Run을 다시 눌러 주세요.')
        states[rid] = st
        while len(states) > KEEP_RESULTS:
            states.popitem(last=False)
        return st


@app.post('/api/runs/{rid}/detail')
def run_detail(rid: str, req: DetailRequest):
    with lock:
        done = _run(rid)['status'] == 'done'
    if not done:
        raise HTTPException(409, '아직 끝나지 않았습니다.')
    try:
        return views.detail_payload(_state(rid), req.step, req.items)
    except (ValueError, IndexError) as e:
        raise HTTPException(400, str(e))


@app.get('/api/runs/{rid}/step/{step}')
def run_step(rid: str, step: int):
    """경로 비교(STEP 전체): 그 STEP에서 계산한 모든 조합의 점"""
    with lock:
        done = _run(rid)['status'] == 'done'
    if not done:
        raise HTTPException(409, '아직 끝나지 않았습니다.')
    try:
        out = views.step_payload(_state(rid), step)
    except (ValueError, IndexError) as e:
        raise HTTPException(400, str(e))
    if out is None:
        raise HTTPException(409, '이 실행은 STEP 전체 조합을 저장하지 않은 예전 기록입니다. Run을 다시 누르면 볼 수 있습니다 (같은 Order 보기는 됩니다).')
    return out


class CompareRequest(BaseModel):
    targets: list[DetailRequest]


@app.post('/api/runs/{rid}/compare')
def run_compare(rid: str, req: CompareRequest):
    """비교 띠: 고른 대상들의 이 경로 · 다른 Unit 웨이퍼의 bad 비율과 대상끼리 웨이퍼 겹침 (저장된 결과로 계산)"""
    with lock:
        done = _run(rid)['status'] == 'done'
    if not done:
        raise HTTPException(409, '아직 끝나지 않았습니다.')
    if not 1 <= len(req.targets) <= 200:
        raise HTTPException(400, '비교할 대상은 1~200개입니다.')
    try:
        return views.compare_payload(_state(rid), [t.model_dump() for t in req.targets])
    except (ValueError, IndexError) as e:
        raise HTTPException(400, str(e))


@app.delete('/api/runs/{rid}')
def delete_run(rid: str):
    """실행 기록을 지운다. 돌고 있으면 계산을 멈추고 지운다"""
    with lock:
        _run(rid)
        runs.pop(rid)
        p = procs.get(rid)
    if p is not None and p.is_alive():
        p.terminate()
        p.join(10)
        if p.is_alive():
            p.kill()
            p.join(5)
    with state_lock:
        states.pop(rid, None)
    shutil.rmtree(RUNS / rid, ignore_errors=True)
    return {'deleted': rid}


app.mount('/', StaticFiles(directory=BASE / 'static', html=True), name='static')
