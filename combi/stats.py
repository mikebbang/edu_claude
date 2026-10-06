"""통계 함수: 정규분포 · 베타 · 이항 꼬리 등 (외부 통계 라이브러리 없이 numpy만 씀)"""
import math

import numpy as np
import pandas as pd

Z95, FWER_ALPHA = 1.959964, 0.05
SQRT2 = math.sqrt(2)
_A = (-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239)
_B = (-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572)
_C = (-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783)
_D = (0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416)
_LG = (76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5)


def erfc(x):
    x = np.asarray(x, dtype=float)
    z = np.abs(x)
    t = 1 / (1 + 0.5 * z)
    poly = 1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))
    r = t * np.exp(-z * z - 1.26551223 + t * poly)
    return np.where(x >= 0, r, 2 - r)


def norm_cdf(z):
    return 0.5 * erfc(-np.asarray(z, dtype=float) / SQRT2)


def norm_sf(z):
    return 0.5 * erfc(np.asarray(z, dtype=float) / SQRT2)


def norm_inv(p):
    if p <= 0:
        return -math.inf
    if p >= 1:
        return math.inf
    if p < 0.02425:
        q = math.sqrt(-2 * math.log(p))
        x = (((((_C[0] * q + _C[1]) * q + _C[2]) * q + _C[3]) * q + _C[4]) * q + _C[5]) / ((((_D[0] * q + _D[1]) * q + _D[2]) * q + _D[3]) * q + 1)
    elif p <= 1 - 0.02425:
        q = p - 0.5
        r = q * q
        x = ((((((_A[0] * r + _A[1]) * r + _A[2]) * r + _A[3]) * r + _A[4]) * r + _A[5]) * q) / (((((_B[0] * r + _B[1]) * r + _B[2]) * r + _B[3]) * r + _B[4]) * r + 1)
    else:
        q = math.sqrt(-2 * math.log(1 - p))
        x = -(((((_C[0] * q + _C[1]) * q + _C[2]) * q + _C[3]) * q + _C[4]) * q + _C[5]) / ((((_D[0] * q + _D[1]) * q + _D[2]) * q + _D[3]) * q + 1)
    e = float(norm_cdf(x)) - p
    u = e * math.sqrt(2 * math.pi) * math.exp((x * x) / 2)
    return x - u / (1 + (x * u) / 2)


def norm_isf(p):
    """상단 꼬리확률 → z (배열, 아주 작은 p도 정밀하게)"""
    p = np.clip(np.atleast_1d(np.asarray(p, dtype=float)), 1e-300, 1 - 1e-16)
    x = np.empty_like(p)
    lo, hi = p < 0.02425, p > 1 - 0.02425
    mid = ~(lo | hi)
    q = np.sqrt(-2 * np.log(p[lo]))
    x[lo] = (((((_C[0] * q + _C[1]) * q + _C[2]) * q + _C[3]) * q + _C[4]) * q + _C[5]) / ((((_D[0] * q + _D[1]) * q + _D[2]) * q + _D[3]) * q + 1)
    q = p[mid] - 0.5
    r = q * q
    x[mid] = ((((((_A[0] * r + _A[1]) * r + _A[2]) * r + _A[3]) * r + _A[4]) * r + _A[5]) * q) / (((((_B[0] * r + _B[1]) * r + _B[2]) * r + _B[3]) * r + _B[4]) * r + 1)
    q = np.sqrt(-2 * np.log(1 - p[hi]))
    x[hi] = -(((((_C[0] * q + _C[1]) * q + _C[2]) * q + _C[3]) * q + _C[4]) * q + _C[5]) / ((((_D[0] * q + _D[1]) * q + _D[2]) * q + _D[3]) * q + 1)
    with np.errstate(all='ignore'):
        e = norm_cdf(x) - p
        u = e * math.sqrt(2 * math.pi) * np.exp((x * x) / 2)
        refined = x - u / (1 + (x * u) / 2)
    return -np.where(np.isfinite(refined) & (p > 1e-250), refined, x)


def lgamma(x):
    x = np.asarray(x, dtype=float)
    y = x.copy()
    tmp = x + 5.5 - (x + 0.5) * np.log(x + 5.5)
    ser = 1.000000000190015
    for g in _LG:
        y = y + 1
        ser = ser + g / y
    return -tmp + np.log((2.5066282746310005 * ser) / x)


