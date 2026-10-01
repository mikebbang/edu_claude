'use strict';
// 차트 공통: 색 · 숫자 표시 · 눈금 · 축 · 띠 (외부 라이브러리 없이 SVG 문자열로 그린다)

const C = {};
function readColors() {
  const cs = getComputedStyle(document.documentElement);
  for (const k of ['ink', 'ink2', 'muted', 'line', 'line2', 'band', 'bad', 'good', 'accent', 'card']) C[k] = cs.getPropertyValue('--' + k).trim();
}
// 조합별 색 (빨강은 선택 경로 전용이라 뺀다)
const PALETTE = ['#2f7fd8', '#1d9e75', '#7f77dd', '#ba7517', '#d4537e', '#639922', '#5f8fa3'];

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const fmt = {
  int: (v) => (v == null ? '–' : Math.round(v).toLocaleString('ko-KR')),
  pct: (v, d = 1) => (v == null ? '–' : (v * 100).toFixed(d) + '%'),
  num: (v) => {
    if (v == null || !isFinite(v)) return '–';
    const a = Math.abs(v);
    if (a >= 1000) return Math.round(v).toLocaleString('ko-KR');
    if (a >= 100) return v.toFixed(0);
    if (a >= 10) return v.toFixed(1);
    if (a >= 1) return v.toFixed(2);
    return v === 0 ? '0' : v.toPrecision(2);
  },
  signed: (v, d = 0) => (v == null ? '–' : (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(d)),
  tick: (v) => (Math.abs(v) >= 1000 ? Math.round(v).toLocaleString('ko-KR') : String(Number(v.toPrecision(3)))),
  date: (ms, withYear) => {
    const t = new Date(ms);
    const md = String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0');
    return withYear ? t.getFullYear() + '-' + md : md;
  },
};

function linTicks(lo, hi, k = 5) {
  const span = hi - lo || Math.abs(hi) || 1;
  const mag = Math.pow(10, Math.floor(Math.log10(span / k)));
  let step = mag * 10;
  for (const m of [1, 2, 2.5, 5, 10]) if (span / (m * mag) <= k) { step = m * mag; break; }
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(+v.toFixed(10));
  return out;
}

function logTicks(lo, hi) {
  const out = [];
  for (let e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(hi)); e++) {
    for (const m of [1, 2, 5]) {
      const v = m * Math.pow(10, e);
      if (v >= lo * 0.999 && v <= hi * 1.001) out.push(v);
    }
  }
  return out.length > 9 ? out.filter((v) => String(v)[0] === '1' || String(v)[0] === '5') : out;
}

function timeTicks(lo, hi, k = 5) {
  const day = 864e5;
  const span = Math.max(hi - lo, day);
  const step = [1, 2, 7, 14, 30, 61, 91, 182, 365, 730].map((d) => d * day).find((s) => span / s <= k) || 730 * day;
  const out = [];
  const first = new Date(lo);
  first.setHours(0, 0, 0, 0);
  for (let v = first.getTime(); v <= hi; v += step) if (v >= lo) out.push(v);
  const withYear = new Date(lo).getFullYear() !== new Date(hi).getFullYear();
  return out.map((v) => ({ v, l: fmt.date(v, withYear) }));
}

const scaleLin = (d0, d1, r0, r1) => (v) => r0 + ((v - d0) / (d1 - d0 || 1)) * (r1 - r0);
const scaleLog = (d0, d1, r0, r1) => (v) => r0 + ((Math.log(v) - Math.log(d0)) / (Math.log(d1) - Math.log(d0) || 1)) * (r1 - r0);

// 축: o = {L, R, T, B, xs, ys, xt: [{v, l}], yt: [{v, l}], xl, yl, yo}
function axes(o) {
  const st = `stroke="${C.line2}"`;
  const tx = `fill="${C.ink2}" font-size="11"`;
  let s = `<line x1="${o.L}" y1="${o.B}" x2="${o.R}" y2="${o.B}" ${st}/><line x1="${o.L}" y1="${o.T}" x2="${o.L}" y2="${o.B}" ${st}/>`;
  for (const t of o.xt) {
    const x = o.xs(t.v);
    if (x < o.L - 1 || x > o.R + 1) continue;
    s += `<line x1="${x}" y1="${o.B}" x2="${x}" y2="${o.B + 4}" ${st}/><text x="${x}" y="${o.B + 15}" text-anchor="middle" ${tx}>${esc(t.l)}</text>`;
  }
  for (const t of o.yt) {
    const y = o.ys(t.v);
    if (y < o.T - 1 || y > o.B + 1) continue;
    s += `<line x1="${o.L - 4}" y1="${y}" x2="${o.L}" y2="${y}" ${st}/><text x="${o.L - 6}" y="${y + 4}" text-anchor="end" ${tx}>${esc(t.l)}</text>`;
  }
  s += `<text x="${(o.L + o.R) / 2}" y="${o.B + 31}" text-anchor="middle" fill="${C.ink}" font-size="12">${esc(o.xl)}</text>`;
  s += `<text transform="translate(${o.L - (o.yo || 40)},${(o.T + o.B) / 2}) rotate(-90)" text-anchor="middle" fill="${C.ink}" font-size="12">${esc(o.yl)}</text>`;
  return s;
}

