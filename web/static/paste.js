'use strict';
// 웨이퍼 값 붙여넣기: 엑셀에서 ROOT_LOT_ID · WAFER_ID · Y_VALUE · GOOD_BAD(+ 시간 열 · 범례용 열)를 복사해 Ctrl+V.
// 같은 웨이퍼가 여러 줄이면 시간 열이 있을 때 처음 · 마지막 줄, 없을 때 평균 · 최소 · 최대로 합친다. 붙여넣은 GOOD_BAD가 우선이고,
// 더 조정하고 싶으면 UD를 켜서(표 옆 산점도) 가로선 · 위 막대로 good/bad를 다시 정한다(가운데 none 구간은 켤 때만).
// UD에서 바꾼 표시는 표의 GOOD_BAD에 바로 들어간다. 분석 실행(DB 이력 조회)은 DB 함수를 연결한 뒤에

const PM_ROLES = [                                     // [역할, 표에 쓰는 이름, 알아보는 열 이름(소문자 · 기호 뺌)]
  ['lot', 'ROOT_LOT_ID', ['rootlotid', 'rootlot', 'lotid', 'lot']],
  ['wafer', 'WAFER_ID', ['waferid', 'wafer', 'wf', 'waferno', 'slot']],
  ['y', 'Y_VALUE', ['yvalue', 'value', 'y', 'val']],
  ['gb', 'GOOD_BAD', ['goodbad', 'gb', 'judge', 'result']],
];
const PM_TIME = ['tkintime', 'trackintime', 'time', 'datetime', 'date', 'tkin', 'tkouttime', 'eventtime'];
const PM_ROW = 24;                                     // 표 한 줄 높이(px). 보이는 줄만 그려서 몇만 줄도 스크롤로 본다
const PM_MAX_CAT = 12;                                 // 범례에 늘어놓는 묶음 수 (넘으면 웨이퍼가 많은 순으로 11개 + 외 n개)
const PM = { head: [], roles: [], rows: [], dup: null, ud: null, udOn: false, split: null, colW: {}, autoW: {},
  cache: null, eff: null, win: [-1, -1], brush: null, sel: null, geo: null };
const PM_I = {                                         // 그림 (단추 그림은 index.html에)
  ud: '<svg class="ico-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4v16h16"/><circle cx="8.5" cy="14.5" r="1.3"/><circle cx="12" cy="10" r="1.3"/><circle cx="15.5" cy="13" r="1.3"/><circle cx="18" cy="7.5" r="1.3"/><path d="M6 11.5h14" stroke-dasharray="2 2"/></svg>',
  close: '<svg class="ico-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  dirHigh: '<svg class="ico-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M7 10l5-5 5 5"/></svg>',
  dirLow: '<svg class="ico-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M7 14l5 5 5-5"/></svg>',
  first: '<svg class="ico-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5v14"/><path d="M18 6l-8 6 8 6z" fill="currentColor"/></svg>',
  last: '<svg class="ico-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 5v14"/><path d="M6 6l8 6-8 6z" fill="currentColor"/></svg>',
  time: '<svg class="ico-sm" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 7.5V12l3 2"/></svg>',
  tag: '<svg class="ico-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h7.5L20 12.5 12.5 20 4 11.5z"/><circle cx="8" cy="8" r="1.2"/></svg>',
  warn: '<svg class="ico-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4 21 19.5H3z"/><path d="M12 10v4.5M12 17v.1"/></svg>',
};

// ── 읽기: 붙여넣은 글자 → 열 이름 · 역할 · 줄 ─────────────────────────────────────
const pmNorm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const pmNum = (s) => { const v = String(s ?? '').replace(/,/g, '').trim(); if (v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : NaN; };
const pmGb = (s) => { const v = String(s ?? '').trim().toUpperCase(); return ['B', 'BAD', 'NG', 'FAIL', '1'].includes(v) ? 'B' : ['G', 'GOOD', 'OK', 'PASS', '0'].includes(v) ? 'G' : 'N'; };
function pmTime(s) {                                   // 2026-09-29 13:45(:30) · 2026/09/29 · 2026.09.29 · 20260929134530 (시각은 적힌 그대로 = UTC로 다룸)
  const v = String(s ?? '').trim();
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(v);
  if (!m) m = /^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2})?)?$/.exec(v);
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  return Number.isFinite(t) ? t : null;
}

function pmParse(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n').filter((l) => l.trim() !== '');
  if (!lines.length) return null;
  const sep = lines[0].includes('\t') ? '\t' : lines[0].includes(',') ? ',' : /\s+/;   // 엑셀에서 복사하면 탭
  const cells = lines.map((l) => l.split(sep).map((c) => c.trim()));
  const width = cells.reduce((a, r) => Math.max(a, r.length), 0);
  const known = (c) => PM_ROLES.some(([, , names]) => names.includes(pmNorm(c))) || PM_TIME.includes(pmNorm(c));
  const hasHead = cells[0].some(known);
  const head = hasHead ? cells[0].slice() : [];
  const rows = (hasHead ? cells.slice(1) : cells).map((r) => Array.from({ length: width }, (_, j) => r[j] ?? ''));
  while (head.length < width) head.push('');
  const roles = new Array(width).fill('extra');
  if (hasHead) {
    for (const [role, , names] of PM_ROLES) {
      const j = head.findIndex((h, k) => roles[k] === 'extra' && names.includes(pmNorm(h)));
      if (j >= 0) roles[j] = role;
    }
  } else {                                             // 열 이름이 없으면 왼쪽부터 ROOT_LOT_ID · WAFER_ID · Y_VALUE · GOOD_BAD
    PM_ROLES.forEach(([role], j) => { if (j < width) roles[j] = role; });
  }
  const tj = roles.findIndex((r, j) => r === 'extra' && (PM_TIME.includes(pmNorm(head[j])) || pmMostly(rows, j, (v) => pmTime(v) != null)));
  if (tj >= 0) roles[tj] = 'time';
  head.forEach((h, j) => {
    const r = PM_ROLES.find(([role]) => role === roles[j]);
    if (r) head[j] = r[1];
    else if (!h) head[j] = roles[j] === 'time' ? 'TIME' : `COL${j + 1}`;
  });
  return { head, roles, rows };
}
const pmMostly = (rows, j, ok) => { const v = rows.map((r) => r[j]).filter((x) => x !== ''); return v.length > 0 && v.filter(ok).length >= v.length * 0.8; };
const pmCol = (role) => PM.roles.indexOf(role);

