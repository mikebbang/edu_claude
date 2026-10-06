"""웹 화면에 보낼 값: 결과 요약 · funnel 점과 경계선 · 순위표 · 상세(선택 경로 · 같은 Order 다른 경로 · 웨이퍼)"""
import math
from types import SimpleNamespace

import numpy as np

from .engine import MISSING, mean_z, members_of, order_text, share_group, sig_mean_z
from .ranking import expected_bad, metric, path_label, same_order_paths
from .stats import binom_fix, shrink, spread_of

GRAY_MAX = 40000             # funnel에 그리는 기준선 안 점의 최대 수 (넘으면 고르게 골라 그림 · 모양은 같음)
PEER_MAX = 600               # 같은 Order 다른 경로 비교에 그리는 경로의 최대 수 (웨이퍼가 많은 순)
STEP_MAX = 12000             # 경로 비교(STEP 전체)에 그리는 조합의 최대 수 (넘으면 기준선 안 조합을 고르게 골라 그림 · 순위는 모두로 셈)


def num(x, d=6):
    """JSON에 넣을 수: NaN · inf는 None, 나머지는 반올림한 float"""
    x = float(x)
    return None if not math.isfinite(x) else round(x, d)


def nums(a, d=6):
    return [num(v, d) for v in np.asarray(a, dtype=float).tolist()]


def _grid(lo, hi, k=80):
    lo, hi = max(1.0, float(lo)), max(float(hi), float(lo) + 1)
    return lo * (hi / lo) ** (np.arange(k) / (k - 1))


def _sig_spread(result):
    """신호마다 퍼짐 배수 (Value, bad): Order 1개 조합의 z_Value · z_bad를 결합 z와 같은 방법(spread_of)으로 잰다.
    신호 하나로만 판정할 때의 기준 = Order 수별 기본 기준 z × 이 배수. 실행 기록(state)에는 실행할 때 잰 것을 저장해 둔다.
    예전 코드로 저장한 기록에는 없다(None)"""
    sp = getattr(result, 'sig_spread', None)
    if sp is not None or not hasattr(result, 'ranked'):
        return sp
    one = [c for c in result.res['combos'] if c['k'] == 1]
    has_b = result.data['B'] is not None
    if not result.cfg.spread_adjust:
        sp = (1.0, 1.0 if has_b else None)
    else:
        sp = (spread_of(np.array([c['z_y'] for c in one])), spread_of(np.array([c['z_b'] for c in one])) if has_b else None)
    result.sig_spread = sp
    return sp


def _scales(result):
    """세로축의 기준: 판정용 Value(Y)와 원래 y_value · bad 비율의 평균과 흩어짐, Order 수별 기본 기준 z, 신호마다 퍼짐 배수.
    sign은 y_value가 판정용 Value와 같은 방향이면 1 (낮을수록 나쁘면 판정용 Value는 부호를 바꿔 쓴다)"""
    d, r = result.data, result.res
    v = np.asarray(d['value'], dtype=float)
    p0 = r['p0']
    return {'mu': r['mu'], 'sd': r['sd'], 'N': r['N'], 'vmu': float(np.mean(v)), 'vsd': float(np.std(v, ddof=1)),
            'p0': p0, 'bsd': math.sqrt(p0 * (1 - p0)) if p0 is not None else None,
            'zk': list(result.zk), 's': result.spread, 'sign': 1.0 if result.cfg.higher_is_worse else -1.0, 'sp': _sig_spread(result)}


def _half(sc, z, n):
    """기준 z가 z일 때 웨이퍼 n장 평균이 판정용 Value 눈금에서 벗어날 수 있는 폭"""
    n = np.asarray(n, dtype=float)
    return z * sc['sd'] / np.sqrt(n) * shrink(n, sc['N'])


