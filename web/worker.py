"""판정 한 번 (서버와 다른 프로세스에서 실행): (job_id면 DB에서 raw.csv를 먼저 만들고) raw.csv → 화면 결과(result.json)와
상세용 데이터(state.pkl)를 실행 폴더에 저장"""
import json
import os
import pickle
import signal
import time
import traceback
from datetime import datetime
from pathlib import Path

import combi
from combi import db, views


def write_json(path, obj):
    """반쯤 쓴 파일을 읽지 않게 임시 파일에 쓴 뒤 바꿔 넣는다"""
    path = Path(path)
    tmp = path.with_name(path.name + '.tmp')
    tmp.write_text(json.dumps(obj, ensure_ascii=False, allow_nan=False), encoding='utf-8')
    os.replace(tmp, path)


def reporter(run_dir):
    """진행 단계를 progress.json으로 (서버가 읽어 화면에 보여 준다)"""
    def say(stage, text=''):
        write_json(Path(run_dir) / 'progress.json', {'stage': stage, 'text': text})
    return say


def fetch(run_dir, csv_path, job_id):
    """DB에서 job_id의 raw.csv를 만들어 올린 파일 목록에도 넣는다 (설정만 바꿔 다시 돌릴 때는 DB에 다시 묻지 않음)"""
    csv_path = Path(csv_path)
    rows = db.fetch_job(job_id, csv_path, progress=reporter(run_dir))
    write_json(csv_path.with_suffix('.json'), {'id': csv_path.stem, 'name': f'job_{job_id}.csv', 'size': csv_path.stat().st_size,
                                               'uploaded': datetime.now().isoformat(timespec='seconds'), 'source': 'db', 'job_id': job_id})
    return {'rows': rows}


def compute(run_dir, csv_path, settings):
    run_dir = Path(run_dir)
    say = reporter(run_dir)
    result = combi.run(csv_path, combi.Settings.from_dict(settings), progress=say)
    say('payload', '화면에 보낼 값을 만드는 중')
    payload = views.run_payload(result)
    write_json(run_dir / 'result.json', payload)
    tmp = run_dir / 'state.pkl.tmp'
    with open(tmp, 'wb') as f:
        pickle.dump(views.detail_state(result), f, protocol=pickle.HIGHEST_PROTOCOL)
    os.replace(tmp, run_dir / 'state.pkl')
    s = result.summary
    return {'targets': len(payload['ranking']), 'wafers': s['wafers'], 'job_ids': s['job_ids'], 'analysis_dates': s['analysis_dates']}


def main(run_dir, csv_path, settings, job_id=None):
    """계산 프로세스의 시작점: 끝나면 결과 요약이나 오류를 outcome.json에 남긴다 (서버가 읽어 실행 기록에 합침).
    job_id가 있으면 DB에서 raw.csv를 먼저 만든다"""
    signal.signal(signal.SIGINT, signal.SIG_IGN)   # 터미널의 Ctrl+C는 서버만 받는다 (서버가 끌 때 계산 프로세스를 멈춤)
    t0 = time.time()
    try:
        got = fetch(run_dir, csv_path, job_id) if job_id else {}
        out = {'ok': True, **compute(run_dir, csv_path, settings), **got}
    except db.NoData as e:                      # DB에 없으면 raw.csv를 올리라고 안내
        out = {'ok': False, 'error': str(e), 'no_data': True}
    except Exception as e:                      # 화면에 원인을 보여 준다 (DB 비밀번호는 가림)
        out = {'ok': False, 'error': db.mask(f'{type(e).__name__}: {e}'), 'trace': db.mask(traceback.format_exc())}
    out['compute_seconds'] = round(time.time() - t0, 1)
    write_json(Path(run_dir) / 'outcome.json', out)
