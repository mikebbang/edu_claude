// 통계 유틸: 정규분포, F/t 분포(정규화 불완전 베타), ANOVA, Welch t, BH-FDR

// 상보 오차함수 (Numerical Recipes erfcc, 상대오차 < 1.2e-7, 꼬리에서도 유효)
function erfc(x) {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r =
    t *
    Math.exp(
      -z * z - 1.26551223 +
        t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 +
        t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277))))))))
    );
  return x >= 0 ? r : 2 - r;
}

export const normCdf = (z) => 0.5 * erfc(-z / Math.SQRT2);
// 상단 꼬리 확률 P(Z > z)
export const normSf = (z) => 0.5 * erfc(z / Math.SQRT2);

// 표준정규 분위수 (Acklam + Halley 1회 보정)
export function normInv(p) {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  let x;
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p));
    x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= 1 - pl) {
    const q = p - 0.5;
    const r = q * q;
    x = ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const e = normCdf(x) - p;
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2);
  return x - u / (1 + (x * u) / 2);
}

function lgamma(x) {
  const g = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x;
  const tmp = x + 5.5 - (x + 0.5) * Math.log(x + 5.5);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += g[j] / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

function betacf(a, b, x) {
  const MAXIT = 300, EPS = 3e-14, FPMIN = 1e-300;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

// 정규화 불완전 베타 I_x(a, b)
export function ibeta(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}

// P(F > f), F ~ F(d1, d2)
export const fSf = (f, d1, d2) => (f <= 0 ? 1 : ibeta(d2 / (d2 + d1 * f), d2 / 2, d1 / 2));

// 단측 P(T > t), T ~ t(df)
export function tSf(t, df) {
  const p = 0.5 * ibeta(df / (df + t * t), df / 2, 0.5);
  return t >= 0 ? p : 1 - p;
}

// 요약통계 {n, sum, ss} → 평균·분산
export const meanOf = (g) => g.sum / g.n;
export const varOf = (g) => (g.n > 1 ? Math.max(0, (g.ss - (g.sum * g.sum) / g.n) / (g.n - 1)) : 0);

// one-way ANOVA: groups = [{n, sum, ss}]
export function anova(groups) {
  const gs = groups.filter((g) => g.n > 0);
  const k = gs.length;
  const N = gs.reduce((a, g) => a + g.n, 0);
  if (k < 2 || N - k < 1) return null;
  const grand = gs.reduce((a, g) => a + g.sum, 0) / N;
  let ssb = 0, ssw = 0;
  for (const g of gs) {
    const m = g.sum / g.n;
    ssb += g.n * (m - grand) ** 2;
    ssw += g.ss - g.n * m * m;
  }
  const d1 = k - 1, d2 = N - k;
  const F = ssb / d1 / (ssw / d2);
  return { F, d1, d2, p: fSf(F, d1, d2) };
}

// Welch t: a가 b보다 큰지 단측 검정
export function welch(a, b) {
  if (a.n < 2 || b.n < 2) return { t: 0, df: 1, p: 1 };
  const ma = meanOf(a), mb = meanOf(b);
  const va = varOf(a) / a.n, vb = varOf(b) / b.n;
  const se = Math.sqrt(va + vb);
  if (se === 0) return { t: 0, df: 1, p: 1 };
  const t = (ma - mb) / se;
  const df = (va + vb) ** 2 / ((va * va) / (a.n - 1) + (vb * vb) / (b.n - 1));
  return { t, df, p: tSf(t, df) };
}

// Benjamini–Hochberg q-value
export function bhQ(pvals) {
  const m = pvals.length;
  const idx = pvals.map((p, i) => i).sort((i, j) => pvals[i] - pvals[j]);
  const q = new Array(m);
  let min = 1;
  for (let r = m - 1; r >= 0; r--) {
    const i = idx[r];
    min = Math.min(min, (pvals[i] * m) / (r + 1));
    q[i] = min;
  }
  return q;
}

export function quantile(sorted, p) {
  if (!sorted.length) return NaN;
  const h = (sorted.length - 1) * p;
  const lo = Math.floor(h);
  return sorted[lo] + (h - lo) * ((sorted[Math.min(lo + 1, sorted.length - 1)] ?? sorted[lo]) - sorted[lo]);
}