def _bounds(sc, grid, zl=None):
    """세로축마다 경계선(위 · 아래). 종합 · y_value · bad 비율은 점을 자기 기준 대비 위치로 그리므로 Order 1개 기준 띠:
    종합은 판정 기준(기본 기준 z × 퍼짐 배수), y_value · bad 비율(yz · bz)은 그 신호 하나로만 판정할 때의 기준(기본 기준 z × 그 신호의 퍼짐 배수).
    초과 bad는 값을 그대로 그리므로 Order 수 기준 z zl(없으면 Order 1개)로 잡은 bad 비율 기준선을 장 수로 바꾼 것"""
    zk1 = sc['zk'][1] if len(sc['zk']) > 1 else math.nan
    zl = zk1 if zl is None else zl
    sh = shrink(grid, sc['N'])
    hj = _half(sc, zk1 * sc['s'], grid)
    out = {'n': nums(grid, 3), 'judg': {'lo': nums(sc['mu'] - hj), 'hi': nums(sc['mu'] + hj), 'mid': num(sc['mu'])}}
    sp = sc['sp']
    if sp is not None:
        hy = zk1 * sp[0] * sc['vsd'] / np.sqrt(grid) * sh
        out['yz'] = {'lo': nums(sc['vmu'] - hy), 'hi': nums(sc['vmu'] + hy), 'mid': num(sc['vmu'])}
    if sc['p0'] is not None:
        sb = sp[1] if sp is not None else sc['s']           # 예전 기록(신호별 퍼짐 배수 없음)은 결합 z의 퍼짐 배수
        band = lambda z_: (np.clip(sc['p0'] - z_ * sc['bsd'] / np.sqrt(grid) * sh, 0, 1), np.clip(sc['p0'] + z_ * sc['bsd'] / np.sqrt(grid) * sh, 0, 1))
        if sp is not None:
            lo, hi = band(zk1 * sb)
            out['bz'] = {'lo': nums(lo), 'hi': nums(hi), 'mid': num(sc['p0'])}
        lo, hi = band(zl * sb)
        out['ex'] = {'lo': nums(grid * (lo - sc['p0']), 3), 'hi': nums(grid * (hi - sc['p0']), 3), 'mid': 0.0}   # 초과 bad = 장 수
    else:                                                   # good_bad가 없으면 순위 기준 N × ΔValue (판정용 Value 눈금)
        h = grid * _half(sc, zl * sc['s'], grid)
        out['ex'] = {'lo': nums(-h, 3), 'hi': nums(h, 3), 'mid': 0.0}
    return out


def _sig_heights(sc, zy, zb, zkk, n):
    """신호 하나로만 판정할 때의 높이(원래 단위)와 그 신호만 볼 때 기준선 밖인지(1 나쁜 쪽 · −1 좋은 쪽 · 0 안).
    자기 기준(Order 수별 기본 기준 z zkk × 그 신호의 퍼짐 배수) 대비 위치를 Order 1개 기준 띠에 맞추므로 띠 밖 ⇔ 그 신호 하나로도 판정 밖.
    Order 1개 경로는 y_value 평균 그대로다(순위 보정 · part 맞춤을 했으면 그만큼 다름). bad 비율 높이는 0~1로 자른다"""
    zy, zkk, n = (np.asarray(x, dtype=float) for x in (zy, zkk, n))
    f = sc['zk'][1] / zkk * shrink(n, sc['N']) / np.sqrt(n)
    side = lambda z, s_: np.where(z > zkk * s_, 1, np.where(z < -zkk * s_, -1, 0))
    out = {'yz': sc['vmu'] + sc['sign'] * zy * f * sc['vsd'], 'oy': side(zy, sc['sp'][0])}
    if sc['p0'] is not None and zb is not None:
        zb = np.asarray(zb, dtype=float)
        out.update(bz=np.clip(sc['p0'] + zb * f * sc['bsd'], 0, 1), ob=side(zb, sc['sp'][1]))
    return out


def _sig_z(d, r, m):
    """웨이퍼 묶음 m의 신호별 z (Value, bad): 조합의 z_Value · z_bad와 같은 계산 (bad는 이항 꼬리 보정까지). good_bad가 없으면 bad는 None"""
    if m.sum() < 2:
        return math.nan, math.nan
    zy = sig_mean_z(d, r, 'y', m)
    if 'b' not in r['signals']:
        return zy, None
    bad01 = np.nan_to_num(d['bad'])
    e_ = d['bad_exp'][m].mean() if d.get('bad_exp') is not None else bad01.mean()
    return zy, sig_mean_z(d, r, 'b', m) * float(binom_fix([m.sum()], [bad01[m].sum()], e_)[0])