// ── 웨이퍼로 합치기 (중복: 시간 열이 있으면 처음 · 마지막 줄, 없으면 평균 · 최소 · 최대) ─────────────
function pmData() {
  if (PM.cache) return PM.cache;
  const [cl, cw, cy, cg, ct] = ['lot', 'wafer', 'y', 'gb', 'time'].map(pmCol);
  const extras = PM.roles.map((r, j) => (r === 'extra' ? j : -1)).filter((j) => j >= 0);
  const miss = [cl < 0 && 'ROOT_LOT_ID', cw < 0 && 'WAFER_ID', cy < 0 && 'Y_VALUE'].filter(Boolean);
  const bad = new Set();                               // 고칠 칸 "줄,열"
  const by = new Map();
  const rowKey = new Array(PM.rows.length).fill(null); // 줄 → 웨이퍼
  PM.rows.forEach((r, i) => {
    const lot = cl >= 0 ? r[cl] : '';
    const wf = cw >= 0 ? r[cw] : '';
    const y = cy >= 0 ? pmNum(r[cy]) : null;
    const t = ct >= 0 ? pmTime(r[ct]) : null;
    let ok = !miss.length;
    if (cl >= 0 && !lot) { bad.add(`${i},${cl}`); ok = false; }
    if (cw >= 0 && !wf) { bad.add(`${i},${cw}`); ok = false; }
    if (cy >= 0 && (y == null || Number.isNaN(y))) { bad.add(`${i},${cy}`); ok = false; }
    if (ct >= 0 && r[ct] !== '' && t == null) bad.add(`${i},${ct}`);
    if (!ok) return;
    const key = lot + '\u0001' + wf;
    rowKey[i] = key;
    if (!by.has(key)) by.set(key, []);
    by.get(key).push({ i, y, t, gb: cg >= 0 ? pmGb(r[cg]) : 'N', ex: extras.map((j) => r[j]) });
  });
  const hasT = ct >= 0;
  const dup = PM.dup || (hasT ? 'last' : 'avg');
  const used = new Uint8Array(PM.rows.length);         // 합칠 때 실제로 쓰는 줄 (안 쓰는 중복 줄은 표에서 흐리게)
  const list = [];
  let nDup = 0;
  for (const [key, rs] of by) {
    let pick = rs[0];
    let use = rs;
    let y = pick.y;
    let gb = pick.gb;
    if (rs.length > 1) {
      nDup++;
      if (hasT) {                                      // 시간 순으로 처음 · 마지막 (시간이 비면 붙여넣은 순서)
        const s = rs.slice().sort((a, b) => (a.t ?? Infinity) - (b.t ?? Infinity) || a.i - b.i);
        pick = dup === 'first' ? s[0] : s[s.length - 1];
        use = [pick];
        y = pick.y;
        gb = pick.gb;
      } else if (dup === 'min' || dup === 'max') {
        pick = rs.reduce((a, b) => ((dup === 'min' ? b.y < a.y : b.y > a.y) ? b : a));
        use = [pick];
        y = pick.y;
        gb = pick.gb;
      } else {                                         // 평균: GOOD_BAD가 서로 다르면 B가 하나라도 있으면 B
        y = rs.reduce((a, b) => a + b.y, 0) / rs.length;
        gb = rs.some((x) => x.gb === 'B') ? 'B' : rs.some((x) => x.gb === 'G') ? 'G' : 'N';
      }
    }
    for (const x of use) used[x.i] = 1;
    const [lot, wf] = key.split('\u0001');
    list.push({ key, lot, wf, y, t: pick.t, gb, ex: pick.ex, n: rs.length, order: list.length });
  }
  PM.cache = { list, miss, bad, nDup, hasT, dup, extras: extras.map((j) => PM.head[j]), cg, rowKey, used };
  return PM.cache;
}
const pmDirty = () => { PM.cache = null; PM.eff = null; };

// ── UD: 순위로 good/bad(/none) 정하기 · 표에 쓰는 GOOD_BAD ───────────────────────────
function pmUdInit(d) {                                 // 처음 선: 붙여넣은 bad 비율(없으면 10%), 방향은 붙여넣은 bad가 있는 쪽
  const B = d.list.filter((w) => w.gb === 'B');
  const G = d.list.filter((w) => w.gb === 'G');
  const mean = (a) => a.reduce((s, w) => s + w.y, 0) / a.length;
  const sel = $('#higher_is_worse');
  const high = B.length && G.length ? mean(B) >= mean(G) : !sel || sel.value !== 'false';
  const bad = B.length ? Math.round((1000 * B.length) / d.list.length) / 10 : 10;
  PM.ud = { touched: false, band: false, high, bad, good: Math.min(50, Math.max(0, 100 - bad) / 2), color: 'gb', group: '', excl: new Map(), over: new Map() };
  PM.eff = null;
}
const pmUdDirty = () => { const u = PM.ud; return !!u && (u.touched || u.over.size > 0 || [...u.excl.values()].some((s) => s.size)); };

function pmOut(d) {                                    // 범례에서 뺀 묶음인지 (열마다 따로 기억)
  const u = PM.ud;
  const rules = u ? [...u.excl].map(([c, s]) => [d.extras.indexOf(c), s]).filter(([j, s]) => j >= 0 && s.size) : [];
  return (w) => rules.some(([j, s]) => s.has(w.ex[j]));
}

// 순위: 나쁜 쪽에서 bad%만큼 B, (none 구간을 켜면) 좋은 쪽에서 good%만큼 G, 나머지는 none(N) 또는 G. 뺀 묶음은 순위에서 뺀다.
// 묶음별(group)이면 묶음마다 따로 센다. cut = 묶음 → [bad 기준값, good 기준값]
function pmRank(d) {
  const u = PM.ud;
  const out = pmOut(d);
  const gj = u.group ? d.extras.indexOf(u.group) : -1;
  const lab = new Map();
  const cut = new Map();
  const groups = new Map();
  for (const w of d.list) {
    if (out(w)) continue;
    const g = gj >= 0 ? w.ex[gj] : '';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(w);
  }
  for (const [g, ws] of groups) {
    const s = ws.slice().sort((a, b) => (u.high ? b.y - a.y : a.y - b.y) || a.order - b.order);   // 나쁜 쪽부터
    const nB = Math.round((s.length * u.bad) / 100);
    const nG = u.band ? Math.min(s.length - nB, Math.round((s.length * u.good) / 100)) : s.length - nB;
    s.forEach((w, k) => lab.set(w.key, k < nB ? 'B' : k >= s.length - nG ? 'G' : 'N'));
    const mid = (a, b) => (a && b ? (a.y + b.y) / 2 : a ? a.y : b ? b.y : null);
    cut.set(g, [nB ? mid(s[nB - 1], s[nB]) : null, u.band && nG ? mid(s[s.length - nG - 1], s[s.length - nG]) : null]);
  }
  return { lab, cut, gj };
}

