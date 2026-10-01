"""전체 실행: raw.csv → 판정 결과. 웹 서버와 확인 스크립트가 함께 쓴다"""
import time
from dataclasses import dataclass

from .engine import analyze, build_index, classify, thresholds
from .load import build_data, read_raw
from .prepare import prepare
from .ranking import rank_targets
from .settings import Settings


@dataclass
class Result:
    cfg: Settings
    data: dict          # 웨이퍼 배열 (판정용 Value · bad · STEP · Order별 유닛 · track-in 시각)
    res: dict           # 조합과 판정 (analyze · classify 결과)
    zk: list            # Order 수별 기본 기준 z (퍼짐 배수를 곱하기 전)
    spread: float       # 퍼짐 배수
    prep: dict          # 치우침 · part 맞춤 내용
    summary: dict       # 데이터 요약 (웨이퍼 · lot · STEP 수 등)
    counts: dict        # 기준선 밖 · 불량 판정 · 혐의 대상에 포함 · 더 좁은 조합이 원인 수
    ranked: dict        # 혐의 대상 순위 (top · same_as · cross)
    quality: object     # 데이터 점검 표 (DataFrame)
    warnings: list      # 확인할 점
    timings: dict       # 단계별 걸린 시간 (초)


def run(csv_path, cfg=None, progress=None):
    """raw.csv를 읽어 판정까지. progress(stage, text)로 진행 단계를 알린다"""
    cfg = cfg or Settings()
    say = progress or (lambda stage, text='': None)
    times, t0 = {}, time.perf_counter()
    say('read', 'raw.csv 읽는 중')
    loaded = read_raw(csv_path, cfg)
    data, summary = build_data(loaded, cfg)
    times['read'] = time.perf_counter() - t0
    say('prepare', 'Value 치우침 · part 맞춤')
    prep = prepare(data, cfg)
    t1 = time.perf_counter()
    res = analyze(data, min_n=cfg.min_n, max_depth=cfg.max_depth, spread_adjust=cfg.spread_adjust,
                  progress=lambda k: say('analyze', f'Order {k}개 조합 계산 중'))
    times['analyze'] = time.perf_counter() - t1
    say('judge', '기준선 · 판정')
    t2 = time.perf_counter()
    zk = thresholds(res, cfg.spread_adjust, value_curve=False)
    counts = classify(res, zk, data)
    build_index(res)
    ranked = rank_targets(data, res, zk, cfg.same_wafers)
    times['judge'] = time.perf_counter() - t2
    times['total'] = time.perf_counter() - t0
    return Result(cfg=cfg, data=data, res=res, zk=zk, spread=float(res['spread'](1.0)), prep=prep, summary=summary, counts=counts,
                  ranked=ranked, quality=loaded.quality, warnings=loaded.warnings, timings=times)
