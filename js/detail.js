// 선택한 조합의 스텝 상세: 흐름도, 웨이퍼 분포, 무작위 비교, 오더별 유닛 신뢰구간, 교호작용 히트맵, 시간 추이

import { MISSING } from './mock.js';
import { makeRng } from './rng.js';
import { Z998, LIFT_ALPHA } from './analysis.js';

const fmt = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '–');
const fmtInt = (x) => x.toLocaleString('ko-KR');
const fmtP = (p) => (!Number.isFinite(p) ? '–' : p < 1e-4 ? p.toExponential(0) : p.toFixed(4));
const signed = (x, d = 2) => (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(d);
const N_SAMPLE = 2000;

const ICON_OK = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="8" style="fill:var(--good)"/><path d="M4.6 8.2l2.2 2.2 4.4-4.6" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_NO = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="8" style="fill:var(--ink-3)"/><path d="M5.4 5.4l5.2 5.2M10.6 5.4l-5.2 5.2" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/></svg>';

// ---------- 계산 ----------

// 이 경로 / 오더 하나만 다른 경로 / 나머지 웨이퍼로 나누기
function membership(data, c) {
  const A = c.items.map(([q]) => data.assign[c.step][q]);
  const U = c.items.map(([, u]) => u);
  const me = [], others = [];
  const parents = c.items.map(() => []);
  for (let w = 0; w < data.N; w++) {
    if (A[0][w] === MISSING) continue;
    let miss = 0, at = -1;
    for (let i = 0; i < A.length; i++) if (A[i][w] !== U[i]) { miss++; at = i; }
    if (miss === 0) me.push(w);
    else {
      others.push(w);
      if (miss === 1 && c.k >= 2) parents[at].push(w);
    }
  }
  return { me, others, parents };
}

function summary(Y, idx) {
  const v = Float64Array.from(idx, (w) => Y[w]).sort();
  const q = (p) => {
    const h = (v.length - 1) * p, lo = Math.floor(h);
    return v[lo] + (h - lo) * ((v[Math.min(lo + 1, v.length - 1)]) - v[lo]);
  };
  let s = 0;
  for (const x of v) s += x;
  const q1 = q(0.25), q3 = q(0.75), iqr = q3 - q1;
  return { n: v.length, mean: s / v.length, q1, med: q(0.5), q3, lo: Math.max(v[0], q1 - 1.5 * iqr), hi: Math.min(v[v.length - 1], q3 + 1.5 * iqr), p01: q(0.005), p99: q(0.995) };
}

// 같은 스텝의 웨이퍼에서 n장을 무작위로 뽑은 평균의 분포
function randomMeans(Y, pool, n, seed) {
  const r = makeRng(seed);
  const P = Int32Array.from(pool);
  const out = new Float64Array(N_SAMPLE);
  for (let t = 0; t < N_SAMPLE; t++) {
    let s = 0;
    for (let i = 0; i < n; i++) {
      const j = i + Math.floor(r.u() * (P.length - i));
      const tmp = P[i]; P[i] = P[j]; P[j] = tmp;
      s += Y[P[i]];
    }
    out[t] = s / n;
  }
  return out;
}

function cellMeans(data, s, qa, qb, cond) {
  const A = data.assign[s][qa], B = data.assign[s][qb];
  const C = cond ? data.assign[s][cond.q] : null;
  const ua = data.steps[s].seqs[qa].units.length, ub = data.steps[s].seqs[qb].units.length;
  const n = new Int32Array(ua * ub), sum = new Float64Array(ua * ub);
  for (let w = 0; w < data.N; w++) {
    if (A[w] === MISSING) continue;
    if (C && (C[w] === cond.u) !== cond.eq) continue;
    const k = A[w] * ub + B[w];
    n[k]++;
    sum[k] += data.Y[w];
  }
  return { ua, ub, n, sum };
}

function rolling(xs, ys, win) {
  const out = [];
  let s = 0;
  for (let i = 0; i < ys.length; i++) {
    s += ys[i];
    if (i >= win) s -= ys[i - win];
    if (i >= win - 1) out.push([xs[i - Math.floor(win / 2)], s / win]);
  }
  return out;
}

// ---------- 차트 공통 ----------

function axisStyle(C) {
  return {
    axisLine: { show: false },
    axisTick: { show: false },
    axisLabel: { color: C.ink2, fontSize: 11 },
    splitLine: { lineStyle: { color: C.line } },
    nameTextStyle: { color: C.ink2, fontSize: 11 },
  };
}
function tip(C) {
  return {
    confine: true, borderWidth: 0, padding: [8, 10],
    backgroundColor: C.surface, textStyle: { color: C.ink, fontSize: 12 },
    extraCssText: 'border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.14);',
  };
}

// 값 축(-0.5 ~ n-0.5)으로 그리고, 같은 위치에 겹친 범주 축으로 이름을 단다
function labelAxes(names, C, size) {
  return [
    { type: 'value', min: -0.5, max: names.length - 0.5, inverse: true, show: false },
    {
      type: 'category', data: names, inverse: true, position: 'left',
      axisLine: { show: false }, axisTick: { show: false }, splitLine: { show: false },
      axisLabel: { color: C.ink, fontSize: size },
    },
  ];
}

// ---------- HTML 조각 ----------

function flowSvg(data, res, c) {
  const st = data.steps[c.step];
  const info = res.seqInfo[c.step];
  const hit = new Map(c.items.map(([q, u]) => [q, u]));
  const colW = 84, gap = 26, boxH = 22, boxGap = 4, top = 42, padX = 2;
  const maxU = Math.max(...st.seqs.map((s) => s.units.length));
  const W = padX * 2 + st.seqs.length * colW + (st.seqs.length - 1) * gap;
  const H = top + maxU * (boxH + boxGap) + 4;
  let maxDev = 0.05;
  info.forEach((sq) => sq.units.forEach((u) => { if (u.mean - res.mu > maxDev) maxDev = u.mean - res.mu; }));
  const colX = (q) => padX + q * (colW + gap);
  const boxY = (u) => top + u * (boxH + boxGap);
  let heads = '', boxes = '', chosen = '';
  st.seqs.forEach((sq, q) => {
    const on = hit.has(q);
    const cx = colX(q) + colW / 2;
    const an = info[q].anova;
    const sub = !info[q].testable ? '유닛 1개' : an && an.p < 0.05 ? `p ${fmtP(an.p)}` : '차이 없음';
    heads += `<text x="${cx}" y="15" text-anchor="middle" class="oh ${on ? 'on' : ''}">오더 ${q + 1}</text>` +
      `<text x="${cx}" y="30" text-anchor="middle" class="os">${sub}</text>`;
    info[q].units.forEach((u, ui) => {
      const sel = on && hit.get(q) === ui;
      const t = Math.max(0, Math.min(1, (u.mean - res.mu) / maxDev));
      const fill = sel ? 'var(--bad)' : `color-mix(in srgb, var(--bad) ${Math.round(t * 55)}%, var(--fill))`;
      const g = `<g class="${on ? '' : 'dim'}"><title>${u.name} · 웨이퍼 ${u.n}장 · 평균 ${fmt(u.mean)}%</title>` +
        `<rect x="${colX(q)}" y="${boxY(ui)}" width="${colW}" height="${boxH}" rx="6" style="fill:${fill}"/>` +
        `<text x="${cx}" y="${boxY(ui) + boxH / 2 + 4}" text-anchor="middle" class="ut ${sel ? 'sel' : ''}">${u.name}</text></g>`;
      if (sel) chosen += g;
      else boxes += g;
    });
  });
  const pts = c.items.map(([q, u]) => [colX(q) + colW / 2, boxY(u) + boxH / 2]).sort((a, b) => a[0] - b[0]);
  let d = '';
  if (pts.length > 1) {
    d = `M${pts[0][0]},${pts[0][1]}`;
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
      const dx = (x1 - x0) / 2;
      d += ` C${x0 + dx},${y0} ${x1 - dx},${y1} ${x1},${y1}`;
    }
  }
  return `<div class="flow"><svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${st.name} 오더별 유닛과 불량 경로">
      ${heads}${d ? `<path d="${d}" class="route"/>` : ''}${boxes}${chosen}</svg></div>`;
}

