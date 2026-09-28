// 코드 Task 2~4
//   2. 입력값 정리(형식 확인, 중복·결측 제거) + 설비 진행 이력 결합 (lot·wafer 기준)
//   3. 스텝별 order·unit 조합 생성 + bad wafer가 유의하게 몰린 불량 조합 판정
//   4. 불량 조합 unit의 FDC 유의차 계산
//        - order 2개 이상 조합: 불량 경로 wafer vs 같은 unit의 나머지 wafer
//        - unit 1개 조합: 같은 unit의 bad wafer vs good wafer
//
// 실행: node scripts/run_analysis.mjs [--input 붙여넣기.txt] [--history 설비진행이력.csv] [--fdc FDC요약.csv] [--out output]
// 결과: output/analysis.json (조합 분석·차트 데이터·Router 분기), output/fdc/조합ID.json (불량 조합별 FDC 유의차)

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { analyze, thresholds, classify, buildMembers, MISSING, Z998 } from './lib/analysis.mjs';
import { welch, tSf, bhQ } from './lib/stats.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const INPUT = arg('input', join(ROOT, 'data', '불량wafer_측정값.txt'));
const HISTORY = arg('history', join(ROOT, 'data', '설비진행이력.csv'));
const FDC = arg('fdc', join(ROOT, 'data', 'FDC요약.csv'));
const OUT = arg('out', join(ROOT, 'output'));
const MIN_N = 20;
const SIG = { q: 0.01, d: 0.8 }; // FDC 유의 기준: q < 0.01 그리고 |효과 크기| ≥ 0.8

const r3 = (x) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null);
const normWafer = (w) => (/^\d+$/.test(w) ? String(+w).padStart(2, '0') : w);
const keyOf = (lot, wf) => `${lot.trim()}|${normWafer(wf.trim())}`;

// ---------- Task 2: 입력 정리 ----------

function parseInput(text) {
  const rows = [], invalid = [];
  const seen = new Set();
  let duplicates = 0;
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  lines.forEach((line, i) => {
    const cols = line.split(/\t|,|\s+/).filter((s) => s !== '');
    if (i === 0 && cols.length >= 3 && !Number.isFinite(+cols[2])) return; // 헤더
    if (cols.length < 4) { invalid.push({ line: i + 1, reason: '열 부족 (lot, wafer, value, good/bad 필요)' }); return; }
    const [lot, wf, v, gb] = cols;
    const value = +v;
    const label = /^(bad|b|ng|불량|1)$/i.test(gb) ? 1 : /^(good|g|ok|양품|0)$/i.test(gb) ? 0 : null;
    if (!Number.isFinite(value)) { invalid.push({ line: i + 1, reason: `value가 숫자가 아님: ${v}` }); return; }
    if (label === null) { invalid.push({ line: i + 1, reason: `good/bad 값을 알 수 없음: ${gb}` }); return; }
    const key = keyOf(lot, wf);
    if (seen.has(key)) { duplicates++; return; }
    seen.add(key);
    rows.push({ key, lot: lot.trim(), wafer: normWafer(wf.trim()), value, bad: label });
  });
  return { rows, invalid, duplicates, lines: lines.length };
}

const input = parseInput(readFileSync(INPUT, 'utf8'));

// 설비 진행 이력 결합
const histLines = readFileSync(HISTORY, 'utf8').split(/\r?\n/);
const hHead = histLines[0].split(',');
const H = Object.fromEntries(hHead.map((h, i) => [h.trim(), i]));
const hist = [];
const inHistory = new Set();
for (let i = 1; i < histLines.length; i++) {
  if (!histLines[i]) continue;
  const c = histLines[i].split(',');
  const key = keyOf(c[H.lot], c[H.wafer]);
  inHistory.add(key);
  hist.push([key, c[H.step], c[H.order], c[H.unit], c[H.track_in]]);
}
const wafers = input.rows.filter((r) => inHistory.has(r.key));
const unmatched = input.rows.length - wafers.length;
const N = wafers.length;
const idx = new Map(wafers.map((w, i) => [w.key, i]));
const Y = Float64Array.from(wafers, (w) => w.bad);
const V = Float64Array.from(wafers, (w) => w.value);