// 경계선 띠: 위 · 아래 선과 그 사이 칠 (n은 오름차순)
function band(ns, lo, hi, xs, ys, yClip) {
  const pts = [];
  for (let i = 0; i < ns.length; i++) if (lo[i] != null && hi[i] != null) pts.push([xs(ns[i]), ys(Math.max(yClip[0], Math.min(yClip[1], hi[i]))), ys(Math.max(yClip[0], Math.min(yClip[1], lo[i])))]);
  if (!pts.length) return '';
  const up = pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const dn = pts.map((p) => `${p[0].toFixed(1)},${p[2].toFixed(1)}`).join(' ');
  const back = pts.slice().reverse().map((p) => `${p[0].toFixed(1)},${p[2].toFixed(1)}`).join(' ');
  return `<polygon points="${up} ${back}" fill="${C.band}"/><polyline points="${up}" fill="none" stroke="${C.ink2}" stroke-width="1.3"/>` +
    `<polyline points="${dn}" fill="none" stroke="${C.ink2}" stroke-width="1.3"/>`;
}

function quantile(sorted, p) {
  if (!sorted.length) return NaN;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

function skewness(a) {
  const n = a.length;
  if (n < 3) return 0;
  const m = a.reduce((x, y) => x + y, 0) / n;
  let m2 = 0;
  let m3 = 0;
  for (const v of a) { const d = v - m; m2 += d * d; m3 += d * d * d; }
  m2 /= n; m3 /= n;
  return m2 > 0 ? m3 / Math.pow(m2, 1.5) : 0;
}

// 세로축 설명 (툴팁): 제목 · 설명 · 작은 그림
const AXIS_TIP = {
  judg: ['종합 (Value+bad)', '판정에 실제로 쓰는 점수입니다. 경로의 Value 차이와 bad 차이를 합치고 Order 수에 따른 기준 차이까지 맞춘 뒤 높이로 그립니다. 선 밖이면 판정에서도 밖입니다. 높이는 기준선 대비 위치라 눈금 숫자는 적지 않습니다.'],
  mean: ['y_value 평균', '경로 웨이퍼의 y_value 평균을 그대로 그립니다. 선은 Value만 봤을 때의 기준선이라, bad 때문에 판정된 경로는 선 안에 보일 수 있습니다.'],
  bad: ['bad 비율', '경로 웨이퍼 중 bad 비율을 그대로 그립니다. 선은 bad만 봤을 때의 기준선이라, Value 때문에 판정된 경로는 선 안에 보일 수 있습니다.'],
};
function axisTipSvg(k) {
  const L = 22, R = 224, T = 6, B = 66;
  let s = `<line x1="${L}" y1="${B}" x2="${R}" y2="${B}" stroke="${C.line2}"/><line x1="${L}" y1="${T}" x2="${L}" y2="${B}" stroke="${C.line2}"/>`;
  let up = '', dn = '';
  for (let i = 0; i <= 20; i++) {
    const x = L + (i / 20) * (R - L);
    const hw = 26 / Math.sqrt(1 + i * 0.5);
    up += `${x},${36 - hw} `;
    dn += `${x},${36 + hw} `;
  }
  s += `<polyline points="${up}" fill="none" stroke="${C.ink2}"/><polyline points="${dn}" fill="none" stroke="${C.ink2}"/>`;
  for (const [x, y] of [[50, 40], [70, 30], [90, 44], [110, 34], [140, 38], [160, 33], [190, 39], [205, 35]]) s += `<circle cx="${x}" cy="${y}" r="2" fill="${C.muted}"/>`;
  const ry = k === 'mean' ? 31 : 13;
  s += `<circle cx="120" cy="${ry}" r="4" fill="${C.bad}"/><text x="128" y="${ry + 4}" fill="${C.bad}" font-size="11">${k === 'mean' ? 'bad로 판정된 경로 → 선 안' : '판정된 경로 → 선 밖'}</text>`;
  return s + `<text x="${(L + R) / 2}" y="${B + 14}" text-anchor="middle" fill="${C.ink2}" font-size="11">웨이퍼 수 N</text>`;
}
