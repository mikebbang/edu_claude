import { generate } from './mock.js';
import { analyze, thresholds, classify, buildMembers, truthCheck, FWER_ALPHA } from './analysis.js';
import { renderDetail } from './detail.js';

const $ = (id) => document.getElementById(id);
const fmt = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '–');
const fmtInt = (x) => x.toLocaleString('ko-KR');
const signed = (x, d = 2) => (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(d);
const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);

const TAB_LABEL = { 1: '오더 1개', 2: '오더 2개', 3: '오더 3개' };
const TYPE_LABEL = { pair: '오더 2개 조합', single: '단일 유닛', triple: '오더 3개 조합' };
const STATUS_LABEL = { bad: '불량', inherited: '관련 조합 · 상속', explained: '관련 조합 · 하위 기인', warn: '정상 범위', normal: '정상 범위' };
const Y_LABEL = { mean: '평균 불량률 (%)', shrunk: '수축 평균 (%)', resid: '교호작용 잔차 (%p)', z: 'z-score' };
const N_PERM = 100;

const state = {
  seed: 20260928,
  minN: 20,
  env: 'bonf',
  ymode: 'mean',
  tab: 2,
  step: -1,
  logx: true,
  showRel: false,
  selected: null,
  data: null,
  res: null,
  zk: null,
  summary: null,
  permZ: null,
};

let chart = null;
let worker = null;
let detailCharts = [];

function colors() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n) => cs.getPropertyValue(n).trim();
  return {
    ink: v('--ink'), ink2: v('--ink-2'), ink3: v('--ink-3'), line: v('--line'), bad: v('--bad'), low: v('--low'),
    accent: v('--accent'), surface: v('--surface'), fill: v('--fill'), dot: v('--dot'), band: v('--band'), bandEdge: v('--band-edge'),
  };
}

const chipsHtml = (st, c) =>
  c.items.map(([q, u]) => `<span class="chip"><small>${st.seqs[q].name}</small>${st.seqs[q].units[u]}</span>`).join('<span class="plus">→</span>');
const plainPath = (st, c) => c.items.map(([q, u]) => `${st.seqs[q].name} ${st.seqs[q].units[u]}`).join(' → ');

// ---------- 실행 ----------

async function run({ regen }) {
  $('busy').hidden = false;
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30)));
  if (regen || !state.data) {
    state.data = generate(state.seed);
    fillStepSelect();
  }
  state.res = analyze(state.data, { minN: state.minN });
  state.permZ = null;
  stopPerm();
  if (state.env === 'perm') startPerm();
  classifyNow();
  const top = findings()[0];
  state.selected = top ? top.id : null;
  state.tab = top ? top.k : 2;
  renderAll();
  $('busy').hidden = true;
}

function classifyNow() {
  state.zk = thresholds(state.res, state.env, state.permZ);
  state.summary = classify(state.res, state.zk);
}

function renderAll() {
  renderNums();
  renderTabs();
  renderChart();
  renderList();
  renderDetailPane();
  renderTruth();
}

const inScope = (c) => state.step < 0 || c.step === state.step;
const findings = () => state.res.combos.filter((c) => c.status === 'bad' && inScope(c)).sort((a, b) => b.mean - a.mean);
const related = () => state.res.combos.filter((c) => (c.status === 'inherited' || c.status === 'explained') && inScope(c)).sort((a, b) => b.mean - a.mean);

function select(id) {
  if (id == null) return;
  const c = state.res.combos[id];
  state.selected = id;
  if (state.tab !== c.k) {
    state.tab = c.k;
    renderTabs();
  }
  renderChart();
  renderList();
  renderDetailPane();
}

// ---------- 순열 검정 ----------

function stopPerm() {
  if (worker) {
    worker.terminate();
    worker = null;
  }
  $('perm-progress').hidden = true;
}

