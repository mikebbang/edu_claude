"""웹 화면에 보낼 값: 결과 요약 · funnel 점과 경계선 · 순위표 · 상세(선택 경로 · 같은 Order 다른 경로 · 웨이퍼)"""
import math

import numpy as np

from .engine import MISSING, mean_z, members_of, order_text, share_group
from .ranking import expected_bad, metric, path_label, same_paths
from .stats import shrink

GRAY_MAX = 40000             # funnel에 그리는 기준선 안 점의 최대 수 (넘으면 고르게 골라 그림 · 모양은 같음)
PEER_MAX = 600               # 같은 Order 다른 경로 비교에 그리는 경로의 최대 수 (웨이퍼가 많은 순)


def num(x, d=6):
    """JSON에 넣을 수: NaN · inf는 None, 나머지는 반올림한 float"""
    x = float(x)
    return None if not math.isfinite(x) else round(x, d)


def nums(a, d=6):
    return [num(v, d) for v in np.asarray(a, dtype=float).tolist()]


def _grid(lo, hi, k=80):
    lo, hi = max(1.0, float(lo)), max(float(hi), float(lo) + 1)
    return lo * (hi / lo) ** (np.arange(k) / (k - 1))


def _scales(result):
    """세 가지 세로축의 기준: 판정용 Value(Y)와 원래 y_value · bad 비율의 평균과 흩어짐"""
    d, r = result.data, result.res
    v = np.asarray(d['value'], dtype=float)
    p0 = r['p0']
    return {'mu': r['mu'], 'sd': r['sd'], 'N': r['N'], 'vmu': float(np.mean(v)), 'vsd': float(np.std(v, ddof=1)),
            'p0': p0, 'bsd': math.sqrt(p0 * (1 - p0)) if p0 is not None else None}


def _half(sc, z, n):
    """기준 z가 z일 때 웨이퍼 n장 평균이 판정용 Value 눈금에서 벗어날 수 있는 폭"""
    n = np.asarray(n, dtype=float)
    return z * sc['sd'] / np.sqrt(n) * shrink(n, sc['N'])


def _bounds(sc, thr, grid):
    """세 가지 세로축의 경계선(위 · 아래). 종합은 판정 기준, y_value 평균 · bad 비율은 그 신호만 볼 때의 기준선"""
    sh = shrink(grid, sc['N'])
    out = {'n': nums(grid, 3),
           'judg': {'lo': nums(sc['mu'] - _half(sc, thr, grid)), 'hi': nums(sc['mu'] + _half(sc, thr, grid)), 'mid': num(sc['mu'])},
           'mean': {'lo': nums(sc['vmu'] - thr * sc['vsd'] / np.sqrt(grid) * sh), 'hi': nums(sc['vmu'] + thr * sc['vsd'] / np.sqrt(grid) * sh),
                    'mid': num(sc['vmu'])}}
    if sc['p0'] is not None:
        hw = thr * sc['bsd'] / np.sqrt(grid) * sh
        out['bad'] = {'lo': nums(np.clip(sc['p0'] - hw, 0, 1)), 'hi': nums(np.clip(sc['p0'] + hw, 0, 1)), 'mid': num(sc['p0'])}
    return out


def target_row(result, rank, c):
    """순위표 한 줄"""
    d, r, ranked = result.data, result.res, result.ranked
    st = d['steps'][c['step']]
    m = members_of(d, c)
    has_b = d['B'] is not None
    notes = []
    alts = same_paths(d, r, ranked, c['key'])
    if alts:
        notes.append('같은 웨이퍼: ' + ', '.join(alts[:3]) + (f' 외 {len(alts) - 3}개' if len(alts) > 3 else ''))
    if (a := ranked['cross'].get(c['key'])) is not None:
        notes.append(f"다른 STEP 탓 의심: {d['steps'][a['step']]['name']} {path_label(d['steps'][a['step']], a['items'])}")
    return {'rank': rank, 'key': c['key'], 'step': c['step'], 'step_name': st['name'], 'desc': st['proc'], 'k': c['k'],
            'items': [[int(q), int(u)] for q, u in c['items']], 'path': path_label(st, c['items']), 'n': c['n'],
            'bad': num(np.nanmean(d['bad'][m]), 4) if has_b else None, 'exp_bad': num(expected_bad(c, r), 4) if has_b else None,
            'excess': num(metric(c, r), 2), 'vmean': num(np.nanmean(d['value'][m])), 'certainty': num(c['z'] / c['thr'], 3),
            'note': ' · '.join(notes)}