// 웨이퍼마다 쓰는 GOOD_BAD: 붙여넣은 값(UD에서 선 · 막대를 움직였거나 GOOD_BAD 열이 없으면 순위로 정한 값)
// → 범례에서 뺀 묶음은 none → 끌어서 직접 정한 값. changed = 붙여넣은 값과 달라진 웨이퍼 수
function pmEff() {
  if (PM.eff) return PM.eff;
  const d = pmData();
  const u = PM.ud;
  const R = u && d.list.length ? pmRank(d) : null;     // 선 위치(기준값)는 늘 순위로
  const rank = R && (u.touched || d.cg < 0);
  const out = pmOut(d);
  const lab = new Map();
  for (const w of d.list) {
    let v = rank ? R.lab.get(w.key) || 'N' : d.cg >= 0 ? w.gb : '';
    if (u && out(w)) v = 'N';
    if (u && u.over.has(w.key)) v = u.over.get(w.key);
    lab.set(w.key, v);
  }
  let changed = 0;
  if (d.cg >= 0) for (const w of d.list) if (lab.get(w.key) !== w.gb) changed++;
  PM.eff = { lab, cut: R ? R.cut : new Map(), gj: R ? R.gj : -1, changed, has: d.cg >= 0 || !!u };
  return PM.eff;
}

// ── 창 열고 닫기 · 저장 · 붙여넣기 · RESET ─────────────────────────────────────────
function openPaste() {
  if (!PM.rows.length) pmLoad();
  $('#pm').hidden = false;
  $('#pm-back').hidden = false;
  document.body.classList.add('pm-open');
  pmRenderAll();
  setTimeout(() => ($('#pm-grid').hidden ? $('#pm-drop') : $('#pm-grid')).focus({ preventScroll: true }), 0);
}
function closePaste() {
  $('#pm').hidden = true;
  $('#pm-back').hidden = true;
  document.body.classList.remove('pm-open');
  pmMenu(null);
  hideTip();
}
const pmOpen = () => !$('#pm').hidden;

function pmSet(parsed) {
  PM.head = parsed ? parsed.head : [];
  PM.roles = parsed ? parsed.roles : [];
  PM.rows = parsed ? parsed.rows : [];
  PM.dup = null;
  PM.ud = null;
  PM.autoW = {};
  pmDirty();
  pmSave();
  pmRenderAll();
}
const pmUdOut = (u) => (u ? { ...u, excl: [...u.excl].map(([c, s]) => [c, [...s]]), over: [...u.over] } : null);
const pmUdIn = (o) => (o ? { ...o, excl: new Map((o.excl || []).map(([c, a]) => [c, new Set(a)])), over: new Map(o.over || []) } : null);
const pmSnap = () => JSON.stringify({ head: PM.head, roles: PM.roles, rows: PM.rows, dup: PM.dup, ud: pmUdOut(PM.ud), udOn: PM.udOn, split: PM.split, colW: PM.colW });
function pmUse(s) {
  Object.assign(PM, { head: s.head || [], roles: s.roles || [], rows: s.rows || [], dup: s.dup || null, ud: pmUdIn(s.ud), udOn: !!s.udOn, split: s.split ?? null, colW: s.colW || {}, autoW: {} });
  pmDirty();
}
function pmRestore(snap) {                             // 되돌리기: 표 · UD 표시만 (UD 켜짐 · 폭은 지금 그대로)
  pmUse({ ...JSON.parse(snap), udOn: PM.udOn, split: PM.split, colW: PM.colW });
  pmSave();
  pmRenderAll();
}
function pmSave() {                                    // 창을 닫거나 새로고침해도 붙여넣은 표 · UD 표시는 남게 (이 브라우저에만)
  clearTimeout(pmSaveSoon.t);
  try { if (PM.rows.length * PM.head.length < 400000) localStorage.setItem('uc.paste', pmSnap()); else localStorage.removeItem('uc.paste'); } catch { /* 저장하지 못해도 괜찮음 */ }
}
function pmSaveSoon() { clearTimeout(pmSaveSoon.t); pmSaveSoon.t = setTimeout(pmSave, 400); }   // 막대를 끄는 동안은 모아서 한 번
function pmLoad() {
  try { const v = localStorage.getItem('uc.paste'); if (v) pmUse(JSON.parse(v)); } catch { /* 없으면 빈 표 */ }
}

function pmPasteText(text) {
  const parsed = pmParse(text);
  if (!parsed || !parsed.rows.length) { toast('붙여넣을 내용이 없습니다'); return; }
  const before = PM.rows.length ? pmSnap() : null;
  pmSet(parsed);
  const d = pmData();
  if (before) toast(`붙여넣었습니다 · 웨이퍼 ${fmt.int(d.list.length)}장`, { actions: [{ label: '되돌리기', fn: () => pmRestore(before) }], timeout: 6000 });
}
async function pmPasteButton() {                       // 사내 서버(http)에서는 브라우저가 버튼으로 클립보드 읽기를 막는다 → Ctrl+V 안내
  try {
    if (!navigator.clipboard || !navigator.clipboard.readText) throw new Error('no clipboard');
    pmPasteText(await navigator.clipboard.readText());
  } catch {
    ($('#pm-grid').hidden ? $('#pm-drop') : $('#pm-grid')).focus({ preventScroll: true });
    toast('Ctrl+V를 누르세요');
  }
}
function pmReset() {                                   // UD로 바꾼 것이 있으면 그것만 지우고(붙여넣은 GOOD_BAD로), 없으면 표를 비운다
  if (!PM.rows.length) return;
  const before = pmSnap();
  const ud = pmUdDirty();
  if (ud) { PM.ud = null; PM.eff = null; pmSave(); pmRenderAll(); } else pmSet(null);
  toast(ud ? 'UD 표시를 지웠습니다 (붙여넣은 GOOD_BAD로)' : '표를 비웠습니다', { actions: [{ label: '되돌리기', fn: () => pmRestore(before) }], timeout: 6000 });
}
function pmToggleUd() {
  PM.udOn = !PM.udOn;
  pmMenu(null);
  pmSave();
  pmRenderAll();
}