def _excess(d, r, m):
    """웨이퍼 묶음의 순위 기준값: 초과 bad = bad 장수 − 기대 bad 장수 (good_bad가 없으면 웨이퍼 수 × (판정용 Value 평균 − 전체 평균))"""
    if not m.any():
        return None
    if d['B'] is not None:
        bad01 = np.nan_to_num(d['bad'])
        exp = d['bad_exp'] if d.get('bad_exp') is not None else np.full(d['N'], bad01.mean())
        return float(bad01[m].sum() - exp[m].sum())
    return float(m.sum() * (np.asarray(d['Y'], dtype=float)[m].mean() - r['mu']))


def _step_table(result):
    """경로 비교(STEP 전체)용: 계산한 모든 조합을 STEP 순서로 모은 표 (웨이퍼 수 · Certainty · 초과 bad · y_value 평균 · bad 비율 ·
    신호별 z · Order 수 · 판정 · 경로).
    실행 기록(state)에는 실행할 때 만든 것을 저장해 두고, 전체 결과에서는 처음 쓸 때 만든다. 예전 코드로 저장한 기록에는 없다(None)"""
    t = getattr(result, 'step_table', None)
    if t is not None or not hasattr(result, 'ranked'):
        return t
    d, r = result.data, result.res
    combos = sorted(r['combos'], key=lambda c: c['step'])
    k = np.array([c['k'] for c in combos], dtype=np.int64)
    t = {'start': np.searchsorted(np.array([c['step'] for c in combos], dtype=np.int64), np.arange(len(d['steps']) + 1)),  # STEP s = start[s]:start[s+1]
         'n': np.array([c['n'] for c in combos], dtype=np.int32),
         'cert': np.array([c['z'] / c['thr'] for c in combos], dtype=np.float32),
         'ex': np.array([metric(c, r) for c in combos], dtype=np.float32),
         'vmean': np.array([c['vmean'] for c in combos], dtype=np.float32),
         'bad': np.array([c['bad_rate'] for c in combos], dtype=np.float32) if d['B'] is not None else None,
         'zy': np.array([c['z_y'] for c in combos], dtype=np.float32),
         'zb': np.array([c['z_b'] for c in combos], dtype=np.float32) if d['B'] is not None else None,
         'k': k.astype(np.int8),
         'flag': np.array([(1 if c['status'] == 'bad' else 3 if c['status'] == 'inherited' else 4) if c['over']
                           else 2 if c['z'] < -c['thr'] else 0 for c in combos], dtype=np.int8),   # 1 원인 후보 · 3 상속 · 4 하위 기인 · 2 좋은 쪽 · 0 기준선 안
         'ioff': np.r_[0, np.cumsum(2 * k)],                                               # 경로 = items[ioff[i]:ioff[i+1]] (Order, Unit 번갈아)
         'items': np.array([v for c in combos for it in c['items'] for v in it], dtype=np.int16)}
    result.step_table = t
    return t


def _step_match(t, step, items):
    """STEP 표에서 경로(items)와 같은 조합의 번호 (없으면 None: 계산하지 않은 경로 · 같은 Order로 합쳐진 Order를 쓴 경로)"""
    want = np.array([v for it in sorted(items) for v in it], dtype=np.int16)
    ioff, flat = t['ioff'], t['items']
    for i in range(int(t['start'][step]), int(t['start'][step + 1])):
        if ioff[i + 1] - ioff[i] == len(want) and np.array_equal(flat[ioff[i]:ioff[i + 1]], want):
            return i
    return None