def run_payload(result):
    """실행이 끝난 뒤 한 번 만드는 결과: 요약 · 순위표 · funnel"""
    d, r, zk, s = result.data, result.res, result.zk, result.spread
    sc = _scales(result)
    combos = r['combos']
    top = result.ranked['top']
    rank_of = {c['key']: i + 1 for i, c in enumerate(top)}
    tgt = {}                                                # 기준선 밖 점 → 묶인 혐의 대상 순위 (툴팁용)
    for key, pts in result.ranked['by_target'].items():
        for c in pts:
            if key is not None:
                tgt[c['key']] = rank_of.get(result.ranked['same_as'].get(key, key))
    n = np.array([c['n'] for c in combos], dtype=float)
    z = np.array([c['z'] for c in combos], dtype=float)
    thr = np.array([c['thr'] for c in combos], dtype=float)
    yj = sc['mu'] + z / thr * _half(sc, zk[1] * s, n)       # 종합: 자기 기준 대비 위치를 Order 1개 기준 띠에 맞춘 높이 (띠 밖 ⇔ 판정 밖)
    ym = np.array([c['vmean'] for c in combos], dtype=float)
    yb = np.array([c['bad_rate'] for c in combos], dtype=float) if d['B'] is not None else None
    over = np.array([c['over'] for c in combos], dtype=bool)
    good = z < -thr                                         # 경계 밖 · 좋은 쪽 (기준선보다 뚜렷하게 낮음)
    gray = np.flatnonzero(~over & ~good)
    if len(gray) > GRAY_MAX:
        gray = np.sort(np.random.default_rng(0).choice(gray, GRAY_MAX, replace=False))
    pick = lambda idx: {'n': [int(v) for v in n[idx]], 'judg': nums(yj[idx], 5), 'mean': nums(ym[idx], 5),
                        'bad': nums(yb[idx], 5) if yb is not None else None}
    marks = []                                              # 경계 밖 점 (bad · good path)
    steps = d['steps']
    for i in np.flatnonzero(over | good):
        c = combos[i]
        st = steps[c['step']]
        marks.append({'side': 'bad' if over[i] else 'good', 'n': c['n'], 'judg': num(yj[i], 5), 'mean': num(ym[i], 5),
                      'bad': num(yb[i], 5) if yb is not None else None, 'rank': rank_of.get(c['key']), 'target': tgt.get(c['key']),
                      'label': f"{st['name']} {path_label(st, c['items'])}", 'k': c['k'], 'certainty': num(c['z'] / c['thr'], 3)})
    groups = {g: m for g, m in result.res['share_groups'].items()}
    counts = result.counts
    info = {
        'data': result.summary, 'warnings': result.warnings, 'notes': result.prep['notes'], 'y_name': result.prep['y_name'],
        'settings': result.cfg.to_dict(), 'timings': {k: round(v, 1) for k, v in result.timings.items()},
        'judge': {'combos': len(combos), 'possible': int(sum(r['search_space'][1:])), 'over': counts['over'], 'bad': counts['bad'],
                  'targets': len(top), 'depth': r['max_depth'], 'spread': num(s, 3), 'sigma': r.get('sigma'),
                  'same_orders': sum(len(v) for v in r['same_orders'].values()),
                  'groups': [{'name': order_text(g), 'possible': int(m), 'z': num(zk[min(g, len(zk) - 1)], 3),
                              'z_spread': num(zk[min(g, len(zk) - 1)] * s, 3)} for g, m in groups.items()]},
        'has_bad': d['B'] is not None, 'higher_is_worse': result.cfg.higher_is_worse}
    lo_n, hi_n = (n.min() * 0.9, n.max() * 1.1) if len(n) else (2, 10)
    return {'info': info, 'ranking': [target_row(result, i + 1, c) for i, c in enumerate(top)],
            'funnel': {'gray': pick(gray), 'gray_total': int((~over & ~good).sum()), 'marks': marks,
                       'bounds': _bounds(sc, zk[1] * s, _grid(lo_n, hi_n))}}


def compact(result):
    """상세 계산에 필요 없는 조합 목록을 버려 메모리를 줄인다 (순위표의 혐의 대상과 한 줄로 묶인 대상만 남김)"""
    r = result.res
    keys = {c['key'] for c in result.ranked['top']} | set(result.ranked['same_as'])
    r['by_key'] = {k: r['by_key'][k] for k in keys if k in r['by_key']}
    r['combos'] = list(r['by_key'].values())
    r.pop('over_index', None)
    for k in ('by_target', 'over'):
        result.ranked.pop(k, None)