function startPerm() {
  stopPerm();
  const prog = $('perm-progress');
  prog.hidden = false;
  prog.textContent = '준비 중…';
  const res = state.res;
  setTimeout(() => {
    if (state.res !== res) return;
    const { members, offsets, depth } = buildMembers(state.data, res.combos);
    worker = new Worker(new URL('./permWorker.js', import.meta.url));
    worker.onmessage = (e) => {
      if (state.res !== res) return;
      if (e.data.type === 'progress') prog.textContent = `${e.data.done}/${e.data.total}`;
      else if (e.data.type === 'done') {
        state.permZ = e.data.z;
        prog.textContent = '완료';
        worker.terminate();
        worker = null;
        classifyNow();
        renderAll();
      }
    };
    worker.onerror = () => (prog.textContent = '실패 · 기본 기준 사용');
    worker.postMessage(
      { Y: Float64Array.from(state.data.Y), members, offsets, depth, nPerm: N_PERM, alpha: FWER_ALPHA, seed: state.seed ^ 0x9e3779b9, maxDepth: res.maxDepth },
      [members.buffer, offsets.buffer, depth.buffer],
    );
  }, 30);
}

// ---------- 상단 수치 ----------

function renderNums() {
  const { res, summary } = state;
  const items = [
    [res.combos.length, '조합'],
    [res.rawOver, '99.8% 이탈'],
    [summary.over, '보정 후 이탈'],
    [summary.bad, '불량'],
  ];
  $('nums').innerHTML = items
    .map(([v, t], i) => `${i ? '<span class="arr" aria-hidden="true">›</span>' : ''}<span class="${i === 3 ? 'last' : ''}"><b>${fmtInt(v)}</b>${t}</span>`)
    .join('');
}

// ---------- Funnel ----------

function renderTabs() {
  const counts = [0, 0, 0, 0];
  for (const c of state.res.combos) if (c.status === 'bad' && inScope(c)) counts[c.k]++;
  $('depth-tabs').innerHTML = [1, 2, 3]
    .map((k) => `<button type="button" role="tab" data-k="${k}" aria-selected="${state.tab === k}">${TAB_LABEL[k]}<span class="badge ${counts[k] ? '' : 'zero'}">${counts[k]}</span></button>`)
    .join('');
  $('key-rel').hidden = !state.showRel;
}

function yOf(c) {
  if (state.ymode === 'shrunk') return c.shrunk;
  if (state.ymode === 'resid') return c.resid;
  if (state.ymode === 'z') return c.z;
  return c.mean;
}

function envAt(n, z) {
  const { mu, sd, kappa } = state.res;
  const se = sd / Math.sqrt(n);
  if (state.ymode === 'shrunk') return [mu, (n / (n + kappa)) * z * se];
  if (state.ymode === 'resid') return [0, z * se];
  if (state.ymode === 'z') return [0, z];
  return [mu, z * se];
}