// ── 그리기: 창 폭 · 표 · 요약 · 산점도 ─────────────────────────────────────────────
function pmRenderAll() {
  if (PM.udOn && !PM.ud && pmData().list.length) pmUdInit(pmData());   // UD를 켜 두었으면 표보다 먼저 (GOOD_BAD 열이 없던 표에 열이 생김)
  pmRenderTable();
  pmRenderUd();
}
function pmSync() {                                    // UD를 바꾸면 표의 GOOD_BAD · 요약 · 산점도를 함께 다시 그린다
  PM.eff = null;
  pmRenderRows(true);
  pmRenderSum();
  pmRenderUd();
  pmSaveSoon();
}
const pmRedraw = () => { cancelAnimationFrame(pmRedraw.f); pmRedraw.f = requestAnimationFrame(() => { pmRenderRows(); pmRenderUd(); }); };

// 창 폭: UD를 끄면 표에 맞춰 좁게, 켜면 넓게 (표 | 산점도, 사이 막대를 끌어 폭 조절)
function pmLayout() {
  const d = pmData();
  const on = PM.udOn && PM.rows.length > 0;
  $('#pm-ud').setAttribute('aria-pressed', String(PM.udOn));
  $('#pm-ud').disabled = !d.list.length && !PM.udOn;
  $('#pm-run').disabled = !d.list.length;
  $('#pm-reset').disabled = !PM.rows.length;
  $('#pm-right').hidden = !on;
  $('#pm-split').hidden = !on;
  const m = $('#pm');
  m.classList.toggle('wide', on);
  const tw = pmTableW();
  m.style.width = on ? '' : `min(94vw, ${Math.round(Math.max(720, Math.min(1180, tw + 34)))}px)`;
  const left = $('#pm-left');
  if (!on) { left.style.flex = ''; return; }
  const bw = $('#pm-body').clientWidth;
  left.style.flex = `0 0 ${Math.round(Math.max(260, Math.min(bw - 420, PM.split ?? Math.min(tw, bw * 0.5))))}px`;
}
function pmSplitTo(w) {
  const bw = $('#pm-body').clientWidth;
  PM.split = Math.round(Math.max(260, Math.min(bw - 420, w)));
  $('#pm-left').style.flex = `0 0 ${PM.split}px`;
  pmRedraw();
}

// 표: 보이는 열 = 붙여넣은 열 + (GOOD_BAD 열 없이 UD를 쓰면) GOOD_BAD. 열 폭은 내용에 맞추고, 머리글 오른쪽 끝을 끌어 바꾼다
function pmCols() {
  const cols = PM.head.map((h, j) => ({ j, h, role: PM.roles[j] }));
  if (pmCol('gb') < 0 && PM.ud) cols.push({ j: -1, h: 'GOOD_BAD', role: 'gb' });
  return cols;
}
function pmColW(c) {
  if (PM.colW[c.h]) return PM.colW[c.h];
  if (PM.autoW[c.h]) return PM.autoW[c.h];
  const g = pmColW.g || (pmColW.g = document.createElement('canvas').getContext('2d'));
  const ff = getComputedStyle(document.body).fontFamily;
  g.font = `600 12px ${ff}`;
  let w = g.measureText(c.h).width + (c.role === 'time' || c.role === 'extra' ? 17 : 0) + 30;
  if (c.j >= 0) {
    let long = '';
    for (const r of PM.rows) { const v = r[c.j] || ''; if (v.length > long.length) long = v; }
    g.font = `${c.role === 'gb' ? '700 ' : ''}12px ${ff}`;
    w = Math.max(w, g.measureText(long).width + 28);
  }
  return (PM.autoW[c.h] = Math.round(Math.min(320, Math.max(52, w))));
}
const pmTableW = () => (PM.rows.length ? 44 + pmCols().reduce((a, c) => a + pmColW(c), 0) + 16 : 0);
function pmApplyColW() {                               // 열 폭만 바꾼다 (표는 다시 그리지 않음)
  const t = $('#pm-grid table');
  if (!t) return;
  const ws = pmCols().map(pmColW);
  const cs = $$('col', t);
  ws.forEach((w, k) => { if (cs[k + 1]) cs[k + 1].style.width = w + 'px'; });
  t.style.width = 44 + ws.reduce((a, b) => a + b, 0) + 'px';
}

function pmRenderTable() {
  const has = PM.rows.length > 0;
  $('#pm-drop').hidden = has;
  $('#pm-grid').hidden = !has;
  pmLayout();
  if (!has) { $('#pm-sum').innerHTML = ''; return; }
  const cols = pmCols();
  const ws = cols.map(pmColW);
  const icon = { time: PM_I.time, extra: PM_I.tag };
  $('#pm-grid').innerHTML = `<table class="pm-t" style="width:${44 + ws.reduce((a, b) => a + b, 0)}px"><colgroup><col style="width:44px">${ws.map((w) => `<col style="width:${w}px">`).join('')}</colgroup>`
    + `<thead><tr><th class="ri"></th>${cols.map((c, k) => `<th class="${c.role === 'y' ? 'num' : ''}" title="${esc(c.h)}">${icon[c.role] || ''}${esc(c.h)}<span class="pm-rs" data-k="${k}" data-help="pm_colw"></span></th>`).join('')}</tr></thead><tbody></tbody></table>`;
  PM.win = [-1, -1];
  pmRenderRows(true);
  pmRenderSum();
}

// 보이는 줄(+ 위아래 여유)만 그린다. GOOD_BAD 칸은 UD 결과를 바로 보여 주고, 붙여넣은 값과 다르면 바탕색
function pmRenderRows(force) {
  const g = $('#pm-grid');
  const tb = $('tbody', g);
  if (!tb || g.hidden) return;
  const n = PM.rows.length;
  const a = Math.max(0, Math.floor(g.scrollTop / PM_ROW) - 15);
  const b = Math.min(n, a + Math.ceil((g.clientHeight || 600) / PM_ROW) + 30);
  if (!force && a === PM.win[0] && b === PM.win[1]) return;
  PM.win = [a, b];
  const d = pmData();
  const E = pmEff();
  const cols = pmCols();
  const pad = (h) => `<tr class="sp"><td colspan="${cols.length + 1}" style="height:${h}px"></td></tr>`;
  let s = a ? pad(a * PM_ROW) : '';
  for (let i = a; i < b; i++) {
    const r = PM.rows[i];
    const key = d.rowKey[i];
    const use = key != null && d.used[i] === 1;
    s += `<tr${key != null && !use ? ' class="off" data-help="pm_unused"' : ''}><td class="ri">${i + 1}</td>`;
    for (const c of cols) {
      const v = c.j >= 0 ? r[c.j] : '';
      const cls = [c.j >= 0 && d.bad.has(`${i},${c.j}`) ? 'bad' : '', c.role === 'y' ? 'num' : ''].filter(Boolean).join(' ');
      let show = esc(v);
      if (c.role === 'gb') {
        const e = use ? E.lab.get(key) : '';
        if (c.j < 0) show = e ? `<span class="gbv ${e}">${e}</span>` : '';
        else if (use && e !== pmGb(v)) show = `<span class="gbv ${e} chg" title="붙여넣은 값 ${esc(v || '빈칸')}">${e}</span>`;
        else show = `<span class="gbv ${pmGb(v)}">${esc(v || '–')}</span>`;
      }
      s += `<td${cls ? ` class="${cls}"` : ''}>${show}</td>`;
    }
    s += '</tr>';
  }
  if (b < n) s += pad((n - b) * PM_ROW);
  tb.innerHTML = s;
}