def betacf(a, b, x):
    a, b, x = np.broadcast_arrays(*(np.asarray(v, dtype=float) for v in (a, b, x)))
    MAXIT, EPS, FPMIN = 300, 3e-14, 1e-300
    qab, qap, qam = a + b, a + 1, a - 1
    floor = lambda v: np.where(np.abs(v) < FPMIN, FPMIN, v)
    c = np.ones_like(x)
    d = 1 / floor(1 - (qab * x) / qap)
    h_ = d.copy()
    live = np.ones(x.shape, dtype=bool)
    with np.errstate(all='ignore'):
        for m in range(1, MAXIT + 1):
            m2 = 2 * m
            aa = (m * (b - m) * x) / ((qam + m2) * (a + m2))
            d1 = 1 / floor(1 + aa * d)
            c1 = floor(1 + aa / c)
            h1 = h_ * (d1 * c1)
            aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2))
            d1 = 1 / floor(1 + aa * d1)
            c1 = floor(1 + aa / c1)
            de = d1 * c1
            h1 = h1 * de
            c, d, h_ = np.where(live, c1, c), np.where(live, d1, d), np.where(live, h1, h_)
            live &= ~(np.abs(de - 1) < EPS)
            if not live.any():
                break
    return h_


def ibeta(x, a, b):
    x, a, b = np.broadcast_arrays(*(np.atleast_1d(np.asarray(v, dtype=float)) for v in (x, a, b)))
    out = np.where(x <= 0, 0.0, 1.0)
    mid = (x > 0) & (x < 1)
    if mid.any():
        xm, am, bm = x[mid], a[mid], b[mid]
        bt = np.exp(lgamma(am + bm) - lgamma(am) - lgamma(bm) + am * np.log(xm) + bm * np.log(1 - xm))
        front = xm < (am + 1) / (am + bm + 2)
        r = np.empty_like(xm)
        if front.any():
            r[front] = (bt[front] * betacf(am[front], bm[front], xm[front])) / am[front]
        if (~front).any():
            r[~front] = 1 - (bt[~front] * betacf(bm[~front], am[~front], 1 - xm[~front])) / bm[~front]
        out[mid] = r
    return out


def t_sf(t, df):
    t, df = np.atleast_1d(np.asarray(t, dtype=float)), np.atleast_1d(np.asarray(df, dtype=float))
    p = 0.5 * ibeta(df / (df + t * t), df / 2, 0.5)
    return np.where(t >= 0, p, 1 - p)


def f_sf(f, d1, d2):
    f = np.atleast_1d(np.asarray(f, dtype=float))
    with np.errstate(all='ignore'):
        p = ibeta(d2 / (d2 + d1 * f), d2 / 2, d1 / 2)
    return np.where(f <= 0, 1.0, p)


def anova(n, s, ss):
    keep_ = n > 0
    n, s, ss = n[keep_].tolist(), s[keep_].tolist(), ss[keep_].tolist()
    k, N_ = len(n), sum(n)
    if k < 2 or N_ - k < 1:
        return None
    grand = sum(s) / N_
    ssb = sum(ni * (si / ni - grand) ** 2 for ni, si in zip(n, s))
    ssw = sum(ssi - ni * (si / ni) ** 2 for ni, si, ssi in zip(n, s, ss))
    if ssw <= 0:
        return None
    d1, d2 = k - 1, N_ - k
    F = ssb / d1 / (ssw / d2)
    return {'F': F, 'd1': d1, 'd2': d2, 'p': float(f_sf(F, d1, d2)[0])}


def rank_scores(v, groups=None):
    """순위 점수: 순위를 정규분포 점수로 옮긴 값(같은 값은 평균 순위). groups를 주면 묶음(part)마다 따로 매긴다"""
    s_ = pd.Series(np.asarray(v, dtype=float))
    if groups is None:
        return -norm_isf((s_.rank().to_numpy() - 0.5) / len(s_))
    g_ = s_.groupby(np.asarray(groups))
    return -norm_isf((g_.rank().to_numpy() - 0.5) / g_.transform('size').to_numpy())