function renderChart() {
  if (!chart) chart = echarts.init($('chart'));
  const C = colors();
  const { res, zk } = state;
  const k = state.tab;
  const vis = res.combos.filter((c) => c.k === k && inScope(c));

  const normal = [], bad = [], rel = [];
  let nMin = Infinity, nMax = 0;
  for (const c of vis) {
    if (c.n < nMin) nMin = c.n;
    if (c.n > nMax) nMax = c.n;
    if (c.status === 'bad') bad.push(c);
    else if (c.over && state.showRel) rel.push(c);
    else normal.push([c.n, yOf(c), c.id]);
  }
  if (!vis.length) { nMin = state.minN; nMax = 5000; }
  const lo = Math.max(2, nMin * 0.9), hi = nMax * 1.1;
  const grid = Array.from({ length: 80 }, (_, i) => lo * Math.pow(hi / lo, i / 79));
  const upper = grid.map((n) => { const [c0, h] = envAt(n, zk[k]); return [n, c0 + h]; });
  const lower = grid.map((n) => { const [c0, h] = envAt(n, zk[k]); return [n, c0 - h]; });
  const center = envAt(grid[0], 0)[0];
  const edge = (data) => ({ type: 'line', data, symbol: 'none', silent: true, z: 2, lineStyle: { color: C.bandEdge, width: 1 } });
  const sel = state.selected != null ? res.combos[state.selected] : null;

  const series = [
    {
      type: 'custom', silent: true, z: 1, clip: true,
      data: [[grid[0], center]],
      renderItem: (params, api) => ({
        type: 'polygon',
        shape: { points: upper.map((p) => api.coord(p)).concat(lower.slice().reverse().map((p) => api.coord(p))) },
        style: { fill: C.band },
      }),
    },
    edge(upper),
    edge(lower),
    { type: 'line', data: [[lo, center], [hi, center]], symbol: 'none', silent: true, z: 2, lineStyle: { color: C.bandEdge, width: 1, type: 'dashed' } },
    { type: 'scatter', data: normal, large: true, largeThreshold: 2000, z: 3, symbolSize: k === 1 ? 6 : 4, itemStyle: { color: C.dot, opacity: k === 1 ? 0.8 : 0.55 } },
    { type: 'scatter', z: 4, data: rel.map((c) => [c.n, yOf(c), c.id]), symbolSize: 9, itemStyle: { color: 'rgba(0,0,0,0)', borderColor: C.bad, borderWidth: 1.5, opacity: 0.8 } },
    {
      type: 'scatter', z: 5,
      data: bad.map((c) => ({ value: [c.n, yOf(c), c.id], label: { show: true, formatter: state.data.steps[c.step].name } })),
      symbolSize: 12, itemStyle: { color: C.bad, borderColor: C.surface, borderWidth: 2 },
      label: { position: 'right', distance: 5, color: C.ink, fontSize: 11, fontWeight: 600 },
      emphasis: { scale: 1.3 },
    },
  ];
  if (sel && sel.k === k && inScope(sel)) {
    series.push({ type: 'scatter', silent: true, z: 6, data: [[sel.n, yOf(sel), sel.id]], symbolSize: 24, itemStyle: { color: 'rgba(0,0,0,0)', borderColor: C.accent, borderWidth: 2.5 } });
  }

  const axis = {
    axisLine: { show: false }, axisTick: { show: false },
    axisLabel: { color: C.ink2, fontSize: 11 },
    splitLine: { lineStyle: { color: C.line } },
    nameTextStyle: { color: C.ink2, fontSize: 12 },
  };
  chart.setOption({
    animation: false,
    grid: { left: 48, right: 64, top: 26, bottom: 44 },
    tooltip: {
      trigger: 'item', confine: true, borderWidth: 0, padding: [8, 10],
      backgroundColor: C.surface, textStyle: { color: C.ink, fontSize: 12 },
      extraCssText: 'border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.14);',
      formatter: (p) => {
        const id = p.value && p.value[2];
        if (id == null) return '';
        const c = res.combos[id];
        const st = state.data.steps[c.step];
        return `<b>${st.name}</b> · ${STATUS_LABEL[c.status]}<br>${esc(plainPath(st, c))}<br><span style="opacity:.7">웨이퍼 ${fmtInt(c.n)}장 · 평균 ${fmt(c.mean)}% (${signed(c.mean - res.mu)}%p)</span>`;
      },
    },
    xAxis: { type: state.logx ? 'log' : 'value', name: '웨이퍼 수', nameLocation: 'middle', nameGap: 28, min: state.logx ? undefined : 0, ...axis },
    yAxis: { type: 'value', name: Y_LABEL[state.ymode], scale: true, nameGap: 12, ...axis },
    series,
  }, { notMerge: true });
}

// ---------- 목록 ----------

function rowHtml(c, i, isRel) {
  const st = state.data.steps[c.step];
  return `<button type="button" class="row ${isRel ? 'rel' : ''} ${c.id === state.selected ? 'sel' : ''}" data-id="${c.id}">
    <span class="rk">${isRel ? '·' : i + 1}</span>
    <span class="w"><span class="st">${st.name}<small>${st.proc} · ${TAB_LABEL[c.k]}</small></span><span class="chips">${chipsHtml(st, c)}</span></span>
    <span class="d"><b>${signed(c.mean - state.res.mu)}</b><span>%p · ${fmtInt(c.n)}장</span></span>
  </button>`;
}