const ordNum = (o) => +(o.match(/\d+/) || [0])[0];
const stepMap = new Map();
for (const [key, step, order, unit, t] of hist) {
  if (!idx.has(key)) continue;
  if (!stepMap.has(step)) stepMap.set(step, new Map());
  const om = stepMap.get(step);
  if (!om.has(order)) om.set(order, new Map());
  const um = om.get(order);
  if (!um.has(unit)) um.set(unit, um.size);
}
const stepNames = [...stepMap.keys()].sort();
const steps = stepNames.map((name) => {
  const orders = [...stepMap.get(name).keys()].sort((a, b) => ordNum(a) - ordNum(b));
  return {
    name,
    proc: name.split('_').slice(1).join('_') || name,
    seqs: orders.map((o) => ({ name: o, units: [...stepMap.get(name).get(o).keys()] })),
  };
});
const sIdx = new Map(steps.map((s, i) => [s.name, i]));
const qIdx = steps.map((s) => new Map(s.seqs.map((q, i) => [q.name, i])));
const uIdx = steps.map((s) => s.seqs.map((q) => new Map(q.units.map((u, i) => [u, i]))));
const assign = steps.map((s) => s.seqs.map(() => new Uint16Array(N).fill(MISSING)));
const trackIn = steps.map(() => new Array(N).fill(null)); // 스텝별 첫 order 진행 시각
for (const [key, step, order, unit, t] of hist) {
  const w = idx.get(key);
  if (w === undefined) continue;
  const s = sIdx.get(step), q = qIdx[s].get(order);
  assign[s][q][w] = uIdx[s][q].get(unit);
  if (!trackIn[s][w] || t < trackIn[s][w]) trackIn[s][w] = t;
}

// ---------- Task 3: 조합 생성과 불량 조합 판정 ----------

const data = { N, Y, steps, assign };
const res = analyze(data, { minN: MIN_N });
const zk = thresholds(res, 'bonf');
const summary = classify(res, zk);
const members = buildMembers(data, res.combos);
const memberOf = (c) => members.members.subarray(members.offsets[c.id], members.offsets[c.id + 1]);
const meanV = (ids) => { let s = 0; for (const w of ids) s += V[w]; return ids.length ? s / ids.length : NaN; };
const pathOf = (c) => c.items.map(([q, u]) => ({ order: steps[c.step].seqs[q].name, unit: steps[c.step].seqs[q].units[u] }));

const badCombos = res.combos.filter((c) => c.status === 'bad').sort((a, b) => b.z - a.z);
badCombos.forEach((c, i) => (c.cid = `C${i + 1}`));

function valueSummary(ids) {
  const v = Float64Array.from(ids, (w) => V[w]).sort();
  if (!v.length) return null;
  const q = (p) => { const h = (v.length - 1) * p, l = Math.floor(h); return v[l] + (h - l) * (v[Math.min(l + 1, v.length - 1)] - v[l]); };
  let bad = 0;
  for (const w of ids) bad += Y[w];
  const q1 = q(0.25), q3 = q(0.75), iqr = q3 - q1;
  return {
    n: v.length, badRate: r3(bad / v.length), mean: r3(meanV(ids)), q1: r3(q1), median: r3(q(0.5)), q3: r3(q3),
    whiskerLow: r3(Math.max(v[0], q1 - 1.5 * iqr)), whiskerHigh: r3(Math.min(v[v.length - 1], q3 + 1.5 * iqr)),
  };
}

function daily(ids, s) {
  const by = new Map();
  for (const w of ids) {
    const d = (trackIn[s][w] || '').slice(0, 10);
    if (!d) continue;
    if (!by.has(d)) by.set(d, [0, 0, 0]);
    const a = by.get(d);
    a[0]++; a[1] += V[w]; a[2] += Y[w];
  }
  return [...by.entries()].sort().map(([d, [n, sv, sb]]) => ({ date: d, n, meanValue: r3(sv / n), badRate: r3(sb / n) }));
}

function comboDetail(c) {
  const s = c.step, st = steps[s];
  const mem = memberOf(c);
  const inPath = new Uint8Array(N);
  for (const w of mem) inPath[w] = 1;
  const stepWafers = [];
  for (let w = 0; w < N; w++) if (assign[s][0][w] !== MISSING) stepWafers.push(w);
  const groups = [{ name: '이 경로', ...valueSummary(mem) }];
  if (c.k >= 2) {
    c.items.forEach(([q, u], i) => {
      const others = c.items.filter((_, j) => j !== i);
      const ids = stepWafers.filter((w) => !inPath[w] && others.every(([q2, u2]) => assign[s][q2][w] === u2) && assign[s][q][w] !== u);
      groups.push({ name: `${st.seqs[q].name}만 다른 unit`, ...valueSummary(ids) });
    });
  } else {
    const [q, u] = c.items[0];
    groups.push({ name: `${st.seqs[q].name} 다른 unit`, ...valueSummary(stepWafers.filter((w) => assign[s][q][w] !== u)) });
  }
  if (c.k >= 2) groups.push({ name: '나머지 wafer', ...valueSummary(stepWafers.filter((w) => !inPath[w])) });

  const flow = st.seqs.map((sq, q) => {
    const info = res.seqInfo[s][q];
    const units = sq.units.map((name, u) => {
      const ids = stepWafers.filter((w) => assign[s][q][w] === u);
      return { unit: name, n: ids.length, badRate: r3(info.units[u].mean), meanValue: r3(meanV(ids)) };
    });
    return { order: sq.name, units, unitCount: sq.units.length, anovaP: info.anova ? info.anova.p : null };
  });

  return {
    id: c.cid, step: st.name, process: st.proc, k: c.k, path: pathOf(c),
    n: c.n, badCount: Math.round(c.sum), badRate: r3(c.mean), overallBadRate: r3(res.mu),
    meanValue: r3(meanV(mem)), overallMeanValue: r3(meanV([...Array(N).keys()])),
    z: r3(c.z), zThreshold: r3(zk[c.k]), liftP: c.k >= 2 ? c.liftP : null, q: c.q,
    flow, distribution: groups,
    trend: { path: daily(mem, s), all: daily(stepWafers, s) },
  };
}