def detail_payload(result, step, items):
    """선택한 STEP · 경로(Order와 Unit 묶음)의 상세. items = [(Order 번호 q, Unit 번호 u), ...]"""
    d, r, zk, s = result.data, result.res, result.zk, result.spread
    st, A = d['steps'][step], d['assign'][step]
    items = sorted((int(q), int(u)) for q, u in items)
    if not items:
        raise ValueError('Order를 하나 이상 고르세요')
    has_b = d['B'] is not None
    bad01 = np.nan_to_num(d['bad']) if has_b else np.zeros(d['N'])
    value = np.asarray(d['value'], dtype=float)
    orders = []
    for q, sq in enumerate(st['seqs']):                     # Order × Unit 칸: Unit마다 웨이퍼 수 · bad 비율 · y_value 평균
        a = A[q]
        ok = a != MISSING
        nu = len(sq['units'])
        cnt = np.bincount(a[ok], minlength=nu)
        bsum = np.bincount(a[ok], weights=bad01[ok], minlength=nu)
        vsum = np.bincount(a[ok], weights=value[ok], minlength=nu)
        orders.append({'q': q, 'name': sq['name'], 'seq': sq['seq'], 'desc': sq['desc'],
                       'units': [{'u': u, 'name': name, 'n': int(cnt[u]), 'bad': num(bsum[u] / cnt[u], 4) if cnt[u] and has_b else None,
                                  'vmean': num(vsum[u] / cnt[u]) if cnt[u] else None} for u, name in enumerate(sq['units'])]})
    qs = [q for q, _ in items]
    through = np.all(A[qs] != MISSING, axis=0)              # 고른 Order를 모두 지난 웨이퍼
    member = through & np.all([A[q] == u for q, u in items], axis=0)
    rest = through & ~member
    k = len(items)
    thr = zk[min(k, len(zk) - 1)] * s if len(zk) > 1 else math.nan
    if k >= len(zk) and share_group(k) != share_group(len(zk) - 1):
        thr = math.nan                                      # 계산한 Order 수보다 많이 고르면 그 묶음의 기준이 없을 수 있다
    z = mean_z(d, r, member) if member.sum() >= 2 else math.nan
    sel = {'items': [[q, u] for q, u in items], 'label': path_label(st, items), 'n': int(member.sum()),
           'bad': num(bad01[member].mean(), 4) if has_b and member.any() else None,
           'rest_n': int(rest.sum()), 'rest_bad': num(bad01[rest].mean(), 4) if has_b and rest.any() else None,
           'vmean': num(value[member].mean()) if member.any() else None, 'certainty': num(z / thr, 3) if math.isfinite(thr) else None,
           'k': k, 'group': order_text(k)}
    # 고른 Order들의 Unit 조합(경로)마다: 웨이퍼 산점도 범례 · 같은 Order 다른 경로 비교
    U = np.stack([A[q][through] for q in qs], axis=1).astype(np.int64)
    combos_, inv, cnt = np.unique(U, axis=0, return_inverse=True, return_counts=True)
    inv = inv.ravel()
    sel_row = np.array([u for _, u in items])
    sel_g = int(np.flatnonzero((combos_ == sel_row).all(axis=1))[0]) if member.any() else -1
    wid = np.flatnonzero(through)
    sc = _scales(result)
    groups = []
    for g, row in enumerate(combos_.tolist()):
        gi = wid[inv == g]
        groups.append({'label': ' × '.join(f"{st['seqs'][q]['name']}:{st['seqs'][q]['units'][u]}" for q, u in zip(qs, row)),
                       'units': row, 'n': int(cnt[g]), 'bad': num(bad01[gi].mean(), 4) if has_b else None,
                       'vmean': num(value[gi].mean())})
    peers = []
    order_g = np.argsort(-cnt, kind='stable')
    for g in order_g[:PEER_MAX]:
        if cnt[g] < result.cfg.min_n and g != sel_g:
            continue
        m = np.zeros(d['N'], dtype=bool)
        m[wid[inv == g]] = True
        zg = mean_z(d, r, m) if m.sum() >= 2 else math.nan
        peers.append({'g': int(g), 'n': int(cnt[g]), 'mean': groups[g]['vmean'], 'bad': groups[g]['bad'],
                      'judg': num(sc['mu'] + zg / thr * float(_half(sc, zk[1] * s, cnt[g]))) if math.isfinite(thr) else None,
                      'certainty': num(zg / thr, 3) if math.isfinite(thr) else None})
    q_last = max(qs)                                        # 시간축: 고른 Order 중 마지막 Order의 track-in 시각
    tk = d['tk'][step][q_last][through].astype(np.int64)
    base_ms = int(d['t_base'].astype('datetime64[ms]').astype(np.int64))
    has_t = tk >= 0
    wafers = {'t': [base_ms + 1000 * int(t) if ok_ else None for t, ok_ in zip(tk.tolist(), has_t.tolist())],
              'v': nums(value[through], 6), 'b': [int(x) for x in bad01[through]] if has_b else None, 'g': inv.tolist()}
    pn = [p['n'] for p in peers] or [result.cfg.min_n]
    peer_bounds = _bounds(sc, thr, _grid(max(2, result.cfg.min_n), max(pn) * 1.15)) if math.isfinite(thr) else None
    if peer_bounds:                                         # 종합 축은 큰 funnel과 같은 눈금(자기 기준 대비 위치 × Order 1개 기준 띠)
        g_ = np.asarray(peer_bounds['n'], dtype=float)
        peer_bounds['judg'] = {'lo': nums(sc['mu'] - _half(sc, zk[1] * s, g_)), 'hi': nums(sc['mu'] + _half(sc, zk[1] * s, g_)),
                               'mid': num(sc['mu'])}
    return {'step': step, 'step_name': st['name'], 'desc': st['proc'], 'orders': orders, 'selection': sel, 'groups': groups,
            'sel_group': sel_g, 'peers': peers, 'peer_bounds': peer_bounds, 'wafers': wafers, 'time_order': st['seqs'][q_last]['name'],
            'missing_time': int((~has_t).sum()), 'has_bad': has_b}