def step_payload(result, step):
    """경로 비교(STEP 전체): 그 STEP에서 계산한 모든 조합. 종합은 큰 funnel과 같은 눈금(Certainty × Order 1개 기준 띠)"""
    t = _step_table(result)
    if t is None:
        return None
    step = int(step)
    if not 0 <= step < len(result.data['steps']):
        raise IndexError('STEP 번호를 확인하세요')
    idx = np.arange(int(t['start'][step]), int(t['start'][step + 1]))
    total = len(idx)
    if total > STEP_MAX:                                   # 기준선 밖 · 좋은 쪽은 모두, 기준선 안은 고르게 골라서
        out_ = idx[t['flag'][idx] != 0]
        in_ = idx[t['flag'][idx] == 0]
        take = max(0, STEP_MAX - len(out_))
        if take < len(in_):
            in_ = np.random.default_rng(0).choice(in_, take, replace=False)
        idx = np.sort(np.r_[out_, in_])
    sc = _scales(result)
    zk, s = result.zk, result.spread
    n = t['n'][idx].astype(float)
    nmax = float(n.max()) if len(n) else 10.0
    out = {'step': step, 'total': total, 'shown': len(idx), 'n': [int(v) for v in t['n'][idx]],
           'judg': nums(sc['mu'] + t['cert'][idx].astype(float) * _half(sc, zk[1] * s, n), 5),
           'mean': nums(t['vmean'][idx], 5), 'bad': nums(t['bad'][idx], 5) if t['bad'] is not None else None,
           'ex': nums(t['ex'][idx], 2), 'cert': nums(t['cert'][idx], 3), 'flag': [int(v) for v in t['flag'][idx]],
           'items': [t['items'][t['ioff'][i]:t['ioff'][i + 1]].tolist() for i in idx],
           'bounds': _bounds(sc, _grid(max(2, result.cfg.min_n), nmax * 1.15))}
    if sc['sp'] is not None and t.get('zy') is not None:   # 신호 하나로만 판정할 때의 높이 (예전 코드로 저장한 기록에는 없음)
        h = _sig_heights(sc, t['zy'][idx], t['zb'][idx] if t['zb'] is not None else None, np.asarray(zk)[t['k'][idx]], n)
        out.update(yz=nums(h['yz'], 5), oy=h['oy'].tolist())
        if 'bz' in h:
            out.update(bz=nums(h['bz'], 5), ob=h['ob'].tolist())
    return out


def _bad_of(d, m):
    return num(np.nan_to_num(d['bad'])[m].mean(), 4) if d['B'] is not None and m.any() else None


def target_brief(result, c, ref=None):
    """대상 하나의 요약. ref(대표 대상)를 주면 웨이퍼 겹침과 한쪽에만 있는 웨이퍼의 bad 비율도 (같은 웨이퍼로 묶인 대상 비교용)"""
    d, r = result.data, result.res
    st = d['steps'][c['step']]
    m = members_of(d, c)
    out = {'key': c['key'], 'step': c['step'], 'step_name': st['name'], 'desc': st['proc'], 'k': c['k'],
           'items': [[int(q), int(u)] for q, u in c['items']], 'path': path_label(st, c['items']),
           'parts': [path_label(st, [it]) for it in c['items']], 'n': c['n'], 'bad': _bad_of(d, m),
           'exp_bad': num(expected_bad(c, r), 4) if d['B'] is not None else None,
           'excess': num(metric(c, r), 2), 'certainty': num(c['z'] / c['thr'], 3)}
    if ref is not None:
        mr = members_of(d, ref)
        mine, theirs = m & ~mr, mr & ~m
        out.update(overlap=num((m & mr).sum() / max(1, (m | mr).sum()), 3), only_n=int(mine.sum()), only_bad=_bad_of(d, mine),
                   ref_only_n=int(theirs.sum()), ref_only_bad=_bad_of(d, theirs))
    return out


