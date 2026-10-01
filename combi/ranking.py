"""혐의 대상 순위: 기준선 밖 조합을 대표 대상으로 묶고 초과 bad 순으로 줄 세운다 (같은 웨이퍼 · 다른 STEP 탓 의심 포함)"""
from collections import defaultdict
from itertools import product

import numpy as np

from .engine import diff_z, members_of
from .stats import Z95


def path_label(st, items, sep=' → '):
    return sep.join(f"{st['seqs'][q]['name']}:{st['seqs'][q]['units'][u]}" for q, u in items)


def metric(c, r):
    """랭킹 · 대표 선택 기준: 초과 bad = B − E (실제 bad 장수 − 예상 bad 장수), 즉 고치면 줄어드는 bad 웨이퍼 수.
    bad를 part별로 맞췄으면 웨이퍼마다 (bad − 그 웨이퍼 part의 평소 bad 비율)의 합(= 예상 bad보다 몇 장 더),
    안 맞췄으면 웨이퍼 × (bad 비율 − 전체 bad 비율). good_bad가 없으면 웨이퍼 × y_value 차이"""
    return c['x_bad'] - c['x_exp'] if r['p0'] is not None else c['n'] * (c['mean'] - r['mu'])


def expected_bad(c, r):
    """예상 bad 비율 E ÷ n: part별로 맞췄으면 이 조합 웨이퍼들의 자기 part 평균 bad 비율의 평균, 아니면 전체 bad 비율"""
    return c['x_exp'] / c['n']


def candidates(r, c):
    """고른 조합과 같은 스텝에서 유닛을 하나 이상 공유하고 기준을 넘은 조합 (색인으로 찾음)"""
    found = {b['id']: b for it in c['items'] for b in r['over_index'].get((c['step'], it), ())}
    return [found[i] for i in sorted(found)]


def representative(r, zk_, c):
    """기준 밖 점의 대표 불량 대상: 같은 스텝에서 유닛을 공유하는 불량 조합 중 초과 bad 웨이퍼가 가장 많은 것"""
    bad = [b for b in candidates(r, c) if b['status'] == 'bad']
    return max(bad, key=lambda b: metric(b, r)) if bad else None


def reason(r, st, b, target):
    """후보가 혐의 대상과 어떤 관계인지 쉬운 말로"""
    if b is target:
        return '혐의 대상'
    if b['status'] == 'bad':
        return '따로 불량 (다른 혐의 대상)'
    if b['status'] == 'explained':
        return f"더 좁은 조합이 원인 ({path_label(st, r['combos'][b['explained_by']]['items'])})"
    pr = min(b['parents'], key=lambda p: p['t'])
    return f"혐의 대상에 포함 ({path_label(st, pr['items'])}만으로 설명됨)"


def cross_step_check(d, r, zk_):
    """스텝 간 규칙: 다른 스텝의 불량 조합 A와 웨이퍼가 겹치는 불량 조합 B에 대해, A를 지나지 않은 웨이퍼만 놓고
    B가 나머지보다 높은지(Welch t, 조합의 z와 같은 보정) 본다. B의 효과가 사라지고(t ≤ 1.96 × 퍼짐 배수) A는 B 없이도 기준을 넘으면 B를 'A 기인'으로 본다"""
    bads = [c for c in r['combos'] if c['status'] == 'bad']
    mem = {c['key']: members_of(d, c) for c in bads}

    def t_without(c, other):
        return diff_z(d, r, mem[c['key']] & ~mem[other['key']], ~mem[c['key']] & ~mem[other['key']])

    out = {}
    if not bads:
        return out
    M = np.array([mem[c['key']] for c in bads], dtype=np.float32)
    overlap = (M @ M.T) > 0                       # 웨이퍼가 겹치는 쌍을 한 번에
    for i, b in enumerate(bads):
        cause = [(t_without(b, a), a) for j, a in enumerate(bads) if overlap[i, j] and a['step'] != b['step']]
        cause = [(t, a) for t, a in cause if t <= Z95 * float(r['spread'](b['n'])) and t_without(a, b) > a['thr']]
        if cause:
            out[b['key']] = min(cause, key=lambda ta: ta[0])[1]
    return out


def same_order_paths(d, r, c):
    """같은 Order(STEP 안에서 웨이퍼가 나뉘는 모양이 완전히 같은 Order)로 바꿔 쓴, 웨이퍼가 똑같은 다른 경로들"""
    st = d['steps'][c['step']]
    opts = [[(q, u)] + [(q2, m[u]) for q2, m in r['same_orders'].get((c['step'], q), ())] for q, u in c['items']]
    return [path_label(st, sorted(p)) for p in product(*opts)][1:]


def rank_targets(data, res, zk, same_wafers=0.9):
    """기준선 밖 조합마다 대표 불량 대상(같은 STEP에서 유닛을 공유하는 불량 조합 중 초과 bad가 가장 큰 것)을 정하고,
    초과 bad 순으로 줄 세운다. 웨이퍼가 same_wafers 이상 같은 대상은 순위가 높은 쪽 한 줄로 묶는다(same_as)"""
    over_pts = [c for c in res['combos'] if c['over']]
    by_target = defaultdict(list)
    for c in over_pts:
        t = representative(res, zk, c)
        by_target[t['key'] if t else None].append(c)
    cross = cross_step_check(data, res, zk)
    same_as, kept = {}, []
    for c in sorted((res['by_key'][k] for k in by_target if k is not None), key=lambda c: -metric(c, res)):
        m = members_of(data, c)
        hit = next((k2 for k2, m2 in kept if same_wafers and (m & m2).sum() >= same_wafers * (m | m2).sum()), None)
        if hit is None:
            kept.append((c['key'], m))
        else:
            same_as[c['key']] = hit
    return {'top': [res['by_key'][k] for k, _ in kept], 'same_as': same_as, 'by_target': by_target, 'cross': cross, 'over': over_pts}


def same_paths(data, res, ranked, key):
    """웨이퍼가 같은 다른 경로: 같은 Order로 바꿔 쓴 경로와 한 줄로 묶인 대상(같은 스텝이면 경로만, 다른 스텝이면 스텝과 경로)"""
    c = res['by_key'][key]
    out = same_order_paths(data, res, c)
    steps = data['steps']
    out += [path_label(steps[b['step']], b['items']) if b['step'] == c['step'] else f"{steps[b['step']]['name']} {path_label(steps[b['step']], b['items'])}"
            for b in (res['by_key'][k] for k, v in ranked['same_as'].items() if v == key)]
    return out