// 표 아래 한 줄: 웨이퍼 수 · 중복(합치는 법) · GOOD_BAD 수 · UD로 바뀐 수 · 시간 열 · 범례용 열 · 고칠 칸
function pmRenderSum() {
  if (!PM.rows.length) { $('#pm-sum').innerHTML = ''; return; }
  const d = pmData();
  const E = pmEff();
  const parts = [];
  if (d.miss.length) parts.push(`<span class="pm-warn">${PM_I.warn}${esc(d.miss.join(' · '))} 열이 없습니다 (첫 줄에 열 이름을 넣거나, 왼쪽부터 ROOT_LOT_ID · WAFER_ID · Y_VALUE · GOOD_BAD 순서로)</span>`);
  parts.push(`<span data-help="pm_wafers">웨이퍼 <b>${fmt.int(d.list.length)}</b></span>`);
  if (d.nDup) {
    const opts = d.hasT ? [['first', PM_I.first, 'pm_first'], ['last', PM_I.last, 'pm_last']] : [['min', 'min', 'pm_min'], ['avg', 'avg', 'pm_avg'], ['max', 'max', 'pm_max']];
    parts.push(`<span class="pm-dup" data-help="pm_dup">중복 <b>${fmt.int(d.nDup)}</b></span><span class="seg small${d.hasT ? ' icons' : ''}" id="pm-dupseg" role="group" aria-label="중복 웨이퍼 합치는 법">`
      + opts.map(([v, l, h]) => `<button type="button" data-v="${v}" data-help="${h}" class="${d.dup === v ? 'on' : ''}">${l}</button>`).join('') + '</span>');
  }
  if (E.has && d.list.length) {
    const n = { B: 0, G: 0, N: 0 };
    for (const v of E.lab.values()) if (v in n) n[v]++;
    parts.push(`<span data-help="pm_gb"><span class="dot" style="background:var(--bad)"></span>${fmt.int(n.B)} <span class="dot" style="background:var(--good)"></span>${fmt.int(n.G)} <span class="dot hollow" style="border-color:var(--muted)"></span>${fmt.int(n.N)}</span>`);
  }
  if (E.changed) parts.push(`<span class="pm-col pm-chg" data-help="pm_changed">${PM_I.ud}${fmt.int(E.changed)}</span>`);
  if (d.hasT) parts.push(`<span class="pm-col" data-help="pm_time">${PM_I.time}${esc(PM.head[pmCol('time')])}</span>`);
  if (d.extras.length) parts.push(`<span class="pm-col" data-help="pm_extra">${PM_I.tag}${esc(d.extras.join(' · '))}</span>`);
  if (d.bad.size) parts.push(`<span class="pm-warn" data-help="pm_badcell">${PM_I.warn}${fmt.int(d.bad.size)}</span>`);
  $('#pm-sum').innerHTML = parts.join('');
}

