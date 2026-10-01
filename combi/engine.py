"""조합 판정 엔진: 조합 만들기(analyze) · 기준선(thresholds) · 판정(classify)과 웨이퍼 묶음의 z"""
import math
from collections import defaultdict

import numpy as np

from .stats import FWER_ALPHA, Z95, binom_fix, compositions, norm_inv, part_shrink, shrink, spread_of

MISSING = 0xFFFF                                  # 웨이퍼가 그 Order를 지나지 않음 (assign 배열의 빈 값)


def combo_key(s, items):
    return f'{s}|' + '|'.join(f'{q}:{u}' for q, u in items)


def analyze(data, min_n=20, max_depth=3, full_depth=2, spread_adjust=True, progress=None):
    """조합 생성과 조합별 지표. max_depth가 None이면 Order 수 제한 없이, 새 조합이 더 나오지 않을 때까지 늘린다.
    조합은 '중복 아닌' 것만 만든다: Order를 하나 더해도 웨이퍼가 그대로인 조합(부모와 웨이퍼가 같은 조합)은 부모와 같은 검사라
    빼고, 그 아래 조합도 모두 중복이라 찾지 않는다. STEP 안에서 웨이퍼가 나뉘는 모양이 완전히 같은 Order는 하나로 합친다(same_orders).
    Order 2개 이상 조합은 웨이퍼가 너무 적어 가장 나쁜 경우에도 Order 1개 기준선을 넘을 수 없는 칸(웨이퍼 sigma장 미만)을 만들지도 세지도 않는다.
    웨이퍼(root_lot_id + wafer_id) 한 장을 하나의 표본으로 보고, 신호(Value, bad)마다 조합을 나머지 웨이퍼와 비교한
    z = (조합 평균 − 전체 평균) ÷ (표준편차 ÷ √웨이퍼 수) ÷ √(1 − 웨이퍼 수 ÷ 전체 웨이퍼 수)를 구해 결합 z = (z_Value + z_bad) ÷ √(2 + 2r)로 판정한다.
    bad z는 정확한 이항 꼬리확률로 맞추고, r은 두 z가 우연히 같이 움직이는 정도(Order 1개 조합에서 잰 상관, 0~0.95)라
    같은 정보를 두 번 세지 않게 한다. good_bad가 없으면 z_Value만 쓴다.
    part별로 맞춘 신호(data['part_sig'])는 조합을 자기 part 평균과 비교한다: Value는 √(1 − …)를 part별로(part_shrink),
    bad는 (bad 장수 − 기대 bad 장수) ÷ √(Σ part별 웨이퍼 수 × p(1−p) × (1 − 웨이퍼 수 ÷ part 웨이퍼 수))"""
    N, steps, assign = data['N'], data['steps'], data['assign']
    sig = {'y': data['Y']} | ({'b': data['B']} if data.get('B') is not None else {})
    base = {k_: (float(v.mean()), float(v.std(ddof=1))) for k_, v in sig.items()}
    Y = sig['y']
    Y2 = Y * Y
    V = np.asarray(data['value'], dtype=float) if data.get('value') is not None else None   # 원래 y_value (조합마다 평균을 웹 funnel에 씀)
    mu, sd = base['y']
    bad01 = np.nan_to_num(data['bad']) if 'b' in sig else None
    p0 = float(bad01.mean()) if 'b' in sig else 0.0
    bad_exp = (data['bad_exp'] if data.get('bad_exp') is not None else np.full(N, p0)) if 'b' in sig else None   # 웨이퍼마다 기대 bad 비율
    part_sig = data.get('part_sig', ())               # part별로 맞춘 신호: 조합을 자기 part 평균과 비교 → √(1 − …)도 part별
    pidx = data.get('part_idx') if part_sig else None
    n_part = np.bincount(pidx).astype(float) if pidx is not None else None
    v_part = (np.bincount(pidx, weights=bad_exp * (1 - bad_exp)) / n_part) if pidx is not None and 'b' in part_sig else None

    def stats(w, n):
        """칸마다 신호별 합. w = 칸 순서로 이어 붙인 웨이퍼 번호, n = 칸마다 웨이퍼 수"""
        start = np.r_[0, np.cumsum(n)[:-1]]
        add = lambda v: np.add.reduceat(v[w], start)
        out = {'ss': add(Y2)} | {f'sum_{k_}': add(v) for k_, v in sig.items()}
        if V is not None:
            out['sum_v'] = add(V)
        if 'b' in sig:
            out['x_bad'] = add(bad01)                 # 원래 bad 장수 (0/1): 이항분포 꼬리 보정 · 초과 bad용
            out['x_exp'] = add(bad_exp)               # 기대 bad 장수: 웨이퍼마다 기대 bad 비율(part별로 맞췄으면 자기 part의 비율)의 합
        if pidx is not None:                          # Σ_part (칸 안 그 part 웨이퍼 수)² ÷ part 웨이퍼 수
            P_ = len(n_part)
            cp = np.bincount(np.repeat(np.arange(len(n)), n) * P_ + pidx[w], minlength=len(n) * P_).reshape(len(n), P_).astype(float)
            out['pn2'] = (cp * cp / n_part).sum(axis=1)
            if v_part is not None:                    # bad 장수의 분산: Σ_part 웨이퍼 수 × p(1−p) × (1 − 웨이퍼 수 ÷ part 웨이퍼 수)
                out['var_b'] = (cp * v_part * (1 - cp / n_part)).sum(axis=1)
        return out

    def sig_z(k_, nn, col):
        """조합들의 신호 k_ z: (조합 평균 − 전체 평균) ÷ (표준편차 ÷ √웨이퍼 수) ÷ √(1 − 웨이퍼 수 ÷ 전체 웨이퍼 수).
        part별로 맞춘 신호는 마지막 항을 part별로 계산한다(part_shrink)"""
        if k_ == 'b' and 'b' in part_sig:             # (bad 장수 − 기대 bad 장수) ÷ √(part별 분산의 합)
            return (col('x_bad') - col('x_exp')) / np.sqrt(np.maximum(col('var_b'), 1e-12))
        m_, s_ = base[k_]
        sh = part_shrink(nn, col('pn2'), N) if k_ in part_sig else shrink(nn, N)
        return (col(f'sum_{k_}') / nn - m_) / (s_ / np.sqrt(nn)) / sh

    def parent_keys(dims, keys, i):
        """칸 번호에서 i번째 오더 자리를 뺀 부모 칸 번호"""
        low = math.prod(dims[i + 1:])
        return (keys // (low * dims[i])) * low + keys % low

    gid = pidx if pidx is not None else np.zeros(N, dtype=np.int64)   # part 묶음 (part별로 맞추지 않았으면 하나)
    g_n = np.bincount(gid).astype(float)
    g_top = [np.r_[0.0, np.cumsum(np.sort(Y[gid == g])[::-1])] for g in range(len(g_n))]   # part마다 Value가 큰 순 누적합
    top_all = np.r_[0.0, np.cumsum(np.sort(Y)[::-1])]
    g_bad = np.bincount(gid, weights=bad01, minlength=len(g_n)) if 'b' in sig else None
    g_exp = np.bincount(gid, weights=bad_exp, minlength=len(g_n)) / g_n if 'b' in sig else None

    def max_z(n, r_):
        """웨이퍼 n장 조합이 낼 수 있는 가장 큰 결합 z: Value가 가장 큰 웨이퍼 n장이 모두 bad인 경우로 위에서 누른다.
        part별로 맞춘 신호는 조합의 part 구성에 따라 달라서, 웨이퍼 n장이 part에 나뉘는 모든 방법을 계산해 가장 큰 값을 쓴다"""
        C = compositions(n, g_n.astype(int).tolist())
        if 'y' in part_sig:
            S, sh = sum(g_top[g][C[:, g]] for g in range(len(g_n))), part_shrink(n, (C * C / g_n).sum(axis=1), N)
        else:
            S, sh = top_all[n], shrink(n, N)
        zy = (S / n - mu) / (sd / math.sqrt(n)) / sh
        if 'b' not in sig:
            return float(np.max(zy))
        if 'b' in part_sig:
            x, e = np.minimum(C, g_bad).sum(axis=1), C @ g_exp
            var = (C * v_part * (1 - C / g_n)).sum(axis=1)
            zb = (x - e) / np.sqrt(np.maximum(var, 1e-12)) * binom_fix(np.full(len(C), float(n)), x, e / n)
        else:
            x, (m_, s_) = min(n, g_bad.sum()), base['b']
            zb = (x / n - m_) / (s_ / math.sqrt(n)) / shrink(n, N) * binom_fix([n], [x], [p0])[0]
        return float(np.max((zy + zb) / math.sqrt(2 + 2 * r_)))

    def crossable_min(thr, r_):
        """기준 thr를 넘을 수 있는 가장 작은 웨이퍼 수와, 그보다 작은 칸이 낼 수 있는 가장 큰 z. min_n부터 한 장씩 확인하고,
        part가 많아 확인할 구성이 너무 많아지면 거기서 멈춘다(확인한 크기보다 작은 칸만 뺀다)"""
        n, top = min_n, -math.inf
        while n < N and math.comb(n + len(g_n) - 1, len(g_n) - 1) <= 200_000:
            z_ = max_z(n, r_)
            if z_ >= thr:
                break
            top, n = max(top, z_), n + 1
        return n, top

    def lookup(sorted_keys, keys):
        """정렬된 칸 번호 sorted_keys 안에서 keys의 위치와, 그 칸이 있는지"""
        pos = np.minimum(np.searchsorted(sorted_keys, keys), len(sorted_keys) - 1)
        return pos, sorted_keys[pos] == keys

    def join(tuples):
        """Order 묶음(k−1개) 목록에서, Order 하나를 뺀 묶음이 모두 목록에 있는 k개 묶음 (정렬된 순서)"""
        have, by_pre = set(tuples), defaultdict(list)
        for t in tuples:
            by_pre[t[:-1]].append(t[-1])
        out = []
        for pre, last in by_pre.items():
            for i, a in enumerate(last):
                for b in last[i + 1:]:
                    qs = pre + (a, b)
                    if all(qs[:j] + qs[j + 1:] in have for j in range(len(pre))):
                        out.append(qs)
        return out

    # 같은 Order: STEP 안에서 웨이퍼가 나뉘는 모양(빠진 웨이퍼 포함)이 완전히 같은 Order는 어떤 조합을 만들어도 웨이퍼가 같다.
    # 앞의 Order 하나로만 조합을 만들고, 나머지는 same_orders에 (Order, 유닛 대응)으로 적어 표에 함께 보여 준다
    multi, same_orders = [], {}
    for s, st in enumerate(steps):
        reps, seen = [], {}
        for q, sq in enumerate(st['seqs']):
            if len(sq['units']) < 2:
                continue
            a = assign[s][q]
            present = a != MISSING
            u_, first, inv_ = np.unique(a[present], return_index=True, return_inverse=True)
            order_ = np.argsort(first)               # 유닛을 처음 나온 순서로 번호를 다시 매긴 모양
            label = np.empty(len(u_), dtype=np.int32)
            label[order_] = np.arange(len(u_))
            shape = np.full(N, -1, dtype=np.int32)
            shape[present] = label[inv_]
            fp = shape.tobytes()
            if fp in seen:
                q0, units0 = seen[fp]
                same_orders.setdefault((s, q0), []).append((q, dict(zip(units0.tolist(), u_[order_].tolist()))))
            else:
                seen[fp] = (q, u_[order_])
                reps.append(q)
        multi.append(reps)

    combos, r = [], 0.0

    all_w, one = np.arange(N), (np.zeros(1, dtype=np.int64), np.array([N]))   # Order 0개 = 모든 웨이퍼가 한 칸

    def level(k, alive, store, lo):
        """깊이 k(Order k개)의 칸. 한 단계 작은 칸(store, k = 1이면 모든 웨이퍼)의 웨이퍼를 Order 하나로 더 나눠 만든다.
        중복 아니고 웨이퍼 lo장 이상인 칸은 cur에 (칸 번호, 웨이퍼 수, z 1.96을 넘었는지, 칸 순서로 이은 웨이퍼)로 남기고
        (다음 깊이 · 가능한 조합 수용), 그중 관문을 지나 계산할 칸은 cand에 합계와 함께 담는다"""
        gated = k > full_depth
        cand, cur = [], {}
        for s, tuples in alive.items():
            A, seqs = assign[s], steps[s]['seqs']
            last, cell_p = None, None
            for qs in (tuples if k == 1 else join(tuples)):
                P, b = qs[:-1], qs[-1]                  # 앞 묶음(마지막 Order를 뺀 묶음)의 칸을 Order b로 나눈다
                keys_p, n_p, hot_p, W = (*one, None, all_w) if k == 1 else store[(s, P)]
                if P != last:
                    last, cell_p = P, np.repeat(np.arange(len(n_p)), n_p)
                d = len(seqs[b]['units'])
                ab = A[b][W]
                ok = ab != MISSING
                key = cell_p[ok] * d + ab[ok]           # 앞 묶음 칸 순번 × 유닛 수 + 유닛
                cnt = np.bincount(key, minlength=len(n_p) * d)
                u = np.flatnonzero(cnt >= lo)
                if not len(u):
                    continue
                n, dims = cnt[u], [len(seqs[q]['units']) for q in qs]
                full = keys_p[u // d] * d + u % d       # 칸 번호 (Order마다 유닛 번호를 이은 수, 오름차순)
                hot = None
                if k > 1:                               # 중복 빼기: 부모 칸(Order 하나를 뺀 칸)이 모두 있고 웨이퍼가 부모보다 적은 칸만
                    keep = n_p[u // d] > n
                    hot = hot_p[u // d].copy() if gated else None
                    for i in range(k - 1):
                        pk, pn, ph, _ = store[(s, qs[:i] + qs[i + 1:])]
                        pos, hit = lookup(pk, parent_keys(dims, full, i))
                        keep &= hit & (pn[pos] > n)
                        if gated:                       # 관문: 부모 칸 중 하나라도 z 1.96을 넘었나
                            hot |= hit & ph[pos]
                    if not keep.all():
                        u, n, full = u[keep], n[keep], full[keep]
                        hot = hot[keep] if gated else None
                        if not len(u):
                            continue
                sel = np.zeros(len(cnt), dtype=bool)
                sel[u] = True
                in_cell = sel[key]
                w = W[ok][in_cell][np.argsort(key[in_cell], kind='stable')]   # 칸 순서로 이은 웨이퍼
                cur[(s, qs)] = (full, n, np.zeros(len(n), dtype=bool), w)
                if gated:                               # 관문을 지난 칸만 계산 (가능한 조합 수에는 다 센다)
                    comp = np.flatnonzero(hot)
                    if not len(comp):
                        continue
                    w, n_c = w[np.repeat(hot, n)], n[hot]
                else:
                    comp, n_c = np.arange(len(n)), n
                cand.append((s, qs, dims, full[comp], n_c, stats(w, n_c), comp))
        return cand, cur

    def record(cand, k, cur):
        """계산할 칸의 z를 구해 조합으로 적고, z 1.96을 넘은 칸을 cur에 표시한다(다음 깊이의 관문)"""
        nonlocal r
        if not cand:
            return
        col = lambda f: np.concatenate([c[5][f] for c in cand]).astype(float)
        nn = np.concatenate([c[4] for c in cand]).astype(float)
        sm, ss = col('sum_y'), col('ss')
        zy = sig_z('y', nn, col)
        zb = sig_z('b', nn, col) * binom_fix(nn, col('x_bad'), col('x_exp') / nn) if 'b' in sig else None
        if zb is not None and k == 1 and len(zy) > 2:   # 두 z의 상관: 오더 1개 조합(대부분 우연)에서 잰다
            r = float(np.clip(np.corrcoef(zy, zb)[0, 1], 0.0, 0.95))
        z = zy if zb is None else (zy + zb) / math.sqrt(2 + 2 * r)
        x_bad, x_exp = (col('x_bad'), col('x_exp')) if 'b' in sig else (None, None)   # 랭킹의 초과 bad = bad 장수 − 기대 bad 장수
        # 조합 기록: 배열을 한 번에 파이썬 값으로 바꾸고, 칸 번호 → Order마다 유닛 번호도 묶음째 푼다 (조합이 많을 때 빠르게)
        nn_l, sm_l, ss_l, z_l, zy_l = nn.tolist(), sm.tolist(), ss.tolist(), z.tolist(), zy.tolist()
        nan_l = [math.nan] * len(nn_l)
        zb_l = zb.tolist() if zb is not None else nan_l
        xb_l, xe_l = (x_bad.tolist(), x_exp.tolist()) if x_bad is not None else (nan_l, nan_l)
        sv_l = col('sum_v').tolist() if V is not None else nan_l
        j = 0
        for s, qs, dims, keys, _, _, comp in cand:
            U = np.empty((len(keys), len(dims)), dtype=np.int64)
            rest = keys.copy()
            for i in range(len(dims) - 1, -1, -1):
                U[:, i] = rest % dims[i]
                rest //= dims[i]
            j0, prefix = j, f'{s}|'
            for row in U.tolist():
                items = tuple(zip(qs, row))
                n_ = nn_l[j]
                c = {'id': len(combos), 'key': prefix + '|'.join(f'{q}:{u}' for q, u in items), 'step': s, 'k': k, 'items': items,
                     'n': int(n_), 'sum': sm_l[j], 'ss': ss_l[j], 'mean': sm_l[j] / n_,
                     'z': z_l[j], 'z_y': zy_l[j], 'z_b': zb_l[j],
                     'bad_rate': xb_l[j] / n_, 'x_bad': xb_l[j], 'x_exp': xe_l[j], 'vmean': sv_l[j] / n_}
                combos.append(c)
                j += 1
            cur[(s, qs)][2][comp[z[j0:j] > Z95]] = True

    def by_step(store):
        out = defaultdict(list)
        for s, qs in store:
            out[s].append(qs)
        return out

    count = lambda store: sum(len(v[1]) for v in store.values())
    if progress:
        progress(1)
    cand, cur1 = level(1, {s: [(q,) for q in multi[s]] for s in range(len(steps)) if multi[s]}, {}, min_n)
    search = [0, count(cur1)] if cur1 else [0]  # Order 수별 가능한 조합 수 (기준 z 보정용, 관문으로 계산을 건너뛴 칸도 센다)
    record(cand, 1, cur1)
    n1 = len(combos)

    def deeper(lo):
        """Order 2개 이상 조합을 웨이퍼 lo장 이상 칸으로 만든다. 깊이마다 가능한 조합 수 (새 칸이 없으면 멈춘다)"""
        del combos[n1:]
        out, store = [], {}
        for key, (u_, n_, h_, w_) in cur1.items():
            big = n_ >= lo
            if big.any():
                store[key] = (u_[big], n_[big], h_[big], w_[np.repeat(big, n_)])
        k = 1
        while store and (max_depth is None or k < max_depth):
            k += 1
            if progress:
                progress(k)
            cand, cur = level(k, by_step(store), store, lo)
            if not cur:                         # 이 깊이에 중복 아닌 칸이 없으면 더 깊은 칸도 없다
                break
            out.append(count(cur))
            record(cand, k, cur)
            store = cur
        return out

    # 넘을 수 없는 칸: Order 1개 기준선(× 퍼짐)을 가장 나쁜 경우에도 못 넘는 웨이퍼 수(sigma장 미만)는 Order 2개 이상에서 만들지도 세지도
    # 않는다. 다 만든 뒤 묶음마다 실제 기준으로 다시 확인해서, 뺀 칸이 어느 묶음 기준이라도 넘을 수 있었으면 빼지 않고 다시 만든다
    s1 = spread_of(np.array([c['z'] for c in combos])) if spread_adjust else 1.0
    possible = [g for g in (2, 3, 4) if (max_depth is None or max_depth >= g) and any(len(m) >= g for m in multi)]
    lo, sigma_z = min_n, -math.inf
    if possible and len(search) > 1:
        lo, sigma_z = crossable_min(norm_inv(1 - FWER_ALPHA / (1 + len(possible)) / search[1]) * s1, r)
    deep = deeper(lo)
    if lo > min_n:
        M = {1: search[1]}
        for k, m in enumerate(deep, start=2):
            M[share_group(k)] = M.get(share_group(k), 0) + m
        D = sum(1 for m in M.values() if m)
        if any(sigma_z >= s1 * (norm_inv(1 - FWER_ALPHA / D / M[g]) if M.get(g) else norm_inv(1 - FWER_ALPHA / (D + 1))) for g in possible):
            lo, sigma_z = min_n, -math.inf
            deep = deeper(min_n)
    search += deep
    by_key = {c['key']: c for c in combos}
    depth = len(search) - 1                     # 실제로 조합이 나온 가장 큰 Order 수
    depth_count = [0] * (depth + 1)
    for c in combos:
        depth_count[c['k']] += 1
    return {'mu': mu, 'sd': sd, 'N': N, 'max_depth': depth, 'depth_limit': max_depth, 'signals': list(sig), 'r': r,
            'p0': p0 if 'b' in sig else None, 'combos': combos, 'by_key': by_key, 'depth_count': depth_count,
            'search_space': search, 'same_orders': same_orders, 'sigma': lo if lo > min_n else None, 'sigma_z': sigma_z}


def share_group(k):
    """5%를 나눠 쓰는 묶음: Order 1개 · 2개 · 3개 · 4개 이상(4). Order 수를 얼마나 늘려도 묶음은 넷이라 Order 1~3개 기준은 그대로다"""
    return min(k, 4)


def order_text(k):
    """기준 z를 말할 때의 Order 수: 4개부터는 한 묶음이라 '4개 이상'"""
    return f'{k}개' if k < 4 else '4개 이상'


def thresholds(res, spread_adjust=True, value_curve=True):
    """오더 수별 기준 z (Bonferroni): 5%를 묶음(Order 1개 · 2개 · 3개 · 4개 이상 중 조합이 있는 것) 수 D로 나누고,
    묶음마다 그 안의 가능한 조합 수 M만큼 다시 나눈다. 그래서 차트 전체에서 하나라도 우연히 넘을 확률이 5%다.
    Order 4개 이상은 한 묶음이라 MAX_DEPTH를 늘려도 Order 1~3개의 기준은 변하지 않는다. 조합이 없는 오더 수는 NaN.
    퍼짐 보정: 오더 1개 조합의 z는 우연이면 퍼짐이 1이어야 한다. 같은 랏 웨이퍼가 함께 움직이거나 시간에 따라 값이 변하면
    더 넓게 퍼지므로, 그 배수 s(가운데 50% 폭 ÷ 1.349, 1보다 작으면 1)만큼 모든 조합의 기준을 넓힌다(classify의 c['thr'] = 기본 기준 z × s).
    6절 √(2 ln M_N) 경계는 비교용이라 웨이퍼 수 N별 퍼짐 s(N)을 따로 잰다(spread_curve, value_curve가 False면 생략). spread_adjust가 False면 둘 다 1"""
    M = defaultdict(int)                       # 묶음 → 가능한 조합 수
    for k, m in enumerate(res['search_space']):
        if k and m:
            M[share_group(k)] += m
    res['share_groups'] = dict(sorted(M.items()))
    ones = lambda x: np.ones_like(np.asarray(x, dtype=float))
    res['spread_measured'] = s = spread_of(np.array([c['z'] for c in res['combos'] if c['k'] == 1]))
    res['spread'] = (lambda x: np.full_like(np.asarray(x, dtype=float), s)) if spread_adjust else ones
    res['spread_value'] = spread_curve(res['combos'], 'z_y') if spread_adjust and value_curve else ones   # 6절 √(2 ln M_N) 경계용 (Value z)
    return [0.0] + [norm_inv(1 - FWER_ALPHA / len(M) / M[share_group(k)]) if m else math.nan
                    for k, m in enumerate(res['search_space']) if k]


def spread_curve(combos, field, window=1.25, min_pts=50, grid_size=40):
    """웨이퍼 수 N에 따른 z의 퍼짐 s(N) (우연이면 1)을 돌려주는 함수. 그 N 주변(N ÷ 1.25 ~ N × 1.25, 점이 min_pts개보다 적으면
    범위를 넓힘)에 찍힌 모든 조합의 z를 가운데 50% 폭 ÷ 1.349로 잰다. 로그 N 격자 사이는 선형 보간, 격자 밖은 끝 값, 1보다 작으면 1"""
    n = np.array([c['n'] for c in combos], dtype=float)
    z = np.array([c[field] for c in combos], dtype=float)
    if len(n) < min_pts:
        return lambda x: np.ones_like(np.asarray(x, dtype=float))
    o = np.argsort(n, kind='stable')
    n, z = n[o], z[o]
    grid = np.exp(np.linspace(np.log(n[0]), np.log(n[-1]), grid_size))
    s = np.empty(grid_size)
    for i, g in enumerate(grid):
        w = window
        while True:
            lo, hi = np.searchsorted(n, g / w, 'left'), np.searchsorted(n, g * w, 'right')
            if hi - lo >= min_pts or (lo == 0 and hi == len(n)):
                break
            w *= window
        q1, q3 = np.quantile(z[lo:hi], [0.25, 0.75])
        s[i] = max(1.0, float(q3 - q1) / 1.349)
    lg = np.log(grid)
    return lambda x: np.interp(np.log(np.asarray(x, dtype=float)), lg, s)


def members_of(d, c):
    """조합의 웨이퍼 (불리언 배열)"""
    A = d['assign'][c['step']]
    m = np.ones(d['N'], dtype=bool)
    for q, u in c['items']:
        m &= A[q] == u
    return m


def sig_values(d, k_):
    """신호 값: 'y' = 분석용 Value, 'b' = bad(0/1, part별로 맞췄으면 bad − 자기 part의 bad 비율 + 전체 bad 비율)"""
    return d['Y'] if k_ == 'y' else d['B']


def sig_mean_z(d, r, k_, m):
    """웨이퍼 묶음 m에서 신호 k_의 평균이 전체보다 높은지의 z (조합의 z와 같은 계산)"""
    v, n = sig_values(d, k_), int(m.sum())
    if k_ == 'b' and 'b' in d.get('part_sig', ()):     # 조합의 bad z와 같은 계산
        cp = np.bincount(d['part_idx'][m], minlength=d['part_idx'].max() + 1).astype(float)
        n_g = np.bincount(d['part_idx']).astype(float)
        v_g = np.bincount(d['part_idx'], weights=d['bad_exp'] * (1 - d['bad_exp'])) / n_g
        var = float((cp * v_g * (1 - cp / n_g)).sum())
        return float((np.nan_to_num(d['bad'])[m].sum() - d['bad_exp'][m].sum()) / math.sqrt(max(var, 1e-12)))
    if k_ in d.get('part_sig', ()):                    # part별로 맞춘 신호: √(1 − …)도 part별 (조합의 z와 같음)
        cp = np.bincount(d['part_idx'][m], minlength=d['part_idx'].max() + 1).astype(float)
        sh = float(part_shrink(n, (cp * cp / np.bincount(d['part_idx'])).sum(), len(v)))
    else:
        sh = float(shrink(n, len(v)))
    return float((v[m].mean() - v.mean()) / (v.std(ddof=1) / math.sqrt(n)) / sh)


def sig_diff_z(d, r, k_, a, b):
    """두 웨이퍼 묶음에서 신호 k_의 평균 차이(a − b)의 z (Welch t)"""
    v = sig_values(d, k_)
    var = v[a].var(ddof=1) / a.sum() + v[b].var(ddof=1) / b.sum()
    return float((v[a].mean() - v[b].mean()) / math.sqrt(var)) if var > 0 else 0.0


def combine(r, zs):
    """신호별 z를 하나로: (z_Value + z_bad) ÷ √(2 + 2r). good_bad가 없으면 z_Value 그대로"""
    return zs[0] if len(zs) == 1 else (zs[0] + zs[1]) / math.sqrt(2 + 2 * r['r'])


def mean_z(d, r, m):
    """웨이퍼 묶음이 전체보다 나쁜지의 결합 z (조합의 z와 같은 계산)"""
    if m.sum() < 2:
        return 0.0
    zs = [sig_mean_z(d, r, k_, m) for k_ in r['signals']]
    if len(zs) > 1:
        bad01 = np.nan_to_num(d['bad'])
        e_ = d['bad_exp'][m].mean() if d.get('bad_exp') is not None else bad01.mean()   # part 구성으로 기대되는 bad 비율
        zs[1] *= float(binom_fix([m.sum()], [bad01[m].sum()], e_)[0])
    return combine(r, zs)


def diff_z(d, r, a, b):
    """두 웨이퍼 묶음의 차이(a가 b보다 나쁜지)의 결합 z"""
    return combine(r, [sig_diff_z(d, r, k_, a, b) for k_ in r['signals']]) if a.sum() >= 2 and b.sum() >= 2 else 0.0


def classify(res, zk, d):
    """판정: 정상 · 경고 · 불량 · 상속 · 하위 기인 (웹 js/analysis.js classify와 같은 규칙).
    조합마다 기준 z(c['thr']) = Order 수별 기본 기준 z × 퍼짐 배수를 먼저 정한다.
    부모와의 비교(리프트)와 하위 기인은 기준을 넘은 조합에만 필요해서, 그 조합들만 웨이퍼로 직접 계산한다"""
    combos, by_key = res['combos'], res['by_key']
    mem = {}

    def member(c):
        if c['key'] not in mem:
            mem[c['key']] = members_of(d, c)
        return mem[c['key']]

    s_all = res['spread'](np.array([c['n'] for c in combos], dtype=float)) if combos else []
    for c, s_ in zip(combos, s_all):
        c['thr'] = zk[c['k']] * float(s_)
        c['over'] = c['z'] > c['thr']
        c['explained_by'], c['children'] = None, []
        c['status'] = ('bad' if c['k'] == 1 else None) if c['over'] else ('warn' if c['z'] > Z95 else 'normal')
    for c in combos:
        if not c['over'] or c['k'] == 1:
            continue
        m = member(c)
        c['parents'] = []
        for i in range(c['k']):
            p_items = c['items'][:i] + c['items'][i + 1:]
            pm = members_of(d, {'step': c['step'], 'items': p_items})
            rest = pm & ~m
            c['parents'].append({'key': combo_key(c['step'], p_items), 'items': p_items, 'n': int(pm.sum()), 'mean': float(d['Y'][pm].mean()),
                                 'rest_n': int(rest.sum()), 'rest_mean': float(d['Y'][rest].mean()) if rest.any() else math.nan,
                                 't': diff_z(d, res, m, rest)})
            if (P := by_key.get(c['parents'][-1]['key'])) is not None:
                P['children'].append(c['id'])
        c['lift_t'] = min(p['t'] for p in c['parents'])
        c['status'] = 'bad' if c['lift_t'] > c['thr'] else 'inherited'
    for k in range(res['max_depth'] - 1, 0, -1):
        for c in combos:
            if c['k'] != k or c['status'] != 'bad':
                continue
            for cid in c['children']:
                ch = combos[cid]
                if ch['status'] not in ('bad', 'explained'):
                    continue
                rest = member(c) & ~member(ch)
                if rest.sum() >= 2 and mean_z(d, res, rest) <= zk[k] * float(res['spread'](rest.sum())):
                    c['status'], c['explained_by'] = 'explained', ch['id']
                    break
    count = lambda st: sum(c['status'] == st for c in combos)
    return {'over': sum(c['over'] for c in combos), 'bad': count('bad'), 'inherited': count('inherited'), 'explained': count('explained')}


def build_index(r):
    """기준 밖 조합을 (스텝, 오더, 유닛)으로 바로 찾는 색인. 후보 찾기가 전체 조합을 매번 훑지 않게 한다"""
    idx = defaultdict(list)
    for b in r['combos']:
        if b['over']:
            for it in b['items']:
                idx[(b['step'], it)].append(b)
    r['over_index'] = idx
