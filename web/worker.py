"""판정 한 번 (서버와 다른 프로세스에서 실행): raw.csv → 화면 결과(result.json)와 상세용 데이터(state.pkl)를 실행 폴더에 저장"""
import json
import os
import pickle
import signal
import time
import traceback
from pathlib import Path

import combi
from combi import views


def write_json(path, obj):
    """반쯤 쓴 파일을 읽지 않게 임시 파일에 쓴 뒤 바꿔 넣는다"""
    path = Path(path)
    tmp = path.with_name(path.name + '.tmp')
    tmp.write_text(json.dumps(obj, ensure_ascii=False, allow_nan=False), encoding='utf-8')
    os.replace(tmp, path)


def compute(run_dir, csv_path, settings):
    run_dir = Path(run_dir)

    def say(stage, text=''):
        write_json(run_dir / 'progress.json', {'stage': stage, 'text': text})
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


def main(run_dir, csv_path, settings):
    """계산 프로세스의 시작점: 끝나면 결과 요약이나 오류를 outcome.json에 남긴다 (서버가 읽어 실행 기록에 합침)"""
    signal.signal(signal.SIGINT, signal.SIG_IGN)   # 터미널의 Ctrl+C는 서버만 받는다 (서버가 끌 때 계산 프로세스를 멈춤)
    t0 = time.time()
    try:
        out = {'ok': True, **compute(run_dir, csv_path, settings)}
    except Exception as e:                      # 화면에 원인을 보여 준다
        out = {'ok': False, 'error': f'{type(e).__name__}: {e}', 'trace': traceback.format_exc()}
    out['compute_seconds'] = round(time.time() - t0, 1)
    write_json(Path(run_dir) / 'outcome.json', out)