// ── UD 산점도 (표 옆): 위 막대 · 가로선으로 good/bad(/none), 상자로 끌어 직접 정하기 ─────────────────
function pmRenderUd() {
  if ($('#pm-right').hidden) return;
  const d = pmData();
  const box = $('#pm-chart');
  $('#pm-empty').hidden = d.list.length > 0;
  if (!d.list.length) { $('canvas', box).getContext('2d').clearRect(0, 0, 99999, 99999); $('svg', box).innerHTML = ''; $('#pm-legend').hidden = true; return; }
  if (!PM.ud) pmUdInit(d);
  const u = PM.ud;
  if (u.color !== 'gb' && !d.extras.includes(u.color)) u.color = 'gb';
  if (u.group && !d.extras.includes(u.group)) { u.group = ''; PM.eff = null; }
  const E = pmEff();
  const opt = (v, l, cur) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(l)}</option>`;
  $('#pm-color').innerHTML = [opt('gb', 'GOOD_BAD', u.color), ...d.extras.map((x) => opt(x, x, u.color))].join('');
  $('#pm-group').innerHTML = [opt('', '전체', u.group), ...d.extras.map((x) => opt(x, x, u.group))].join('');
  $('#pm-color-wrap').hidden = !d.extras.length;
  $('#pm-group-wrap').hidden = !d.extras.length;
  const dir = $('#pm-dir');
  dir.innerHTML = u.high ? PM_I.dirHigh : PM_I.dirLow;
  dir.dataset.help = u.high ? 'pm_dir_high' : 'pm_dir_low';
  $('#pm-band').setAttribute('aria-pressed', String(u.band));
  $('#pm-hand').hidden = !u.over.size;
  $('#pm-hand-n').textContent = fmt.int(u.over.size);
  $('#pm-sl-bad').value = u.bad;
  $('#pm-sl-good').value = u.good;
  $('#pm-sl-good-row').hidden = !u.band;
  const [tb, tg] = E.gj < 0 ? E.cut.get('') || [null, null] : [null, null];
  $('#pm-v-bad').textContent = `${fmt.num(u.bad)}%${tb != null ? ` · Y ${u.high ? '≥' : '≤'} ${fmt.num(tb)}` : ''}`;
  $('#pm-v-good').textContent = `${fmt.num(u.good)}%${tg != null ? ` · Y ${u.high ? '≤' : '≥'} ${fmt.num(tg)}` : ''}`;
  pmDrawUd(d, E);
}

function pmCats(d) {                                   // 범례용 열의 묶음 → 색 (웨이퍼가 많은 순. good 파랑과 겹치는 첫 색은 빼고, 색이 모자라면 회색)
  const cj = d.extras.indexOf(PM.ud.color);
  if (cj < 0) return null;
  const cnt = new Map();
  for (const w of d.list) cnt.set(w.ex[cj], (cnt.get(w.ex[cj]) || 0) + 1);
  const keys = [...cnt.keys()].sort((a, b) => cnt.get(b) - cnt.get(a) || String(a).localeCompare(String(b)));
  const pal = PALETTE.slice(1);
  const m = new Map();
  keys.forEach((k, i) => m.set(k, i < pal.length ? pal[i] : C.muted));
  return { m, keys, cnt, cj, off: PM.ud.excl.get(PM.ud.color) || new Set() };
}

function pmDrawUd(d, E) {
  const box = $('#pm-chart');
  const cv = $('canvas', box);
  const sv = $('svg', box);
  const W = box.clientWidth;
  const H = box.clientHeight;
  if (!W || !H) return;
  const dpr = window.devicePixelRatio || 1;
  cv.width = Math.round(W * dpr);
  cv.height = Math.round(H * dpr);
  sv.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const u = PM.ud;
  const ws = d.list;
  const xsOf = (w) => (d.hasT && w.t != null ? w.t : w.order + 1);
  let [x0, x1, y0, y1] = [Infinity, -Infinity, Infinity, -Infinity];
  for (const w of ws) { const x = xsOf(w); if (x < x0) x0 = x; if (x > x1) x1 = x; if (w.y < y0) y0 = w.y; if (w.y > y1) y1 = w.y; }
  if (x0 === x1) { x0 -= 1; x1 += 1; }
  const pad = (y1 - y0) * 0.06 || Math.abs(y1) * 0.05 || 1;
  y0 -= pad;
  y1 += pad;
  const Lm = 56, R = W - 12, T = 12, B = H - 42;
  const xs = scaleLin(x0, x1, Lm + 6, R - 6);
  const ys = scaleLin(y0, y1, B, T);
  PM.geo = { xs, ys, xsOf, Lm, R, T, B, y0, y1 };
  const cats = pmCats(d);
  const lab = { B: C.bad, G: C.good, N: C.muted, '': C.muted };
  const colorOf = cats ? (w) => (cats.off.has(w.ex[cats.cj]) ? C.line2 : cats.m.get(w.ex[cats.cj])) : (w) => lab[E.lab.get(w.key)];
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  const r = ws.length > 3000 ? 2.2 : ws.length > 800 ? 3 : 3.8;
  const order = ws.slice().sort((a, b) => (E.lab.get(a.key) === 'B') - (E.lab.get(b.key) === 'B'));   // bad를 위에
  for (const w of order) {
    g.globalAlpha = 0.85;
    g.fillStyle = colorOf(w);
    g.beginPath();
    g.arc(xs(xsOf(w)), ys(w.y), r, 0, Math.PI * 2);
    g.fill();
    if (u.over.has(w.key)) { g.globalAlpha = 1; g.strokeStyle = C.ink; g.lineWidth = 1.2; g.stroke(); }   // 직접 정한 웨이퍼는 테두리
  }
  g.globalAlpha = 1;
  const k = Math.max(4, Math.floor((R - Lm) / 85));    // 눈금 수: 폭에 맞춰
  const xt = d.hasT ? timeTicks(x0, x1, k) : linTicks(x0, x1, k).filter((v) => Number.isInteger(v)).map((v) => ({ v, l: fmt.int(v) }));
  let s = axes({ L: Lm, R, T, B, xs, ys, xt, yt: linTicks(y0, y1, 5).map((v) => ({ v, l: fmt.tick(v) })),
    xl: d.hasT ? PM.head[pmCol('time')] : '웨이퍼 순번 (붙여넣은 순서)', yl: 'Y_VALUE', yo: 46 });
  if (E.gj < 0) {                                      // 기준선: 끌어서 옮긴다 (묶음별이면 묶음마다 달라 선 대신 막대만)
    const [tb, tg] = E.cut.get('') || [null, null];
    const line = (v, color, which, label) => {
      if (v == null) return '';
      const y = ys(v).toFixed(1);
      return `<g class="pm-line" data-line="${which}" style="cursor:ns-resize"><line x1="${Lm}" x2="${R}" y1="${y}" y2="${y}" stroke="transparent" stroke-width="14"/>`
        + `<line x1="${Lm}" x2="${R}" y1="${y}" y2="${y}" stroke="${color}" stroke-width="2" stroke-dasharray="6 4"/>`
        + `<text x="${R - 4}" y="${(+y - 6).toFixed(1)}" text-anchor="end" font-size="11" fill="${color}" font-weight="700" stroke="${C.card}" stroke-width="3" paint-order="stroke">${label}</text></g>`;
    };
    s += line(tb, u.band ? C.bad : C.ink, 'bad', u.band ? (u.high ? 'bad ↑' : 'bad ↓') : (u.high ? 'bad ↑ · good ↓' : 'good ↑ · bad ↓'));
    if (u.band) s += line(tg, C.good, 'good', u.high ? 'good ↓' : 'good ↑');
  }
  s += '<g id="pm-hover"></g>';
  sv.innerHTML = s;
  const lg = $('#pm-legend');                          // 범례: 색이 범례용 열일 때만 (묶음을 눌러 빼고 넣기). GOOD_BAD 색이면 표 아래 개수가 곧 범례
  lg.hidden = !cats;
  if (cats) {
    lg.innerHTML = cats.keys.slice(0, PM_MAX_CAT).map((c, i) => {
      if (i === PM_MAX_CAT - 1 && cats.keys.length > PM_MAX_CAT) return `<span class="item muted">외 ${cats.keys.length - PM_MAX_CAT + 1}개</span>`;
      const off = cats.off.has(c);
      return `<button type="button" class="item pm-cat${off ? ' off' : ''}" data-cat="${esc(c)}" title="${off ? '다시 넣기' : '빼기 (none으로)'}"><span class="dot" style="background:${cats.m.get(c)}"></span>${esc(c || '(빈칸)')} <span class="muted">${fmt.int(cats.cnt.get(c))}</span></button>`;
    }).join('');
  }
}

// 기준선 끌기 · 상자 끌어 직접 정하기 · 점 설명
function pmChartEvents() {
  const sv = $('#pm-chart svg');
  const pos = (e) => { const r = sv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  const near = (x, y) => {                             // 가장 가까운 점 (8px 안)
    const G = PM.geo;
    let best = null;
    let bd = 64;
    for (const w of pmData().list) {
      const dx = G.xs(G.xsOf(w)) - x;
      const dy = G.ys(w.y) - y;
      const dd = dx * dx + dy * dy;
      if (dd < bd) { bd = dd; best = w; }
    }
    return best;
  };
  sv.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !PM.geo) return;
    pmMenu(null);
    const ln = e.target.closest('.pm-line');
    const [x, y] = pos(e);
    if (ln) PM.brush = { line: ln.dataset.line };
    else if (x >= PM.geo.Lm && x <= PM.geo.R && y >= PM.geo.T && y <= PM.geo.B) PM.brush = { x0: x, y0: y, x1: x, y1: y, moved: false };
    else return;
    try { sv.setPointerCapture(e.pointerId); } catch { /* 이미 뗌 */ }
    e.preventDefault();
  });
  sv.addEventListener('pointermove', (e) => {
    const b = PM.brush;
    const [x, y] = pos(e);
    if (!b) {
      const w = PM.geo && near(x, y);
      const h = $('#pm-hover');
      if (!w) { if (h) h.innerHTML = ''; hideTip(); return; }
      const G = PM.geo;
      if (h) h.innerHTML = `<circle cx="${G.xs(G.xsOf(w))}" cy="${G.ys(w.y)}" r="7" fill="none" stroke="${C.ink}" stroke-width="1.3"/>`;
      pmTip(w, e);
      return;
    }
    if (b.line) { pmDragLine(b.line, y); return; }
    b.x1 = Math.max(PM.geo.Lm, Math.min(PM.geo.R, x));
    b.y1 = Math.max(PM.geo.T, Math.min(PM.geo.B, y));
    if (!b.moved && Math.abs(b.x1 - b.x0) + Math.abs(b.y1 - b.y0) > 6) { b.moved = true; hideTip(); }
    if (b.moved) pmBox(b);
  });
  const end = () => {
    const b = PM.brush;
    PM.brush = null;
    if (!b || b.line) return;
    if (!b.moved) { pmBox(null); return; }
    const G = PM.geo;
    const [xa, xb] = [Math.min(b.x0, b.x1), Math.max(b.x0, b.x1)];
    const [ya, yb] = [Math.min(b.y0, b.y1), Math.max(b.y0, b.y1)];
    const keys = pmData().list.filter((w) => { const px = G.xs(G.xsOf(w)); const py = G.ys(w.y); return px >= xa && px <= xb && py >= ya && py <= yb; }).map((w) => w.key);
    if (!keys.length) { pmBox(null); return; }
    PM.sel = keys;
    const r = $('#pm-chart').getBoundingClientRect();
    pmMenu({ x: r.left + xb, y: r.top + ya, n: keys.length });
  };
  sv.addEventListener('pointerup', end);
  sv.addEventListener('pointercancel', () => { PM.brush = null; pmBox(null); });
  sv.addEventListener('mouseleave', () => { if (!PM.brush) { const h = $('#pm-hover'); if (h) h.innerHTML = ''; hideTip(); } });
}
function pmBox(b) {                                    // 끌어서 고르는 상자 (차트 위 HTML 상자)
  const el = $('#pm-brush');
  el.hidden = !b;
  if (!b) return;
  Object.assign(el.style, { left: Math.min(b.x0, b.x1) + 'px', top: Math.min(b.y0, b.y1) + 'px', width: Math.abs(b.x1 - b.x0) + 'px', height: Math.abs(b.y1 - b.y0) + 'px' });
}

function pmDragLine(which, py) {                       // 선을 옮긴 높이 → 그보다 나쁜(좋은) 쪽 웨이퍼 비율
  const d = pmData();
  const u = PM.ud;
  const G = PM.geo;
  const v = G.y1 - ((py - G.T) / (G.B - G.T)) * (G.y1 - G.y0);
  const out = pmOut(d);
  const pool = d.list.filter((w) => !out(w));
  if (!pool.length) return;
  const worse = (y) => (u.high ? y > v : y < v);
  const pct = (cnt) => Math.round((1000 * cnt) / pool.length) / 10;
  if (which === 'bad') { u.bad = Math.min(100, pct(pool.filter((w) => worse(w.y)).length)); u.good = Math.min(u.good, 100 - u.bad); }
  else u.good = Math.min(100 - u.bad, pct(pool.filter((w) => !worse(w.y)).length));
  u.touched = true;
  pmSync();
}

function pmTip(w, e) {
  const d = pmData();
  const E = pmEff();
  const lab = { B: 'bad', G: 'good', N: 'none', '': '–' };
  const v = E.lab.get(w.key);
  const gb = d.cg >= 0 && v !== w.gb ? `${lab[w.gb]} → ${lab[v]}` : lab[v];
  const ex = d.extras.map((x, j) => `${esc(x)} ${esc(w.ex[j] || '–')}`).join(' · ');
  showTip(`<b>${esc(w.lot)} · ${esc(w.wf)}</b><br>Y_VALUE ${fmt.num(w.y)}${w.t != null ? ` · ${esc(isoTime(w.t))}` : ''}${w.n > 1 ? ` · ${w.n}줄 합침` : ''}`
    + `<br>GOOD_BAD ${gb}${PM.ud.over.has(w.key) ? ' (직접 정함)' : ''}${ex ? `<br>${ex}` : ''}`, e.clientX, e.clientY);
}

// 상자로 고른 웨이퍼를 bad · good · none으로 (작은 그림 메뉴)
function pmMenu(at) {
  const m = $('#pm-menu');
  if (!at) { m.hidden = true; if ($('#pm-brush')) pmBox(null); PM.sel = null; return; }
  m.innerHTML = `<span class="muted small">${fmt.int(at.n)}</span>`
    + '<button type="button" class="ghost icon-only" data-set="B" title="bad로" aria-label="bad로"><span class="dot" style="background:var(--bad)"></span></button>'
    + '<button type="button" class="ghost icon-only" data-set="G" title="good으로" aria-label="good으로"><span class="dot" style="background:var(--good)"></span></button>'
    + '<button type="button" class="ghost icon-only" data-set="N" title="none으로" aria-label="none으로"><span class="dot hollow" style="border-color:var(--muted)"></span></button>'
    + `<button type="button" class="ghost icon-only" data-set="" title="취소" aria-label="취소">${PM_I.close}</button>`;
  m.hidden = false;
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(innerWidth - r.width - 8, at.x + 6) + 'px';
  m.style.top = Math.max(8, at.y - r.height - 6) + 'px';
}

// 분석 실행: 정리한 웨이퍼 목록 (GOOD_BAD는 UD로 바꾼 것 포함). DB 함수를 연결하면 이 목록으로 설비 이력을 가져와 분석한다
function pmPayload() {
  const d = pmData();
  const E = pmEff();
  return d.list.map((w) => ({ root_lot_id: w.lot, wafer_id: w.wf, y_value: w.y, good_bad: E.lab.get(w.key) || '', ...(d.hasT ? { time: w.t == null ? '' : isoTime(w.t) } : {}),
    ...Object.fromEntries(d.extras.map((x, j) => [x, w.ex[j]])) }));
}
function pmRun() {
  const d = pmData();
  if (d.miss.length || !d.list.length) { toast(d.miss.length ? `${esc(d.miss.join(' · '))} 열이 없습니다` : '먼저 표에 붙여넣으세요', { kind: 'error' }); return; }
  const rows = pmPayload();
  window.UC_PASTE = rows;                              // DB 함수 연결 전: 정리된 목록을 확인용으로 남긴다
  toast(`웨이퍼 ${fmt.int(rows.length)}장 준비됨 · DB 조회 함수를 연결하면 여기서 바로 분석합니다`, { timeout: 6000 });
}

// ── 이벤트 ─────────────────────────────────────────────────────────────
function bindPaste() {
  $('#pm-close').addEventListener('click', closePaste);
  $('#pm-back').addEventListener('click', closePaste);
  $('#pm-paste').addEventListener('click', pmPasteButton);
  $('#pm-reset').addEventListener('click', pmReset);
  $('#pm-ud').addEventListener('click', pmToggleUd);
  $('#pm-run').addEventListener('click', pmRun);
  document.addEventListener('paste', (e) => {          // 창이 열려 있으면 어디서 Ctrl+V해도 표로 (입력 칸 제외)
    if (!pmOpen() || e.target.closest('input, textarea, select')) return;
    e.preventDefault();
    pmPasteText(e.clipboardData ? e.clipboardData.getData('text/plain') : '');
  });
  document.addEventListener('keydown', (e) => {
    if (!pmOpen()) return;
    if (e.key === 'Escape') { if (!$('#pm-menu').hidden) pmMenu(null); else closePaste(); e.stopImmediatePropagation(); }
  }, true);
  // 표: 스크롤하면 보이는 줄만 다시 · 머리글 끝을 끌어 열 폭 (두 번 누르면 내용에 맞춤) · 중복 합치는 법
  const grid = $('#pm-grid');
  grid.addEventListener('scroll', () => { cancelAnimationFrame(grid.f); grid.f = requestAnimationFrame(() => pmRenderRows()); }, { passive: true });
  let col = null;
  grid.addEventListener('pointerdown', (e) => {
    const h = e.target.closest('.pm-rs');
    if (!h || e.button !== 0) return;
    const c = pmCols()[+h.dataset.k];
    col = { c, x: e.clientX, w: pmColW(c) };
    try { h.setPointerCapture(e.pointerId); } catch { /* 이미 뗌 */ }
    e.preventDefault();
  });
  grid.addEventListener('pointermove', (e) => {
    if (!col) return;
    PM.colW[col.c.h] = Math.round(Math.max(40, Math.min(600, col.w + e.clientX - col.x)));
    pmApplyColW();
  });
  const colEnd = () => { if (!col) return; col = null; pmSave(); pmLayout(); pmRedraw(); };
  grid.addEventListener('pointerup', colEnd);
  grid.addEventListener('pointercancel', colEnd);
  grid.addEventListener('dblclick', (e) => {
    const h = e.target.closest('.pm-rs');
    if (!h) return;
    delete PM.colW[pmCols()[+h.dataset.k].h];
    pmApplyColW();
    pmSave();
    pmLayout();
    pmRedraw();
  });
  $('#pm-sum').addEventListener('click', (e) => {
    const b = e.target.closest('#pm-dupseg button');
    if (!b) return;
    PM.dup = b.dataset.v;
    pmDirty();
    pmSave();
    pmRenderAll();
  });
  // 표 | 산점도 사이 막대: 끌어서 폭 (두 번 누르면 처음 폭, 키보드 ← →)
  const sp = $('#pm-split');
  let split = null;
  sp.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    split = { x: e.clientX, w: $('#pm-left').getBoundingClientRect().width };
    try { sp.setPointerCapture(e.pointerId); } catch { /* 이미 뗌 */ }
    sp.classList.add('on');
    e.preventDefault();
  });
  sp.addEventListener('pointermove', (e) => { if (split) pmSplitTo(split.w + e.clientX - split.x); });
  const splitEnd = () => { if (!split) return; split = null; sp.classList.remove('on'); pmSave(); };
  sp.addEventListener('pointerup', splitEnd);
  sp.addEventListener('pointercancel', splitEnd);
  sp.addEventListener('dblclick', () => { PM.split = null; pmLayout(); pmRedraw(); pmSave(); });
  sp.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    pmSplitTo($('#pm-left').getBoundingClientRect().width + (e.key === 'ArrowLeft' ? -32 : 32));
    pmSaveSoon();
    e.preventDefault();
  });
  // UD 막대 · 단추: 선 · 막대 · 방향 · none 구간 · 묶음별은 순위로 정하기(touched), 색은 보기만, 범례 · 직접 정하기는 그 웨이퍼만
  const touch = (f) => { f(PM.ud); PM.ud.touched = true; pmSync(); };
  $('#pm-sl-bad').addEventListener('input', (e) => touch((u) => { u.bad = +e.target.value; if (u.band) u.good = Math.min(u.good, 100 - u.bad); }));
  $('#pm-sl-good').addEventListener('input', (e) => touch((u) => { u.good = Math.min(+e.target.value, 100 - u.bad); }));
  $('#pm-dir').addEventListener('click', () => touch((u) => { u.high = !u.high; }));
  $('#pm-band').addEventListener('click', () => touch((u) => { u.band = !u.band; if (u.band) u.good = Math.min(u.good, 100 - u.bad); }));
  $('#pm-group').addEventListener('change', (e) => touch((u) => { u.group = e.target.value; }));
  $('#pm-color').addEventListener('change', (e) => { PM.ud.color = e.target.value; pmRenderUd(); pmSaveSoon(); });
  $('#pm-hand-x').addEventListener('click', () => { PM.ud.over = new Map(); pmSync(); });
  $('#pm-legend').addEventListener('click', (e) => {
    const b = e.target.closest('.pm-cat');
    if (!b) return;
    const u = PM.ud;
    if (!u.excl.has(u.color)) u.excl.set(u.color, new Set());
    const s = u.excl.get(u.color);
    if (s.has(b.dataset.cat)) s.delete(b.dataset.cat); else s.add(b.dataset.cat);
    pmSync();
  });
  $('#pm-menu').addEventListener('click', (e) => {
    const b = e.target.closest('[data-set]');
    if (!b) return;
    if (b.dataset.set && PM.sel) for (const k of PM.sel) PM.ud.over.set(k, b.dataset.set);
    pmMenu(null);
    pmSync();
  });
  pmChartEvents();
  window.addEventListener('resize', () => { if (pmOpen()) { pmLayout(); pmRedraw(); } });
}
document.addEventListener('DOMContentLoaded', bindPaste);