def binom_fix(n, x, p0):
    """bad(0/1) z의 꼬리 보정 배수. bad 비율이 낮고 웨이퍼가 적으면 bad 장수 분포가 오른쪽으로 길어서
    정규 근사 z가 실제보다 커진다. 정확한 이항 꼬리확률 P(bad ≥ x)로 구한 z ÷ 정규 근사 z를 곱해 줄인다(1보다 크게 하지는 않음).
    p0는 기대 bad 비율: 전체 bad 비율, 또는 part별로 맞췄으면 조합마다 part 구성으로 기대되는 비율(배열)"""
    n, x = np.asarray(n, dtype=float), np.rint(np.asarray(x, dtype=float))
    p0 = np.broadcast_to(np.asarray(p0, dtype=float), n.shape)
    ok = (p0 > 0) & (p0 < 1)
    with np.errstate(divide='ignore', invalid='ignore'):
        z_norm = np.where(ok, (x - n * p0) / np.sqrt(n * p0 * (1 - p0)), 0.0)
    fix = np.ones_like(n)
    up = ok & (z_norm > 0.5)
    if up.any():
        nu, xu, pu = n[up], x[up], p0[up]
        ge = lambda k: np.where(k <= 0, 1.0, ibeta(pu, np.maximum(k, 1), np.maximum(nu - k + 1, 1e-9)))
        fix[up] = np.clip(np.minimum(norm_isf(np.maximum(ge(xu), 1e-300)), 38.0) / z_norm[up], 0.0, 1.0)
    return fix


def part_shrink(n, pn2, N):
    """part별로 맞춘 신호의 √(1 − …): 조합을 자기 part 평균과 비교하므로 Σ_part (조합 안 그 part 웨이퍼 수)² ÷ part 웨이퍼 수를 쓴다.
    part 구성이 전체와 같으면 shrink와 같고, 한 part에 몰린 조합일수록 작아진다(z가 커짐)"""
    return np.sqrt(np.clip(1 - np.asarray(pn2, dtype=float) / np.asarray(n, dtype=float), 1 / N, None))


def log_shift(v):
    """로그로 바꿀 때 빼는 값: 모두 0보다 크면 0, 아니면 가장 작은 값보다 조금 아래(가운데 값 거리의 1%)라
    가장 작은 값도 로그가 된다 (prepare의 Value '로그로'와 같은 방식)"""
    v = np.asarray(v, dtype=float)
    lo = float(v.min())
    return 0.0 if lo > 0 else lo - max(1e-9, 0.01 * float(np.median(v - lo)))


def shrink(n, N):
    """√(1 − 웨이퍼 수 ÷ 전체 웨이퍼 수). 전체 평균에는 조합의 웨이퍼도 들어 있어서, 조합 평균이 전체 평균에서
    우연히 벗어나는 폭은 σ/√n보다 이만큼 좁다. z를 이 값으로 나누면 조합을 나머지 웨이퍼와 비교한 z가 된다"""
    return np.sqrt(np.clip(1 - np.asarray(n, dtype=float) / N, 1 / N, None))


def spread_of(z1):
    """오더 1개 조합 결합 z의 퍼짐 배수: 가운데 50% 폭 ÷ 1.349 (우연이면 1, 1보다 작으면 1). 조합이 20개 미만이면 1"""
    if len(z1) < 20:
        return 1.0
    q1, q3 = np.quantile(z1, [0.25, 0.75])
    return max(1.0, float(q3 - q1) / 1.349)


def compositions(n, caps):
    """합이 n이고 칸마다 caps 이하인 정수 조합(행 하나 = 조합 하나): 웨이퍼 n장이 part에 나뉘는 모든 방법"""
    rows = [()]
    for cap in caps[:-1]:
        rows = [r + (c,) for r in rows for c in range(min(cap, n - sum(r)) + 1)]
    rows = [r + (n - sum(r),) for r in rows if n - sum(r) <= caps[-1]]
    return np.array(rows, dtype=np.int64).reshape(len(rows), len(caps))


def fmt_p(p):
    if p is None or not math.isfinite(p):
        return '–'
    return f'{p:.0e}' if p < 1e-4 else f'{p:.4f}'