const details = badCombos.map(comboDetail);

// ---------- Task 4: 불량 조합 unit의 FDC 유의차 ----------

rmSync(join(OUT, 'fdc'), { recursive: true, force: true });
mkdirSync(join(OUT, 'fdc'), { recursive: true });

if (badCombos.length) {
  // 필요한 (step, unit)의 FDC만 읽기
  const need = new Set();
  for (const c of badCombos) for (const p of pathOf(c)) need.add(`${steps[c.step].name}|${p.unit}`);
  const fdc = new Map(); // `${step}|${unit}` → Map(param → { mean: Float64Array, max: Float64Array })
  const fLines = readFileSync(FDC, 'utf8').split(/\r?\n/);
  const F = Object.fromEntries(fLines[0].split(',').map((h, i) => [h.trim(), i]));
  for (let i = 1; i < fLines.length; i++) {
    if (!fLines[i]) continue;
    const c = fLines[i].split(',');
    const su = `${c[F.step]}|${c[F.unit]}`;
    if (!need.has(su)) continue;
    const w = idx.get(keyOf(c[F.lot], c[F.wafer]));
    if (w === undefined) continue;
    if (!fdc.has(su)) fdc.set(su, new Map());
    const pm = fdc.get(su);
    const p = c[F.parameter];
    if (!pm.has(p)) pm.set(p, { mean: new Float64Array(N).fill(NaN), max: new Float64Array(N).fill(NaN) });
    pm.get(p).mean[w] = +c[F.mean];
    pm.get(p).max[w] = +c[F.max];
  }

  const agg = (arr, ids) => {
    const g = { n: 0, sum: 0, ss: 0 };
    for (const w of ids) { const v = arr[w]; if (Number.isFinite(v)) { g.n++; g.sum += v; g.ss += v * v; } }
    return g;
  };

  badCombos.forEach((c, ci) => {
    const s = c.step, st = steps[s];
    const mem = memberOf(c);
    const inPath = new Uint8Array(N);
    for (const w of mem) inPath[w] = 1;
    const single = c.k === 1;
    const tests = [];
    for (const [q, u] of c.items) {
      const unitName = st.seqs[q].units[u];
      const unitW = [];
      for (let w = 0; w < N; w++) if (assign[s][q][w] === u) unitW.push(w);
      const A = single ? unitW.filter((w) => Y[w] === 1) : unitW.filter((w) => inPath[w]);
      const B = single ? unitW.filter((w) => Y[w] === 0) : unitW.filter((w) => !inPath[w]);
      const pm = fdc.get(`${st.name}|${unitName}`) || new Map();
      for (const [param, arrs] of pm) {
        for (const stat of ['mean', 'max']) {
          const a = agg(arrs[stat], A), b = agg(arrs[stat], B);
          if (a.n < 2 || b.n < 2) continue;
          const ma = a.sum / a.n, mb = b.sum / b.n;
          const va = (a.ss - a.sum * ma) / (a.n - 1), vb = (b.ss - b.sum * mb) / (b.n - 1);
          const sp = Math.sqrt(((a.n - 1) * va + (b.n - 1) * vb) / (a.n + b.n - 2));
          const wt = welch(a, b);
          tests.push({
            order: st.seqs[q].name, unit: unitName, parameter: param, stat,
            nA: a.n, nB: b.n, meanA: r3(ma), meanB: r3(mb), diff: r3(ma - mb),
            effectSize: r3(sp > 0 ? (ma - mb) / sp : 0), p: 2 * tSf(Math.abs(wt.t), wt.df),
          });
        }
      }
    }
    const qs = bhQ(tests.map((t) => t.p));
    tests.forEach((t, i) => { t.q = qs[i]; t.significant = t.q < SIG.q && Math.abs(t.effectSize) >= SIG.d; });
    tests.sort((x, y) => Math.abs(y.effectSize) - Math.abs(x.effectSize));

    const d = details[ci];
    const out = {
      id: c.cid, step: st.name, process: st.proc, path: d.path, k: c.k,
      n: c.n, badCount: d.badCount, badRate: d.badRate, overallBadRate: d.overallBadRate,
      meanValue: d.meanValue, overallMeanValue: d.overallMeanValue, z: d.z, zThreshold: d.zThreshold,
      comparison: single
        ? { type: 'bad_vs_good', groupA: `${d.path[0].unit}을 지난 bad wafer`, groupB: `${d.path[0].unit}을 지난 good wafer` }
        : { type: 'path_vs_rest', groupA: '불량 경로를 지난 wafer', groupB: '같은 unit을 지난 나머지 wafer' },
      significance: `q < ${SIG.q} 그리고 |효과 크기| >= ${SIG.d}`,
      fdc: tests,
    };
    writeFileSync(join(OUT, 'fdc', `${c.cid}.json`), JSON.stringify(out, null, 2));
  });
}