def target_row(result, rank, c):
    """순위표 한 줄"""
    d, r, ranked = result.data, result.res, result.ranked
    st = d['steps'][c['step']]
    m = members_of(d, c)
    has_b = d['B'] is not None
    notes = []
    alts = same_order_paths(d, r, c)                    # 웨이퍼가 똑같이 나뉘는 다른 Order로 쓴 경로 (묶인 대상은 순위표 아래 줄로 따로 나온다)
    if alts:
        notes.append('같은 웨이퍼 · 다른 Order: ' + ', '.join(alts[:3]) + (f' 외 {len(alts) - 3}개' if len(alts) > 3 else ''))
    if (a := ranked['cross'].get(c['key'])) is not None:
        notes.append(f"다른 STEP 탓 의심: {d['steps'][a['step']]['name']} {path_label(d['steps'][a['step']], a['items'])}")
    merged = sorted((target_brief(result, r['by_key'][k], c) for k, v in ranked['same_as'].items() if v == c['key']),
                    key=lambda b: -(b['excess'] or 0))           # 웨이퍼가 같아 이 줄에 묶인 대상
    cross = ranked['cross'].get(c['key'])
    return {'rank': rank, 'key': c['key'], 'step': c['step'], 'step_name': st['name'], 'desc': st['proc'], 'k': c['k'],
            'items': [[int(q), int(u)] for q, u in c['items']], 'path': path_label(st, c['items']),
            'parts': [path_label(st, [it]) for it in c['items']], 'n': c['n'],
            'bad': num(np.nanmean(d['bad'][m]), 4) if has_b else None, 'exp_bad': num(expected_bad(c, r), 4) if has_b else None,
            'excess': num(metric(c, r), 2), 'vmean': num(np.nanmean(d['value'][m])), 'certainty': num(c['z'] / c['thr'], 3),
            'note': ' · '.join(notes), 'merged': merged, 'cross': target_brief(result, cross, c) if cross is not None else None}


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
    if sc['sp'] is not None:                                # y_value · bad 비율: 그 신호 하나로만 판정할 때의 높이 (띠 밖 ⇔ 그 신호로도 판정 밖)
        sig = _sig_heights(sc, [c['z_y'] for c in combos], [c['z_b'] for c in combos] if yb is not None else None,
                           np.asarray(zk, dtype=float)[[c['k'] for c in combos]], n)
    else:
        sig = {'yz': np.full(len(combos), math.nan), 'oy': np.zeros(len(combos), dtype=int)}
    yz, oy = sig['yz'], sig['oy']
    bz, ob = sig.get('bz'), sig.get('ob', np.zeros(len(combos), dtype=int))
    over = np.array([c['over'] for c in combos], dtype=bool)
    good = z < -thr                                         # 경계 밖 · 좋은 쪽 (기준선보다 뚜렷하게 낮음)
    gray = np.flatnonzero(~over & ~good)
    if len(gray) > GRAY_MAX:
        gray = np.sort(np.random.default_rng(0).choice(gray, GRAY_MAX, replace=False))
    pick = lambda idx: {'n': [int(v) for v in n[idx]], 'judg': nums(yj[idx], 5), 'yz': nums(yz[idx], 5),
                        'bz': nums(bz[idx], 5) if bz is not None else None}
    marks = []                                              # 경계 밖 점 (bad · good path) · 신호 하나만 보면 밖인 점 (판정은 안 됨)
    steps = d['steps']
    same_as = result.ranked['same_as']

    def cause_of(c):
        """따라 올라온 점이 기대는 원인 후보: 하위 기인은 그 점을 설명하는 더 좁은 조합(Order를 하나 더 고른 경로),
        상속은 차이를 넘지 못한 부모(Order 하나를 뺀 경로). 그 경로도 따라 올라온 점이면 원인 후보에 닿을 때까지 따라간다"""
        label, cur, seen = None, c, set()
        while cur['status'] in ('explained', 'inherited') and cur['key'] not in seen:
            seen.add(cur['key'])
            st_ = steps[cur['step']]
            if cur['status'] == 'explained' and cur.get('explained_by') is not None:
                nxt = combos[cur['explained_by']]
            elif cur['status'] == 'inherited' and cur.get('parents'):
                p_ = min(cur['parents'], key=lambda x: x['t'])
                nxt = r['by_key'].get(p_['key'])
                if nxt is None:                             # 부모를 따로 계산하지 않은 경우: 부모 경로 이름까지만
                    return f"{st_['name']} {path_label(st_, p_['items'])}"
            else:
                break
            label = f"{steps[nxt['step']]['name']} {path_label(steps[nxt['step']], nxt['items'])}"
            cur = nxt
        return label

    for i in np.flatnonzero(over | good | (oy != 0) | (ob != 0)):
        c = combos[i]
        st = steps[c['step']]
        side = 'bad' if over[i] else 'good' if good[i] else 'sig'
        marks.append({'side': side, 'n': c['n'], 'judg': num(yj[i], 5), 'yz': num(yz[i], 5), 'bz': num(bz[i], 5) if bz is not None else None,
                      'oy': int(oy[i]), 'ob': int(ob[i]), 'mean': num(ym[i], 5), 'bad': num(yb[i], 5) if yb is not None else None,
                      'rank': rank_of.get(c['key']), 'target': tgt.get(c['key']),
                      'label': f"{st['name']} {path_label(st, c['items'])}", 'k': c['k'], 'certainty': num(c['z'] / c['thr'], 3),
                      'key': c['key'], 'merged': rank_of.get(same_as[c['key']]) if c['key'] in same_as else None,
                      'status': c['status'] if over[i] else side, 'cause': cause_of(c) if over[i] else None})   # bad 원인 후보 · inherited 상속 · explained 하위 기인
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
                       'bounds': _bounds(sc, _grid(lo_n, hi_n))}}