function badges(c) {
  const list = [
    [c.z > Z998, '99.8% 범위 밖'],
    [c.over, '보정 기준 밖'],
    c.k >= 2 ? [c.liftP < LIFT_ALPHA, '오더 하나 뺀 경로보다 높음'] : [true, '단일 유닛'],
    [c.status !== 'explained', '최소 원인 단위'],
  ];
  return `<div class="badges">${list.map(([ok, t]) => `<span class="bdg ${ok ? 'ok' : 'no'}">${ok ? ICON_OK : ICON_NO}${t}</span>`).join('')}</div>`;
}

// ---------- 렌더 ----------

export function renderDetail(el, { data, res, zk, c, C, statusLabel }) {
  if (!c) {
    el.innerHTML = '<div class="card empty">왼쪽 차트의 점이나 목록을 선택하면 해당 스텝의 상세 차트가 나옵니다.</div>';
    return [];
  }
  const st = data.steps[c.step];
  const seqName = (q) => st.seqs[q].name;
  const { me, others, parents } = membership(data, c);
  const d = c.mean - res.mu;
  const thr = zk[c.k];
  const chips = c.items.map(([q, u]) => `<span class="chip"><small>${seqName(q)}</small>${st.seqs[q].units[u]}</span>`).join('<span class="plus">→</span>');

  // 무작위 비교
  const pool = me.concat(others);
  const sims = randomMeans(data.Y, pool, c.n, 7919 + c.id);
  let beyond = 0;
  for (const v of sims) if (v >= c.mean) beyond++;

  // 히트맵 축 선택
  let heat = null;
  if (c.k >= 2) {
    const [[qa, ua], [qb, ub]] = c.items;
    if (c.k === 3) {
      const [q3, u3] = c.items[2];
      heat = { qa, ua, qb, ub, conds: [{ q: q3, u: u3, eq: true }, { q: q3, u: u3, eq: false }] };
    } else heat = { qa, ua, qb, ub, conds: [null] };
  } else {
    const [qa, ua] = c.items[0];
    const other = st.seqs.map((s, q) => q).filter((q) => q !== qa && st.seqs[q].units.length >= 2)
      .sort((x, y) => st.seqs[x].units.length - st.seqs[y].units.length)[0];
    if (other !== undefined) heat = { qa, ua, qb: other, ub: -1, conds: [null] };
  }
  const condLabel = (cd) => (cd ? `${seqName(cd.q)} ${cd.eq ? '=' : '≠'} ${st.seqs[cd.q].units[cd.u]}` : '');

  el.innerHTML = `
    <div class="card d-head">
      <div class="d-title">
        <h2>${st.name}</h2><span class="sub">${st.proc} · 오더 ${st.seqs.length}개 중 ${c.k}개 경로</span>
        <span class="status ${c.status === 'bad' ? '' : 'rel'}">${statusLabel[c.status]}</span>
      </div>
      <div class="chips">${chips}</div>
      <div class="stat4">
        <div><b class="${d > 0 ? 'up' : ''}">${signed(d)}<small>%p</small></b><span>전체 평균 대비</span></div>
        <div><b>${fmt(c.mean)}<small>%</small></b><span>경로 평균 불량률</span></div>
        <div><b>${fmtInt(c.n)}<small>장</small></b><span>웨이퍼</span></div>
        <div><b class="${c.over ? 'up' : ''}">${fmt(c.z, 1)}<small>/ ${fmt(thr, 1)}</small></b><span>z / 보정 기준</span></div>
      </div>
      ${badges(c)}
    </div>

    <div class="card pane">
      <div class="pane-head"><h3>스텝 흐름</h3><span class="cap">유닛 색 = 평균 불량률</span></div>
      ${flowSvg(data, res, c)}
      <div class="legend-row">
        <span><i class="lg-sel"></i>경로 유닛</span>
        <span><i class="lg-grad"></i>평균 높을수록 진함</span>
        <span><i class="lg-dim"></i>경로와 무관한 오더</span>
      </div>
    </div>

    <div class="grid2">
      <div class="card pane">
        <div class="pane-head"><h3>웨이퍼 분포</h3><span class="cap">상자 = 사분위 · ◆ = 평균</span></div>
        <div class="dchart" id="d-dist" style="height:${150 + (c.k >= 2 ? c.k : 0) * 48}px"></div>
      </div>
      <div class="card pane">
        <div class="pane-head"><h3>무작위 ${fmtInt(c.n)}장 평균 ${fmtInt(N_SAMPLE)}회</h3><span class="cap">이 경로 이상 <b class="${beyond ? '' : 'red'}">${beyond} / ${fmtInt(N_SAMPLE)}</b></span></div>
        <div class="dchart" id="d-perm"></div>
      </div>
    </div>

    <div class="card pane">
      <div class="pane-head"><h3>오더별 유닛 평균</h3><span class="cap">점 = 평균 · 선 = 95% 신뢰구간</span></div>
      <div class="multi" id="d-units"></div>
    </div>

    <div class="${heat && heat.conds.length === 2 ? '' : 'grid2'}" style="display:grid;gap:16px">
      ${heat ? `<div class="card pane">
        <div class="pane-head"><h3>오더 간 유닛 조합 평균</h3><span class="cap">${seqName(heat.qa)} × ${seqName(heat.qb)}${c.k === 1 ? ' (비교용)' : ''}</span></div>
        <div class="${heat.conds.length === 2 ? 'grid2' : ''}">
          ${heat.conds.map((cd, i) => `<div>${cd ? `<h4 style="margin:0;font-size:12px;font-weight:600;color:var(--ink-2)">${condLabel(cd)}</h4>` : ''}<div class="dchart" id="d-heat-${i}"></div></div>`).join('')}
        </div>
      </div>` : ''}
      <div class="card pane">
        <div class="pane-head"><h3>시간 추이</h3><span class="cap">가로 = 랏 투입 순서</span></div>
        <div class="dchart" id="d-time"></div>
      </div>
    </div>`;

  const charts = [];
  const mk = (id) => {
    const node = el.querySelector('#' + id);
    const ch = echarts.init(node);
    charts.push(ch);
    return ch;
  };
  const ax = axisStyle(C);

  // 1) 웨이퍼 분포: 가로 상자그림 + 점
  {
    const groups = [{ label: '이 경로', idx: me, color: C.bad }];
    if (c.k >= 2) c.items.forEach(([q], i) => groups.push({ label: `${seqName(q)}만 다른 유닛`, idx: parents[i], color: C.ink2 }));
    groups.push({ label: '나머지 웨이퍼', idx: others, color: C.ink3 });
    const sums = groups.map((g) => summary(data.Y, g.idx));
    const lo = Math.min(...sums.map((s) => s.p01)), hi = Math.max(...sums.map((s) => s.p99));
    const rng = makeRng(31 + c.id);
    const series = groups.map((g, gi) => {
      const step = Math.max(1, Math.ceil(g.idx.length / 500));
      const pts = [];
      for (let i = 0; i < g.idx.length; i += step) pts.push([data.Y[g.idx[i]], gi + (rng.u() - 0.5) * 0.5]);
      return { type: 'scatter', data: pts, symbolSize: 3, itemStyle: { color: g.color, opacity: gi === 0 ? 0.45 : 0.2 }, silent: true, z: 1 };
    });
    series.push({
      type: 'custom', z: 3,
      encode: { x: [1, 2, 3, 4, 5], y: 0 },
      data: sums.map((s, i) => [i, s.lo, s.q1, s.med, s.q3, s.hi]),
      renderItem: (p, api) => {
        const i = api.value(0);
        const y = api.coord([0, i])[1];
        const h = Math.abs(api.size([0, 1])[1]) * 0.46;
        const X = (v) => api.coord([v, i])[0];
        const col = groups[i].color;
        const [wl, q1, md, q3, wh] = [1, 2, 3, 4, 5].map((k) => api.value(k));
        return {
          type: 'group',
          children: [
            { type: 'line', shape: { x1: X(wl), y1: y, x2: X(wh), y2: y }, style: { stroke: col, lineWidth: 1.2 } },
            { type: 'rect', shape: { x: X(q1), y: y - h / 2, width: X(q3) - X(q1), height: h, r: 4 }, style: { fill: col, opacity: 0.16 } },
            { type: 'rect', shape: { x: X(q1), y: y - h / 2, width: X(q3) - X(q1), height: h, r: 4 }, style: { fill: 'none', stroke: col, lineWidth: 1.4 } },
            { type: 'line', shape: { x1: X(md), y1: y - h / 2, x2: X(md), y2: y + h / 2 }, style: { stroke: col, lineWidth: 2.5 } },
          ],
        };
      },
      tooltip: {
        formatter: (p) => {
          const s = sums[p.value[0]];
          return `<b>${groups[p.value[0]].label}</b><br>웨이퍼 ${fmtInt(s.n)}장<br>평균 ${fmt(s.mean)}% · 중앙값 ${fmt(s.med)}%`;
        },
      },
    });
    series.push({
      type: 'scatter', z: 4, symbol: 'diamond', symbolSize: 11,
      data: sums.map((s, i) => ({ value: [s.mean, i], itemStyle: { color: groups[i].color, borderColor: C.surface, borderWidth: 1.5 } })),
      label: { show: true, position: 'top', distance: 4, formatter: (p) => fmt(p.value[0]), color: C.ink, fontSize: 11, fontWeight: 600 },
      markLine: { silent: true, symbol: 'none', label: { show: false }, lineStyle: { color: C.ink3, type: 'dashed' }, data: [{ xAxis: res.mu }] },
      tooltip: { formatter: (p) => `${groups[p.value[1]].label} 평균 ${fmt(p.value[0])}%` },
    });
    mk('d-dist').setOption({
      animation: false,
      grid: { left: 110, right: 16, top: 12, bottom: 36 },
      tooltip: { ...tip(C), trigger: 'item' },
      xAxis: { type: 'value', min: Math.floor(lo * 10) / 10, max: Math.ceil(hi * 10) / 10, name: '웨이퍼 불량률 (%)', nameLocation: 'middle', nameGap: 24, ...ax, axisLabel: { ...ax.axisLabel, showMinLabel: false, showMaxLabel: false } },
      yAxis: labelAxes(groups.map((g) => g.label), C, 12),
      series,
    });
  }

  // 2) 무작위 비교 히스토그램
  {
    const se = res.sd / Math.sqrt(c.n);
    const cut = res.mu + thr * se;
    let lo = Infinity, hi = -Infinity;
    for (const v of sims) { if (v < lo) lo = v; if (v > hi) hi = v; }
    const top = Math.max(hi, c.mean, cut);
    const bins = 40, w = (hi - lo) / bins || 1e-3;
    const counts = new Array(bins).fill(0);
    for (const v of sims) counts[Math.min(bins - 1, Math.floor((v - lo) / w))]++;
    const pad = (top - lo) * 0.06;
    mk('d-perm').setOption({
      animation: false,
      grid: { left: 40, right: 20, top: 28, bottom: 36 },
      tooltip: { ...tip(C), trigger: 'item' },
      xAxis: { type: 'value', min: lo - pad, max: top + pad, name: `${fmtInt(c.n)}장 평균 (%)`, nameLocation: 'middle', nameGap: 24, splitNumber: 5, ...ax, axisLabel: { ...ax.axisLabel, hideOverlap: true, showMinLabel: false, showMaxLabel: false, formatter: (v) => v.toFixed(2) } },
      yAxis: { type: 'value', ...ax, axisLabel: { show: false }, splitLine: { show: false } },
      series: [{
        type: 'custom', silent: true,
        encode: { x: [0, 1], y: 2 },
        data: counts.map((n, i) => [lo + i * w, lo + (i + 1) * w, n]),
        renderItem: (p, api) => {
          const a = api.coord([api.value(0), api.value(2)]), b = api.coord([api.value(1), 0]);
          return { type: 'rect', shape: { x: a[0] + 0.5, y: a[1], width: Math.max(1, b[0] - a[0] - 1), height: b[1] - a[1], r: [2, 2, 0, 0] }, style: { fill: C.dot } };
        },
        markLine: {
          silent: true, symbol: 'none',
          data: [
            { xAxis: cut, lineStyle: { color: C.ink2, type: 'dashed', width: 1.2 }, label: { formatter: '보정 기준', color: C.ink2, fontSize: 11, position: 'end' } },
            { xAxis: c.mean, lineStyle: { color: C.bad, width: 2.5 }, label: { formatter: `이 경로 ${fmt(c.mean)}`, color: C.bad, fontSize: 11, fontWeight: 600, position: 'end' } },
          ],
        },
      }],
    });
  }

  // 3) 오더별 유닛 평균 ± 95% CI
  {
    const box = el.querySelector('#d-units');
    box.innerHTML = c.items.map(([q], i) => {
      const an = res.seqInfo[c.step][q].anova;
      const p = an ? `<span class="${an.p < 0.05 ? 'sig' : ''}">유닛 간 p ${fmtP(an.p)}</span>` : '';
      return `<div><h4>${seqName(q)}${p}</h4><div class="dchart" id="d-unit-${i}" style="height:${46 + st.seqs[q].units.length * 24}px"></div></div>`;
    }).join('');
    c.items.forEach(([q, u], i) => {
      const units = res.seqInfo[c.step][q].units;
      const rows = units.map((x, ui) => {
        const h = 1.96 * (x.sd / Math.sqrt(Math.max(1, x.n)));
        return [x.mean, ui, x.mean - h, x.mean + h];
      });
      const lo = Math.min(...rows.map((r) => r[2]), res.mu), hi = Math.max(...rows.map((r) => r[3]), res.mu);
      const pad = (hi - lo) * 0.08;
      mk(`d-unit-${i}`).setOption({
        animation: false,
        grid: { left: 64, right: 14, top: 6, bottom: 28 },
        tooltip: { ...tip(C), trigger: 'item', formatter: (p) => { const x = units[p.value[1]]; return `<b>${x.name}</b><br>웨이퍼 ${fmtInt(x.n)}장<br>평균 ${fmt(x.mean)}%`; } },
        xAxis: { type: 'value', min: lo - pad, max: hi + pad, splitNumber: 3, ...ax, axisLabel: { ...ax.axisLabel, hideOverlap: true, showMinLabel: false, showMaxLabel: false, formatter: (v) => v.toFixed(2) } },
        yAxis: labelAxes(units.map((x) => x.name), C, 11),
        series: [
          {
            type: 'custom', silent: true,
            encode: { x: [2, 3], y: 1 },
            data: rows,
            renderItem: (p, api) => {
              const a = api.coord([api.value(2), api.value(1)]), b = api.coord([api.value(3), api.value(1)]);
              return { type: 'line', shape: { x1: a[0], y1: a[1], x2: b[0], y2: b[1] }, style: { stroke: api.value(1) === u ? C.bad : C.ink3, lineWidth: 2, lineCap: 'round' } };
            },
          },
          {
            type: 'scatter', symbolSize: (v) => (v[1] === u ? 11 : 8),
            data: rows.map((r) => ({ value: [r[0], r[1]], itemStyle: { color: r[1] === u ? C.bad : C.ink2 } })),
            markLine: { silent: true, symbol: 'none', label: { show: false }, lineStyle: { color: C.ink3, type: 'dashed' }, data: [{ xAxis: res.mu }] },
          },
        ],
      });
    });
  }

  // 4) 오더 간 유닛 조합 히트맵
  if (heat) {
    const ua = st.seqs[heat.qa].units, ub = st.seqs[heat.qb].units;
    const grids = heat.conds.map((cd) => cellMeans(data, c.step, heat.qa, heat.qb, cd));
    let span = 0.05;
    for (const g of grids) for (let k = 0; k < g.n.length; k++) if (g.n[k] >= 5) span = Math.max(span, Math.abs(g.sum[k] / g.n[k] - res.mu));
    grids.forEach((g, gi) => {
      const cells = [];
      for (let a = 0; a < g.ua; a++) for (let b = 0; b < g.ub; b++) {
        const k = a * g.ub + b;
        const hitCell = a === heat.ua && (heat.ub < 0 || b === heat.ub) && (!heat.conds[gi] || heat.conds[gi].eq);
        cells.push({
          value: [a, b, g.n[k] >= 5 ? +(g.sum[k] / g.n[k]).toFixed(3) : '-', g.n[k]],
          itemStyle: hitCell ? { borderColor: C.ink, borderWidth: 2 } : { borderColor: C.surface, borderWidth: 2 },
        });
      }
      const node = el.querySelector(`#d-heat-${gi}`);
      node.style.height = `${Math.max(180, 70 + ub.length * 30)}px`;
      mk(`d-heat-${gi}`).setOption({
        animation: false,
        grid: { left: 64, right: 10, top: 8, bottom: 44 },
        tooltip: { ...tip(C), trigger: 'item', formatter: (p) => `${seqName(heat.qa)} ${ua[p.value[0]]} × ${seqName(heat.qb)} ${ub[p.value[1]]}<br>웨이퍼 ${fmtInt(p.value[3])}장 · 평균 ${p.value[2] === '-' ? '–' : fmt(p.value[2])}%` },
        xAxis: { type: 'category', data: ua, name: seqName(heat.qa), nameLocation: 'middle', nameGap: 26, ...ax, splitLine: { show: false }, axisLabel: { color: C.ink, fontSize: 11 } },
        yAxis: { type: 'category', data: ub, name: seqName(heat.qb), nameLocation: 'middle', nameGap: 50, inverse: true, ...ax, splitLine: { show: false }, axisLabel: { color: C.ink, fontSize: 11 } },
        visualMap: { show: false, min: res.mu - span, max: res.mu + span, dimension: 2, inRange: { color: [C.low, C.fill, C.bad] } },
        series: [{
          type: 'heatmap', data: cells,
          label: { show: g.ua * g.ub <= 64, formatter: (p) => (p.value[2] === '-' ? '' : fmt(p.value[2])), fontSize: 10, color: C.ink },
        }],
      });
    });
  }

  // 5) 시간 추이
  {
    const allX = pool.slice().sort((a, b) => a - b);
    const allRoll = rolling(allX, allX.map((w) => data.Y[w]), 250).filter((_, i) => i % 10 === 0);
    const meY = me.map((w) => data.Y[w]);
    const win = Math.max(8, Math.min(60, Math.round(me.length / 8)));
    const meRoll = rolling(me, meY, win);
    const lotOf = (w) => Math.floor(w / data.cfg.waferPerLot) + 1;
    const all = [...allRoll.map((p) => p[1]), ...meRoll.map((p) => p[1])];
    mk('d-time').setOption({
      animation: false,
      grid: { left: 40, right: 16, top: 16, bottom: 36 },
      tooltip: { ...tip(C), trigger: 'axis', formatter: (ps) => `랏 ${lotOf(ps[0].value[0])}<br>` + ps.filter((p) => p.seriesIndex > 0).map((p) => `${p.seriesName} ${fmt(p.value[1])}%`).join('<br>') },
      xAxis: { type: 'value', min: 0, max: data.N, name: '랏 투입 순서', nameLocation: 'middle', nameGap: 24, ...ax, axisLabel: { ...ax.axisLabel, formatter: (v) => `L${lotOf(Math.min(v, data.N - 1))}` } },
      yAxis: { type: 'value', scale: true, min: Math.floor(Math.min(...all, res.mu) * 20) / 20 - 0.1, max: Math.ceil(Math.max(...all) * 20) / 20 + 0.1, ...ax },
      series: [
        { type: 'scatter', name: '이 경로 웨이퍼', data: me.map((w, i) => [w, meY[i]]), symbolSize: 3, itemStyle: { color: C.bad, opacity: 0.25 }, silent: true },
        { type: 'line', name: '전체 이동평균', data: allRoll, symbol: 'none', lineStyle: { color: C.ink3, width: 2 } },
        { type: 'line', name: '이 경로 이동평균', data: meRoll, symbol: 'none', lineStyle: { color: C.bad, width: 2.5 } },
      ],
    });
  }

  return charts;
}