// ---------- 분석 결과 (보고서·Router용) ----------

const funnel = res.combos.map((c) => [c.n, r3(c.mean), r3(meanV(memberOf(c))), c.k, c.status, c.status === 'bad' ? c.cid : null]);
const analysis = {
  generatedAt: new Date().toISOString(),
  router: badCombos.length ? 'fdc' : 'report_only',
  input: {
    lines: input.lines, valid: input.rows.length, invalid: input.invalid, duplicates: input.duplicates,
    matched: N, unmatched, matchRate: r3(N / Math.max(1, input.rows.length)),
    bad: Math.round(res.mu * N), good: N - Math.round(res.mu * N),
    overallBadRate: r3(res.mu), overallMeanValue: r3(meanV([...Array(N).keys()])),
  },
  scope: { steps: steps.length, orders: steps.reduce((a, s) => a + s.seqs.length, 0), minN: MIN_N },
  narrowing: {
    combos: res.combos.length, byDepth: res.depthCount.slice(1), rawOver: res.rawOver,
    correctedOver: summary.over, bad: summary.bad, related: summary.inherited + summary.explained,
  },
  thresholds: { raw: Z998, corrected: zk.slice(1).map(r3) },
  funnelColumns: ['n', 'badRate', 'meanValue', 'k', 'status', 'comboId'],
  funnel,
  badCombos: details,
};
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'analysis.json'), JSON.stringify(analysis));

// ---------- 콘솔 요약 ----------
const pct = (x) => (x * 100).toFixed(1) + '%';
console.log(`[Task 2] 입력 ${input.lines}줄 → 유효 ${input.rows.length} (형식 오류 ${input.invalid.length}, 중복 ${input.duplicates}) · 이력 매칭 ${N} (${pct(N / Math.max(1, input.rows.length))}) · bad ${analysis.input.bad} / good ${analysis.input.good}`);
console.log(`[Task 3] 조합 ${res.combos.length} → 99.8% 이탈 ${res.rawOver} → 보정 후 이탈 ${summary.over} → 불량 조합 ${summary.bad} (관련 ${summary.inherited + summary.explained})`);
for (const d of details) console.log(`   ${d.id} ${d.step} ${d.path.map((p) => `${p.order}:${p.unit}`).join(' → ')} · n ${d.n} · bad ${pct(d.badRate)} (전체 ${pct(d.overallBadRate)}) · z ${d.z}`);
console.log(`[Router] ${analysis.router === 'fdc' ? '불량 조합 1건 이상 → FDC 유의차 → 해석' : '불량 조합 0건 → 보고서 작성으로'}`);
if (badCombos.length) {
  for (const c of badCombos) {
    const f = JSON.parse(readFileSync(join(OUT, 'fdc', `${c.cid}.json`), 'utf8'));
    const sig = f.fdc.filter((t) => t.significant);
    console.log(`[Task 4] ${c.cid} (${f.comparison.type}) 유의 ${sig.length}/${f.fdc.length}: ` +
      (sig.slice(0, 4).map((t) => `${t.unit} ${t.parameter}(${t.stat}) ${t.diff > 0 ? '+' : ''}${t.diff} d=${t.effectSize}`).join(', ') || '없음'));
  }
}
console.log(`→ ${join(OUT, 'analysis.json')}${badCombos.length ? `, ${join(OUT, 'fdc')}\\C*.json` : ''}`);