def detail_state(result):
    """상세 계산에 필요한 것만 추린 결과 (실행 기록으로 저장해 두었다가 다시 불러온다). detail_payload에 그대로 넣는다"""
    d, r = result.data, result.res
    keep = ('N', 'Y', 'B', 'bad', 'value', 'steps', 'assign', 'tk', 't_base', 'part_idx', 'part_sig', 'bad_exp', 'lots', 'wafer_ids')
    return SimpleNamespace(data={k: d[k] for k in keep if k in d}, res={k: r[k] for k in ('mu', 'sd', 'N', 'r', 'p0', 'signals')},
                           zk=list(result.zk), spread=result.spread, cfg=result.cfg, step_table=_step_table(result),
                           sig_spread=_sig_spread(result))


def _path_masks(d, step, items):
    """경로의 웨이퍼(member)와 같은 Order를 모두 지났지만 다른 Unit으로 지난 웨이퍼(rest)"""
    A = d['assign'][int(step)]
    items = sorted((int(q), int(u)) for q, u in items)
    if not items:
        raise ValueError('Order를 하나 이상 고르세요')
    qs = [q for q, _ in items]
    through = np.all(A[qs] != MISSING, axis=0)
    member = through & np.all([A[q] == u for q, u in items], axis=0)
    return member, through & ~member