function renderList() {
  const list = findings();
  $('findings-sub').textContent = list.length ? '평균 차이 순 · ↑↓로 이동' : '현재 기준에서 불량 조합 없음';
  let html = list.map((c, i) => rowHtml(c, i, false)).join('');
  if (state.showRel) {
    const rel = related();
    if (rel.length) html += `<div class="grp">관련 조합 ${rel.length}개</div>` + rel.map((c) => rowHtml(c, 0, true)).join('');
  }
  $('findings').innerHTML = html;
}

// ---------- 상세 ----------

function renderDetailPane() {
  detailCharts.forEach((ch) => ch.dispose());
  const c = state.selected != null ? state.res.combos[state.selected] : null;
  detailCharts = renderDetail($('detail'), { data: state.data, res: state.res, zk: state.zk, c, C: colors(), statusLabel: STATUS_LABEL });
}

function renderTruth() {
  const { data, res } = state;
  const tc = truthCheck(data, res);
  const hit = tc.filter((t) => t.status === 'bad').length;
  $('truth-line').textContent = `mock 정답 확인: 심어 둔 불량 ${tc.length}개 중 ${hit}개 탐지 (${tc.map((t) => `${TYPE_LABEL[t.effect.type]} ${data.steps[t.effect.step].name}${t.status === 'bad' ? '' : ' 놓침'}`).join(', ')}).`;
}

function fillStepSelect() {
  $('step').innerHTML = '<option value="-1">전체 스텝</option>' +
    state.data.steps.map((s, i) => `<option value="${i}">${s.name} · ${s.proc} · 오더 ${s.seqs.length}</option>`).join('');
  state.step = -1;
}

// ---------- 이벤트 ----------

$('depth-tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-k]');
  if (!b) return;
  state.tab = Number(b.dataset.k);
  renderTabs();
  renderChart();
});
$('findings').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-id]');
  if (b) select(Number(b.dataset.id));
});
$('showrel').addEventListener('change', (e) => {
  state.showRel = e.target.checked;
  renderTabs();
  renderChart();
  renderList();
});
$('env').addEventListener('change', (e) => {
  state.env = e.target.value;
  if (state.env === 'perm' && !state.permZ && !worker) startPerm();
  classifyNow();
  renderAll();
});
$('ymode').addEventListener('change', (e) => { state.ymode = e.target.value; renderChart(); });
$('step').addEventListener('change', (e) => {
  state.step = Number(e.target.value);
  const top = findings()[0];
  if (top) { state.selected = top.id; state.tab = top.k; }
  renderAll();
});
$('minn').addEventListener('input', (e) => { $('minn-v').textContent = e.target.value; });
$('minn').addEventListener('change', (e) => { state.minN = Number(e.target.value); run({ regen: false }); });
$('logx').addEventListener('change', (e) => { state.logx = e.target.checked; renderChart(); });
$('regen').addEventListener('click', () => { state.seed = Number($('seed').value) || 1; run({ regen: true }); });
$('seed').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('regen').click(); });
$('shuffle').addEventListener('click', () => {
  state.seed = Math.floor(Math.random() * 1e8);
  $('seed').value = state.seed;
  run({ regen: true });
});

// 목록에서 ↑↓로 이동
document.addEventListener('keydown', (e) => {
  if (!['ArrowUp', 'ArrowDown'].includes(e.key) || e.target.closest('input, select')) return;
  const ids = [...document.querySelectorAll('#findings .row')].map((b) => Number(b.dataset.id));
  if (!ids.length) return;
  const i = ids.indexOf(state.selected);
  const next = ids[Math.max(0, Math.min(ids.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
  if (next !== state.selected) {
    e.preventDefault();
    select(next);
    document.querySelector(`#findings .row[data-id="${next}"]`)?.focus();
  }
});

let resizeT = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeT);
  resizeT = setTimeout(() => {
    chart && chart.resize();
    detailCharts.forEach((ch) => ch.resize());
  }, 100);
});
const rerenderTheme = () => { if (state.res) { renderChart(); renderDetailPane(); } };
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', rerenderTheme);
new MutationObserver(rerenderTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

chart = echarts.init($('chart'));
chart.on('click', (p) => {
  const id = p.value && p.value[2];
  if (id != null) select(id);
});
run({ regen: true });