def compare_payload(result, targets):
    """비교 띠: 고른 대상마다 이 경로 · 같은 Order를 다른 Unit으로 지난 웨이퍼의 수와 bad 비율(bad 웨이퍼 수 ÷ 웨이퍼 수,
    good_bad가 없으면 y_value 평균), 그리고 대상끼리 웨이퍼 겹침(둘을 합친 웨이퍼 중 양쪽 모두에 있는 비율)"""
    d = result.data
    has_b = d['B'] is not None
    bad01 = np.nan_to_num(d['bad']) if has_b else None
    value = np.asarray(d['value'], dtype=float)
    rows, mems = [], []
    for t in targets:
        member, rest = _path_masks(d, t['step'], t['items'])
        mems.append(member)
        rows.append({'n': int(member.sum()), 'rest_n': int(rest.sum()),
                     'bad': num(bad01[member].mean(), 4) if has_b and member.any() else None,
                     'rest_bad': num(bad01[rest].mean(), 4) if has_b and rest.any() else None,
                     'vmean': num(value[member].mean()) if member.any() else None,
                     'rest_vmean': num(value[rest].mean()) if rest.any() else None})
    k = len(mems)
    overlap = [[None] * k for _ in range(k)]
    for i in range(k):
        for j in range(i + 1, k):
            u = int((mems[i] | mems[j]).sum())
            overlap[i][j] = overlap[j][i] = num((mems[i] & mems[j]).sum() / u, 3) if u else 0.0
    return {'targets': rows, 'overlap': overlap, 'has_bad': has_b}


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
    member, rest = _path_masks(d, step, items)
    through = member | rest                                 # 고른 Order를 모두 지난 웨이퍼
    k = len(items)
    thr = zk[min(k, len(zk) - 1)] * s if len(zk) > 1 else math.nan
    if k >= len(zk) and share_group(k) != share_group(len(zk) - 1):
        thr = math.nan                                      # 계산한 Order 수보다 많이 고르면 그 묶음의 기준이 없을 수 있다
    z = mean_z(d, r, member) if member.sum() >= 2 else math.nan
    sc = _scales(result)
    zkk = zk[min(k, len(zk) - 1)] if math.isfinite(thr) else math.nan

    def sig_of(m, n_):
        """웨이퍼 묶음의 y_value · bad 비율 보정 높이와 신호 하나만 볼 때 기준선 밖인지 (기준이 없거나 예전 기록이면 없음)"""
        if sc['sp'] is None or not math.isfinite(zkk) or n_ < 2:
            return {}
        zy_, zb_ = _sig_z(d, r, m)
        h = _sig_heights(sc, [zy_], [zb_] if zb_ is not None else None, [zkk], [n_])
        out = {'yz': num(h['yz'][0], 5), 'oy': int(h['oy'][0])}
        if 'bz' in h:
            out.update(bz=num(h['bz'][0], 5), ob=int(h['ob'][0]))
        return out
    sel = {'items': [[q, u] for q, u in items], 'label': path_label(st, items), 'n': int(member.sum()),
           'bad': num(bad01[member].mean(), 4) if has_b and member.any() else None,
           'rest_n': int(rest.sum()), 'rest_bad': num(bad01[rest].mean(), 4) if has_b and rest.any() else None,
           'vmean': num(value[member].mean()) if member.any() else None, 'certainty': num(z / thr, 3) if math.isfinite(thr) else None,
           'k': k, 'group': order_text(k), 'ex': num(_excess(d, r, member), 2) if member.any() else None,
           'judg': num(sc['mu'] + z / thr * float(_half(sc, zk[1] * s, max(1, int(member.sum())))), 5) if math.isfinite(thr) and member.any() else None,
           'step_rank': None, **sig_of(member, int(member.sum()))}
    t = _step_table(result)
    if t is not None:                                      # 이 STEP의 모든 조합 중 몇 번째인가 (Certainty · 초과 bad)
        a, b_ = int(t['start'][step]), int(t['start'][step + 1])
        j = _step_match(t, step, items)
        c_, e_ = (t['cert'][j], t['ex'][j]) if j is not None else (sel['certainty'], sel['ex'])
        sel['step_rank'] = {'total': b_ - a, 'cert': 1 + int((t['cert'][a:b_] > c_).sum()) if c_ is not None else None,
                            'ex': 1 + int((t['ex'][a:b_] > e_).sum()) if e_ is not None else None}
    # 고른 Order들의 Unit 조합(경로)마다: 웨이퍼 산점도 범례 · 같은 Order 다른 경로 비교
    U = np.stack([A[q][through] for q in qs], axis=1).astype(np.int64)
    combos_, inv, cnt = np.unique(U, axis=0, return_inverse=True, return_counts=True)
    inv = inv.ravel()
    sel_row = np.array([u for _, u in items])
    sel_g = int(np.flatnonzero((combos_ == sel_row).all(axis=1))[0]) if member.any() else -1
    wid = np.flatnonzero(through)
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
        peers.append({'g': int(g), 'n': int(cnt[g]), 'mean': groups[g]['vmean'], 'bad': groups[g]['bad'], 'ex': num(_excess(d, r, m), 2),
                      'judg': num(sc['mu'] + zg / thr * float(_half(sc, zk[1] * s, cnt[g]))) if math.isfinite(thr) else None,
                      'certainty': num(zg / thr, 3) if math.isfinite(thr) else None, **sig_of(m, int(cnt[g]))})
    q_last = max(qs)                                        # 시간축: 고른 Order 중 마지막 Order의 track-in 시각
    tk = d['tk'][step][q_last][through].astype(np.int64)
    base_ms = int(d['t_base'].astype('datetime64[ms]').astype(np.int64))
    has_t = tk >= 0
    wafers = {'t': [base_ms + 1000 * int(t) if ok_ else None for t, ok_ in zip(tk.tolist(), has_t.tolist())],
              'v': nums(value[through], 6), 'b': [int(x) for x in bad01[through]] if has_b else None, 'g': inv.tolist()}
    if d.get('wafer_ids') is not None:                      # 웨이퍼 이름 (예전에 저장한 실행에는 없음): lot은 목록 + 번호로 줄여 보낸다
        lot_u, lot_i = np.unique(np.asarray(d['lots'])[through].astype(str), return_inverse=True)
        wafers.update(lots=lot_u.tolist(), li=lot_i.ravel().tolist(), wid=[str(w) for w in np.asarray(d['wafer_ids'])[through]])
    pn = [p['n'] for p in peers] or [result.cfg.min_n]
    peer_bounds = _bounds(sc, _grid(max(2, result.cfg.min_n), max(pn) * 1.15), zkk) if math.isfinite(thr) else None   # 종합 · y_value · bad 비율은 큰 funnel과 같은 눈금
    return {'step': step, 'step_name': st['name'], 'desc': st['proc'], 'orders': orders, 'selection': sel, 'groups': groups,
            'sel_group': sel_g, 'peers': peers, 'peer_bounds': peer_bounds, 'wafers': wafers, 'time_order': st['seqs'][q_last]['name'],
            'missing_time': int((~has_t).sum()), 'has_bad': has_b}
