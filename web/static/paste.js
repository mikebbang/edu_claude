'use strict';
// 웨이퍼 값 붙여넣기: 시작 화면 검색창(분석 화면은 데이터 줄) 바로 아래에 펼쳐지는 창. 엑셀에서 웨이퍼 값을 복사해 Ctrl+V.
// 열은 이름 별명 목록 없이 알아본다: 값 모양 · DB 열 이름과 닮은 정도 · lot + wafer 한 쌍이 웨이퍼 하나인지 · 사용자가 고쳐 준 것.
// 확실하지 않으면 머리글에 ?를 붙이고, 머리글을 눌러 고르면 이 브라우저가 기억한다. 같은 웨이퍼가 여러 줄이면 시간 열이 있을 때
// 처음 · 마지막 줄, 없을 때 평균 · 최소 · 최대로 합친다. GOOD_BAD는 어떻게 적었든 G · B · N으로(모르는 값은 머리글에서 정하면 기억).
// 붙여넣은 값이 우선이고, 더 조정하고 싶으면 UD를 켜서(표 옆 산점도) 가로선 · 위 막대로 다시 정한다(가운데 none 구간은 켤 때만).
// UD에서 바꾼 표시는 표의 GOOD_BAD에 바로 들어간다. 분석 실행(DB 이력 조회)은 DB 함수를 연결한 뒤에

const PM_ROLES = [                                     // [역할, 표준 열 이름] (머리글 · 열 역할 메뉴 순서)
  ['lot', 'ROOT_LOT_ID'], ['wafer', 'WAFER_ID'], ['y', 'Y_VALUE'], ['gb', 'GOOD_BAD'], ['time', '시간'], ['extra', '범례용'], ['skip', '안 씀'],
];
const PM_STD = Object.fromEntries(PM_ROLES);
const PM_ONE = ['lot', 'wafer', 'y', 'gb', 'time'];    // 한 열만 맡는 역할
const PM_NEED = ['lot', 'wafer', 'y'];                 // 꼭 있어야 하는 역할
const PM_DB = { lot: 'ROOT_LOT_ID', wafer: 'WAFER_ID', y: 'Y_VALUE', gb: 'GOOD_BAD', time: 'TKIN_TIME' };   // 이름 닮음을 재는 기준 = DB 열 이름 (별명 목록 없음)
const PM_GB = {                                        // GOOD_BAD 값의 기본 뜻 (대소문자 무관). 이 밖의 값은 머리글에서 정하면 기억, 정하지 않으면 N
  B: ['B', 'BAD', 'NG', 'FAIL', 'F', '1', 'X', '불량'],
  G: ['G', 'GOOD', 'OK', 'PASS', 'P', '0', 'O', '양품', '정상'],
};
const PM_NONE = ['N', 'NONE', 'NA', '-'];              // none으로 적은 값 (모르는 값으로 치지 않음)
const PM_ROW = 24;                                     // 표 한 줄 높이(px). 보이는 줄만 그려서 몇만 줄도 스크롤로 본다
const PM_MAX_CAT = 12;                                 // 범례에 늘어놓는 묶음 수 (넘으면 웨이퍼가 많은 순으로 11개 + 외 n개)
const PM = { head: [], raw: [], roles: [], rows: [], named: false, unsure: new Set(), dup: null, ud: null, udOn: false, split: null, colW: {}, autoW: {},
  size: { w: { off: null, on: null }, h: null }, learned: {}, gbmap: {}, cache: null, eff: null, win: [-1, -1], brush: null, sel: null, geo: null, colPick: -1 };
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

// ── 값 읽기 ─────────────────────────────────────────────────────────────
const pmNorm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9가-힣]/g, '');
const pmUp = (s) => String(s ?? '').trim().toUpperCase();
const pmNum = (s) => { const v = String(s ?? '').replace(/,/g, '').trim(); if (v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : NaN; };
const pmIsNum = (s) => { const n = pmNum(s); return n != null && !Number.isNaN(n); };
const pmGbKnown = (v) => v in PM.gbmap || PM_GB.B.includes(v) || PM_GB.G.includes(v) || PM_NONE.includes(v);   // v = 대문자
const pmGb = (s) => { const v = pmUp(s); return v in PM.gbmap ? PM.gbmap[v] : PM_GB.B.includes(v) ? 'B' : PM_GB.G.includes(v) ? 'G' : 'N'; };
const pmGbLike = (s) => { const v = pmUp(s); return v !== '' && pmGbKnown(v); };
function pmTime(s) {                                   // 2026-09-29 13:45(:30) · 2026/9/29 · 2026.09.29 · 20260929134530 (시각은 적힌 그대로 = UTC로 다룸)
  const v = String(s ?? '').trim();
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(v);
  if (!m) m = /^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2})?)?$/.exec(v);
  if (!m) return null;
  const [y, mo, d, h, mi, se] = [1, 2, 3, 4, 5, 6].map((k) => +(m[k] || 0));
  if (y < 1990 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || se > 59) return null;   // 날짜가 될 수 없는 숫자(측정값 등)는 시각이 아님
  const t = Date.UTC(y, mo - 1, d, h, mi, se);
  return Number.isFinite(t) ? t : null;
}
const pmMostly = (vals, ok, part = 0.8) => { const v = vals.filter((x) => x !== ''); return v.length > 0 && v.filter(ok).length >= v.length * part; };

// ── 열 알아보기 (별명 목록 없음) ─────────────────────────────────────────────────
// 이름 닮음 0~1: 열 이름을 낱말로 나눠 DB 열 이름의 낱말과 비교한다. 같으면 1, 들어 있으면 0.9(rootlotid ⊃ lot),
// 앞부분이면 0.8(val → value), 첫 글자가 같은 줄임이면 0.6(wf → wafer). 한두 글자 낱말(y · id)은 가볍게, 머리글자(gb = good_bad)는 0.9
const pmTokens = (s) => String(s || '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9가-힣]+/)
  .flatMap((t) => t.match(/[a-z가-힣]+|\d+/g) || []).filter((t) => !/^\d+$/.test(t));
const pmSubseq = (a, b) => { let i = 0; for (const ch of b) if (ch === a[i]) i++; return i === a.length; };
const pmTokMatch = (s, h) => (s === h ? 1 : s.length >= 3 && h.includes(s) ? 0.9 : h.length >= 2 && s.startsWith(h) ? 0.8 : h.length >= 2 && h[0] === s[0] && pmSubseq(h, s) ? 0.6 : 0);
function pmNameSim(name, role) {
  const hs = pmTokens(name);
  if (!hs.length) return 0;
  const ss = pmTokens(PM_DB[role]);
  const w = (t) => (t.length <= 2 ? 0.35 : 1);
  let got = 0;
  let all = 0;
  for (const s of ss) { all += w(s); got += w(s) * Math.max(...hs.map((h) => pmTokMatch(s, h))); }
  return Math.max(got / all, hs.includes(ss.map((s) => s[0]).join('')) ? 0.9 : 0);
}

// 값 모양: 숫자 · 시각 · G/B 같은 값 · 글자가 든 값의 비율, 서로 다른 값 수, 한 값이 몇 번 되풀이되나(rep), 같은 값이 몇 줄씩 이어지나(block)
function pmProfile(vals) {
  const v = vals.filter((x) => x !== '');
  const n = v.length;
  if (!n) return { n: 0 };
  let num = 0;
  let time = 0;
  let tok = 0;
  let alpha = 0;
  let runs = 0;
  let len = 0;
  v.forEach((x, i) => {
    len += x.length;
    if (pmTime(x) != null) time++;                     // 20260929 같은 날짜 숫자는 시각으로
    else if (pmIsNum(x)) num++;
    if (pmGbLike(x)) tok++;
    if (/[a-z가-힣]/i.test(x)) alpha++;
    if (i === 0 || x !== v[i - 1]) runs++;
  });
  const distinct = new Set(v).size;
  return { n, num: num / n, time: time / n, tok: tok / n, alpha: alpha / n, distinct, rep: n / distinct, block: n / runs, len: len / n };
}
const PM_FIT = {                                       // 값 모양이 그 역할다운 정도 0~1
  time: (p) => p.time,                                 // 거의 다 날짜 · 시각
  gb: (p) => (p.tok >= 0.8 ? 1 : p.tok >= 0.5 ? 0.5 : 0),   // 거의 다 G · B · OK · NG · 0 · 1 같은 값 (사용자가 정한 값 포함)
  y: (p) => (p.num < 0.5 ? 0 : p.num * (p.distinct >= 3 ? 1 : 0.4)),   // 숫자, 값이 여러 가지
  lot: (p) => (p.time >= 0.5 || p.tok >= 0.8 ? 0 : (p.rep >= 1.5 ? 0.5 : 0.2) + (p.alpha >= 0.5 ? 0.25 : 0) + (p.block >= 2 ? 0.1 : 0) + (p.len >= 4 ? 0.15 : 0)),   // 되풀이 · 글자 · 몇 줄씩 이어짐 · 긴 값
  wafer: (p) => (p.time >= 0.5 || p.tok >= 0.8 ? 0 : (p.rep >= 1.5 ? 0.45 : 0.2) + (p.distinct <= 60 ? 0.2 : 0) + (p.block < 2 ? 0.15 : 0) + (p.len <= 3 ? 0.2 : 0)),   // 되풀이 · 가짓수 적음 · 줄마다 바뀜 · 짧은 값
};

// 역할 정하기: 열 · 역할마다 점수(이름 닮음 반 + 값 모양 반, 전에 고쳐 준 이름이면 크게)를 매기고, lot · wafer 한 쌍이 줄마다 거의 하나면
// (= 웨이퍼 열쇠) 더해서 합이 가장 큰 짝을 고른다. 둘째로 좋은 짝과 차이가 작으면 그 열은 '확실하지 않음'(머리글에 ?)
function pmGuessRoles(names, rows) {
  const step = Math.max(1, Math.floor(rows.length / 3000));   // 큰 표는 고르게 3000줄만 본다
  const sample = step > 1 ? rows.filter((_, i) => i % step === 0) : rows;
  const P = names.map((_, j) => pmProfile(sample.map((r) => r[j])));
  const lr = names.map((h) => PM.learned[pmNorm(h)]);
  const sc = PM_ONE.map((r) => names.map((h, j) => (P[j].n ? 0.5 * pmNameSim(h, r) + 0.5 * PM_FIT[r](P[j]) + (lr[j] === r ? 3 : lr[j] ? -1 : 0) : -9)));
  const gbj = names.map((_, j) => j).filter((j) => lr[j] === 'gb' || (P[j].n && PM_FIT.gb(P[j]) >= 1)).sort((a, b) => sc[3][b] - sc[3][a])[0];
  if (gbj != null) {                                   // 숫자 열이 여럿이어도 GOOD_BAD와 같이 움직이는 열을 Y_VALUE로
    const labs = sample.map((r) => pmGb(r[gbj]));
    names.forEach((_, j) => { if (j !== gbj && P[j].n && P[j].num >= 0.5) sc[2][j] += 0.4 * pmSplitGb(sample.map((r) => r[j]), labs); });
  }
  const cand = PM_ONE.map((r, i) => {
    const need = PM_NEED.includes(r);
    const c = names.map((_, j) => j).filter((j) => sc[i][j] > (need ? 0.1 : 0.3)).sort((a, b) => sc[i][b] - sc[i][a]).slice(0, 4);
    return need && c.length ? c : [...c, -1];
  });
  const pairs = new Map();
  const pairU = (a, b) => {                            // lot · wafer 한 쌍이 줄마다 다른 비율
    const k = a + ',' + b;
    if (!pairs.has(k)) {
      const s = new Set();
      let n = 0;
      for (const r of sample) if (r[a] !== '' && r[b] !== '') { s.add(r[a] + '\u0001' + r[b]); n++; }
      pairs.set(k, n ? s.size / n : 0);
    }
    return pairs.get(k);
  };
  let best = null;
  const alt = PM_ONE.map(() => new Map());            // 역할 · 열 → 그 열을 골랐을 때 가장 좋은 합
  const pick = [];
  const used = new Set();
  const walk = (i, sum) => {
    if (i === PM_ONE.length) {
      const [l, w] = pick;
      let tot = sum;
      if (l >= 0 && w >= 0) tot += (pairU(l, w) >= 0.75 ? 0.6 : pairU(l, w) >= 0.5 ? 0.2 : -0.3) + (l < w ? 0.03 : 0);
      if (!best || tot > best.tot) best = { tot, pick: pick.slice() };
      pick.forEach((c, k) => { if (!(alt[k].get(c) >= tot)) alt[k].set(c, tot); });
      return;
    }
    for (const c of cand[i]) {
      if (c >= 0 && used.has(c)) continue;
      pick[i] = c;
      if (c >= 0) used.add(c);
      walk(i + 1, sum + (c >= 0 ? sc[i][c] : 0));
      if (c >= 0) used.delete(c);
    }
  };
  walk(0, 0);
  const roles = names.map((_, j) => (lr[j] === 'skip' || !P[j].n ? 'skip' : 'extra'));
  const unsure = [];
  best.pick.forEach((c, i) => {
    if (c < 0) return;
    roles[c] = PM_ONE[i];
    let second = -Infinity;
    for (const [cc, t] of alt[i]) if (cc !== c && t > second) second = t;
    if (!lr[c] && best.tot - second < 0.12) unsure.push(c);
  });
  return { roles, unsure };
}

function pmSplitGb(vals, labs) {                       // 숫자 열이 G · B를 얼마나 가르나 0~1 (= |AUC − 0.5| × 2, 같은 값은 평균 순위)
  const xs = [];
  vals.forEach((x, i) => { const v = pmNum(x); if ((labs[i] === 'B' || labs[i] === 'G') && v != null && !Number.isNaN(v)) xs.push([v, labs[i] === 'B']); });
  const nB = xs.filter((x) => x[1]).length;
  const nG = xs.length - nB;
  if (nB < 3 || nG < 3) return 0;
  xs.sort((a, b) => a[0] - b[0]);
  let rB = 0;
  for (let i = 0; i < xs.length;) {
    let k = i;
    while (k + 1 < xs.length && xs[k + 1][0] === xs[i][0]) k++;
    for (let m = i; m <= k; m++) if (xs[m][1]) rB += (i + k) / 2 + 1;
    i = k + 1;
  }
  return Math.abs((rB - (nB * (nB + 1)) / 2) / (nB * nG) - 0.5) * 2;
}

// 첫 줄이 열 이름인지: 아래 값과 모양이 다르면(글자 ↔ 숫자 · 시각) +2, DB 열 이름과 닮았거나 전에 고쳐 준 이름이면 +,
// 숫자 · 시각 · G/B 같은 값이거나 아래에 같은 값이 또 있으면(lot · wafer는 되풀이된다) −
function pmIsHead(first, rest) {
  let s = 0;
  first.forEach((c, j) => {
    if (c === '') return;
    if (pmIsNum(c) || pmTime(c) != null) { s -= 3; return; }
    const col = rest.map((r) => r[j] ?? '');
    if (pmGbLike(c) && pmMostly(col, pmGbLike)) { s -= 2; return; }   // G/B 열의 G · B는 데이터 (다른 열 위의 'B'는 이름일 수 있음)
    if (col.includes(c)) { s -= 2; return; }
    const sim = Math.max(...PM_ONE.map((r) => pmNameSim(c, r)));
    s += (PM.learned[pmNorm(c)] ? 2 : 0) + (sim >= 0.5 ? 2 : sim >= 0.3 ? 1 : 0);
    if (pmMostly(col, pmIsNum) || pmMostly(col, (v) => pmTime(v) != null)) s += 2;
  });
  return s >= 2;
}

function pmSep(lines) {                                // 나누는 글자: 탭 · 쉼표 · 세미콜론 · | 중 줄마다 칸 수가 가장 고른 것(같으면 탭), 없으면 빈칸
  const sample = lines.slice(0, 50);
  let best = null;
  for (const sep of ['\t', ',', ';', '|']) {
    const freq = new Map();
    for (const l of sample) { const k = l.split(sep).length; freq.set(k, (freq.get(k) || 0) + 1); }
    const [cols, cnt] = [...freq].sort((a, b) => b[1] - a[1])[0];
    if (cols < 2) continue;
    const share = cnt / sample.length;
    if (!best || share > best.share + 0.05) best = { sep, share };
  }
  return best && best.share >= 0.6 ? best.sep : /\s+/;
}
function pmBuild(first, rows) {                        // first = 열 이름 줄 (없으면 null)
  const W = rows.reduce((a, r) => Math.max(a, r.length), first ? first.length : 0);
  const pad = (r) => Array.from({ length: W }, (_, j) => r[j] ?? '');
  const raw = first ? pad(first) : new Array(W).fill('');
  rows = rows.map(pad);
  const { roles, unsure } = pmGuessRoles(raw, rows);
  const seen = new Map();
  const head = raw.map((h, j) => {                     // 이름이 없으면 역할 이름(시간 = TIME, 그 밖 = COL n), 겹치면 _2 · _3
    let n = h || (roles[j] === 'time' ? 'TIME' : PM_ONE.includes(roles[j]) ? PM_STD[roles[j]] : `COL${j + 1}`);
    const k = n.toLowerCase();
    seen.set(k, (seen.get(k) || 0) + 1);
    if (seen.get(k) > 1) n += `_${seen.get(k)}`;
    return n;
  });
  return { head, raw, roles, rows, named: !!first, unsure };
}
function pmParse(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n').filter((l) => l.trim() !== '');
  if (!lines.length) return null;
  const sep = pmSep(lines);
  let cells = lines.map((l) => l.split(sep).map((c) => c.trim()));
  const W = cells.reduce((a, r) => Math.max(a, r.length), 0);
  const keep = [...Array(W).keys()].filter((j) => cells.some((r) => (r[j] ?? '') !== ''));   // 모두 빈 열(엑셀에서 같이 복사된 빈 칸)은 뺀다
  cells = cells.map((r) => keep.map((j) => r[j] ?? ''));
  const head = cells.length > 1 && pmIsHead(cells[0], cells.slice(1));
  return pmBuild(head ? cells[0] : null, head ? cells.slice(1) : cells);
}
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
  const gbUnk = new Map();                             // GOOD_BAD 열에서 뜻을 모르는 값 → 줄 수 (N으로 침, 머리글에서 정하면 기억)
  if (cg >= 0) for (const r of PM.rows) { const v = pmUp(r[cg]); if (v !== '' && !pmGbKnown(v)) gbUnk.set(v, (gbUnk.get(v) || 0) + 1); }
  PM.cache = { list, miss, bad, nDup, hasT, dup, extras: extras.map((j) => PM.head[j]), cg, rowKey, used, gbUnk };
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

// ── 창 열고 닫기: 검색창(분석 화면은 데이터 줄) 바로 아래에 펼친다. 막지 않으니 Job ID도 그대로 입력할 수 있다 ──────────
const pmHost = () => ($('#pm').closest('#home') ? 'home' : 'card');
const pmOpen = () => { const pm = $('#pm'); return !pm.hidden && pm.offsetParent !== null; };
function openPaste(kind) {
  if (typeof kind !== 'string') kind = $('#home').hidden ? 'card' : 'home';   // 안내 문구에서 부르면 지금 화면에 맞춰
  if (!PM.rows.length) pmLoad();
  const pm = $('#pm');
  const at = kind === 'home' ? $('#home .query-area') : $('#qbar');
  if (at && pm.previousElementSibling !== at) at.after(pm);
  pm.hidden = false;
  pmButtons();
  pmRenderAll();
  requestAnimationFrame(() => pm.scrollIntoView({ block: 'nearest', behavior: smooth() }));
  setTimeout(() => ($('#pm-grid').hidden ? $('#pm-drop') : $('#pm-grid')).focus({ preventScroll: true }), 0);
}
function closePaste() {
  const back = $('#pm').contains(document.activeElement);
  $('#pm').hidden = true;
  pmButtons();
  pmMenu(null);
  hideTip();
  if (back) $(pmHost() === 'home' ? '#home-paste' : '#paste-btn').focus({ preventScroll: true });
}
function togglePaste(kind) { if (pmOpen() && pmHost() === kind) closePaste(); else openPaste(kind); }
function pmButtons() {                                 // 여는 단추 눌림 표시 · 시작 화면 안내 문구 숨김
  const open = !$('#pm').hidden;
  $('#home-paste').setAttribute('aria-expanded', String(open && pmHost() === 'home'));
  $('#paste-btn').setAttribute('aria-expanded', String(open && pmHost() === 'card'));
  $('#home').classList.toggle('pm-on', open && pmHost() === 'home');
}

// ── 저장 · 붙여넣기 · RESET · 열 역할 ─────────────────────────────────────────────
function pmSet(parsed) {
  PM.head = parsed ? parsed.head : [];
  PM.raw = parsed ? parsed.raw : [];
  PM.roles = parsed ? parsed.roles : [];
  PM.rows = parsed ? parsed.rows : [];
  PM.named = !!(parsed && parsed.named);
  PM.unsure = new Set(parsed ? parsed.unsure : []);
  PM.dup = null;
  PM.ud = null;
  PM.autoW = {};
  pmDirty();
  pmSave();
  pmRenderAll();
}
const pmUdOut = (u) => (u ? { ...u, excl: [...u.excl].map(([c, s]) => [c, [...s]]), over: [...u.over] } : null);
const pmUdIn = (o) => (o ? { ...o, excl: new Map((o.excl || []).map(([c, a]) => [c, new Set(a)])), over: new Map(o.over || []) } : null);
const pmSnap = () => JSON.stringify({ head: PM.head, raw: PM.raw, roles: PM.roles, rows: PM.rows, named: PM.named, unsure: [...PM.unsure], dup: PM.dup, ud: pmUdOut(PM.ud),
  udOn: PM.udOn, split: PM.split, colW: PM.colW, size: PM.size });
function pmUse(s) {
  Object.assign(PM, { head: s.head || [], raw: s.raw || s.head || [], roles: s.roles || [], rows: s.rows || [], named: s.named ?? true, unsure: new Set(s.unsure || []), dup: s.dup || null,
    ud: pmUdIn(s.ud), udOn: !!s.udOn, split: s.split ?? null, colW: s.colW || {}, size: s.size && s.size.w ? s.size : { w: { off: null, on: null }, h: null }, autoW: {} });
  pmDirty();
}
// 이 브라우저가 기억하는 것: 열 이름 → 역할(머리글에서 고친 것), GOOD_BAD 값 → G · B · N(머리글에서 정한 것)
function pmPrefs() {
  try { PM.learned = JSON.parse(localStorage.getItem('uc.colmap') || '{}') || {}; PM.gbmap = JSON.parse(localStorage.getItem('uc.gbmap') || '{}') || {}; } catch { /* 처음 */ }
}
function pmPrefSave() {
  try { localStorage.setItem('uc.colmap', JSON.stringify(PM.learned)); localStorage.setItem('uc.gbmap', JSON.stringify(PM.gbmap)); } catch { /* 기억하지 못해도 지금 표는 바뀜 */ }
}
function pmRestore(snap) {                             // 되돌리기: 표 · UD 표시만 (UD 켜짐 · 폭 · 크기는 지금 그대로)
  pmUse({ ...JSON.parse(snap), udOn: PM.udOn, split: PM.split, colW: PM.colW, size: PM.size });
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
function pmSetRole(j, role) {                          // 머리글 메뉴: 이 열을 무엇으로 쓸지 (한 열만 맡는 역할은 원래 열이 범례용으로)
  const key = PM.named ? pmNorm(PM.raw[j] || PM.head[j]) : '';   // 열 이름이 있을 때만 기억 (다음에 같은 이름이면 바로 그 역할)
  const had = key ? PM.learned[key] : undefined;
  if (key) { PM.learned[key] = role; pmPrefSave(); }
  if (PM.roles[j] === role) { PM.unsure.delete(j); pmSave(); pmRenderTable(); return; }
  const before = pmSnap();
  PM.roles = PM.roles.map((r, k) => {
    if (k === j || r !== role || !PM_ONE.includes(role)) return r;
    PM.unsure.delete(k);
    return 'extra';
  });
  PM.roles[j] = role;
  PM.unsure.delete(j);
  PM.ud = null;
  PM.autoW = {};
  pmDirty();
  pmSave();
  pmRenderAll();
  const undo = () => { if (key) { if (had === undefined) delete PM.learned[key]; else PM.learned[key] = had; pmPrefSave(); } pmRestore(before); };
  toast(`${esc(PM.head[j])} → ${esc(PM_STD[role])}${key ? ' · 기억함' : ''}`, { actions: [{ label: '되돌리기', fn: undo }], timeout: 5000 });
}
function pmToggleHead() {                              // 첫 줄을 열 이름으로 쓸지 바꾸기 (알아보기가 틀렸을 때)
  const before = pmSnap();
  const p = PM.named ? pmBuild(null, [PM.raw.slice(), ...PM.rows]) : pmBuild(PM.rows[0], PM.rows.slice(1));
  pmSet(p);
  toast(PM.named ? '첫 줄을 열 이름으로 씁니다' : '첫 줄도 데이터로 씁니다', { actions: [{ label: '되돌리기', fn: () => pmRestore(before) }], timeout: 5000 });
}
function pmSetGb(v, to) {                              // GOOD_BAD 값의 뜻 정하기 (기억)
  PM.gbmap[v] = to;
  pmPrefSave();
  pmDirty();
  pmRenderAll();
  pmSave();
}

// ── 그리기: 창 크기 · 표 · 요약 · 산점도 ─────────────────────────────────────────────
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
const pmMode = () => (PM.udOn && PM.rows.length > 0 ? 'on' : 'off');

// 창 크기: 끌어서 바꾼 크기 → 없으면 UD 끔 = 표에 맞춤(검색창보다 좁지 않게) · UD 켬 = 넓게. 시작 화면은 가운데, 분석 화면은 데이터 줄과 왼쪽 맞춤
function pmLayout() {
  const d = pmData();
  const on = pmMode() === 'on';
  $('#pm-ud').setAttribute('aria-pressed', String(PM.udOn));
  $('#pm-ud').disabled = !d.list.length && !PM.udOn;
  $('#pm-run').disabled = !d.list.length;
  $('#pm-reset').disabled = !PM.rows.length;
  $('#pm-right').hidden = !on;
  $('#pm-split').hidden = !on;
  const pm = $('#pm');
  const home = pmHost() === 'home';
  pm.classList.toggle('in-card', !home);
  const box = pm.parentElement;
  if (pm.hidden || !box) return;
  const cs = getComputedStyle(box);
  const maxW = Math.max(360, Math.min(1680, box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)));
  const auto = on ? maxW : Math.max(home ? 600 : 720, pmTableW() + 34);
  pm.style.width = Math.round(Math.max(360, Math.min(maxW, PM.size.w[pmMode()] ?? auto))) + 'px';
  pm.style.height = Math.round(Math.max(280, Math.min(innerHeight * 0.92, PM.size.h ?? innerHeight * 0.6))) + 'px';
  const left = $('#pm-left');
  if (!on) { left.style.flex = ''; return; }
  const bw = $('#pm-body').clientWidth;
  left.style.flex = `0 0 ${Math.round(Math.max(260, Math.min(bw - 420, PM.split ?? Math.min(pmTableW(), bw * 0.5))))}px`;
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
function pmHead(c) {                                   // 머리글 [윗줄, 아랫줄]: 윗줄 = 이 열의 역할(모든 열 같은 규칙), 아랫줄 = 붙여넣은 이름(역할 이름과 다를 때)
  if (c.j < 0) return ['GOOD_BAD', 'UD'];
  const top = PM_STD[c.role];
  return [top, pmNorm(c.h) === pmNorm(top) ? '' : c.h];
}
function pmColW(c) {
  if (PM.colW[c.h]) return PM.colW[c.h];
  if (PM.autoW[c.h]) return PM.autoW[c.h];
  const g = pmColW.g || (pmColW.g = document.createElement('canvas').getContext('2d'));
  const ff = getComputedStyle(document.body).fontFamily;
  const [top, sub] = pmHead(c);
  g.font = `600 12px ${ff}`;
  let w = g.measureText(top).width + (c.role === 'time' || c.role === 'extra' ? 17 : 0) + (c.j >= 0 && PM.unsure.has(c.j) ? 18 : 0) + 30;   // ? 표시 자리까지
  g.font = `11px ${ff}`;
  if (sub) w = Math.max(w, g.measureText(sub).width + 30);
  if (c.j >= 0) {
    let long = '';
    for (const r of PM.rows) { const v = r[c.j] || ''; if (v.length > long.length) long = v; }
    g.font = `12px ${ff}`;
    w = Math.max(w, (c.role === 'gb' ? 30 : g.measureText(long).width) + 28);
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
  const th = (c, k) => {
    const [top, sub] = pmHead(c);
    const q = c.j >= 0 && PM.unsure.has(c.j);
    return `<th class="${[c.role === 'y' ? 'num' : '', c.role === 'skip' ? 'skip' : '', c.j >= 0 ? 'pick' : '', q ? 'unsure' : ''].filter(Boolean).join(' ')}" data-k="${k}"${c.j >= 0 ? ` data-help="${q ? 'pm_unsure' : 'pm_colrole'}"` : ''}>`
      + `<span class="pm-hl">${q ? '<span class="pm-q" aria-label="확실하지 않음">?</span>' : ''}${icon[c.role] || ''}${esc(top)}</span>${sub ? `<span class="pm-hs">${esc(sub)}</span>` : ''}<span class="pm-rs" data-k="${k}" data-help="pm_colw"></span></th>`;
  };
  $('#pm-grid').innerHTML = `<table class="pm-t" style="width:${44 + ws.reduce((a, b) => a + b, 0)}px"><colgroup><col style="width:44px">${ws.map((w) => `<col style="width:${w}px">`).join('')}</colgroup>`
    + `<thead><tr><th class="ri"></th>${cols.map(th).join('')}</tr></thead><tbody></tbody></table>`;
  PM.win = [-1, -1];
  pmRenderRows(true);
  pmRenderSum();
}

// 보이는 줄(+ 위아래 여유)만 그린다. GOOD_BAD 칸은 G · B · N으로 보여 주고(붙여넣은 글자는 마우스를 올리면),
// UD 결과를 바로 반영해 붙여넣은 값과 다르면 바탕색
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
      const cls = [c.j >= 0 && d.bad.has(`${i},${c.j}`) ? 'bad' : '', c.role === 'y' ? 'num' : '', c.role === 'skip' ? 'skip' : ''].filter(Boolean).join(' ');
      let show = esc(v);
      if (c.role === 'gb') {
        const p = c.j >= 0 ? pmGb(v) : '';
        const e = use ? E.lab.get(key) : p;
        const from = ` title="붙여넣은 값 ${esc(v || '빈칸')}"`;
        if (c.j < 0) show = e ? `<span class="gbv ${e}">${e}</span>` : '';
        else if (e !== p) show = `<span class="gbv ${e} chg"${from}>${e}</span>`;
        else show = `<span class="gbv ${p}"${String(v).trim().toUpperCase() === p ? '' : from}>${p}</span>`;
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
  if (d.miss.length) parts.push(`<span class="pm-warn">${PM_I.warn}${esc(d.miss.join(' · '))} 열이 없습니다 (표 머리글을 눌러 정하세요)</span>`);
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
  if (d.gbUnk.size) {
    const vs = [...d.gbUnk.keys()];
    parts.push(`<button type="button" class="pm-note" data-open="gb" data-help="pm_gbunk">${PM_I.warn}GOOD_BAD 모르는 값 ${esc(vs.slice(0, 3).join(' · '))}${vs.length > 3 ? ` 외 ${vs.length - 3}` : ''} → N</button>`);
  }
  if (PM.unsure.size) parts.push(`<button type="button" class="pm-note" data-open="unsure" data-help="pm_unsure">? 확인할 열 ${fmt.int(PM.unsure.size)}</button>`);
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

// 떠 있는 작은 메뉴 하나: 상자로 고른 웨이퍼 → bad · good · none, 또는 머리글 → 열 역할
function pmMenu(at) {
  const m = $('#pm-menu');
  if (!at) { m.hidden = true; m.classList.remove('list'); if ($('#pm-brush')) pmBox(null); PM.sel = null; PM.colPick = -1; return; }
  m.classList.remove('list');
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
function pmColMenu(k, th) {
  const c = pmCols()[k];
  if (!c || c.j < 0) return;
  const m = $('#pm-menu');
  PM.sel = null;
  PM.colPick = c.j;
  m.classList.add('list');
  m.innerHTML = PM_ROLES.map(([r, l]) => `<button type="button" class="pm-mi${c.role === r ? ' on' : ''}" data-role="${r}">${l}</button>`).join('')
    + `<div class="pm-msep"></div><button type="button" class="pm-mi${PM.named ? ' on' : ''}" data-head="1">첫 줄 = 열 이름</button>`
    + (c.role === 'gb' ? `<div class="pm-msep"></div><div class="pm-mt">값 → G · B · N</div>${pmGbRows(c.j)}` : '');
  m.hidden = false;
  const a = th.getBoundingClientRect();
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(8, Math.min(innerWidth - r.width - 8, a.left)) + 'px';
  m.style.top = Math.max(8, Math.min(innerHeight - r.height - 8, a.bottom + 4)) + 'px';
}

function pmGbRows(j) {                                 // GOOD_BAD 열의 값마다 G · B · N (모르는 값 먼저, 15가지까지)
  const cnt = new Map();
  for (const r of PM.rows) { const v = pmUp(r[j]); if (v !== '') cnt.set(v, (cnt.get(v) || 0) + 1); }
  const vals = [...cnt.keys()].sort((a, b) => pmGbKnown(a) - pmGbKnown(b) || cnt.get(b) - cnt.get(a)).slice(0, 15);
  return vals.map((v) => {
    const g = pmGb(v);
    return `<div class="pm-gbr${pmGbKnown(v) ? '' : ' unk'}"><span class="v" title="${esc(v)}">${esc(v)}</span><span class="muted small">${fmt.int(cnt.get(v))}</span>`
      + `<span class="seg small">${['G', 'B', 'N'].map((x) => `<button type="button" data-gbv="${esc(v)}" data-to="${x}" class="${g === x ? 'on' : ''}">${x}</button>`).join('')}</span></div>`;
  }).join('');
}
function pmOpenColMenu(j) {                            // 요약 안내에서: 그 열의 머리글 메뉴 열기
  const k = pmCols().findIndex((c) => c.j === j);
  const th = $(`#pm-grid th[data-k="${k}"]`);
  if (!th) return;
  th.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  pmColMenu(k, th);
}

// 분석 실행: 정리한 웨이퍼 목록. GOOD_BAD는 UD로 바꾼 것 포함, 늘 G · B · N (열이 없으면 N). DB 함수를 연결하면 이 목록으로 설비 이력을 가져와 분석한다
function pmPayload() {
  const d = pmData();
  const E = pmEff();
  return d.list.map((w) => ({ root_lot_id: w.lot, wafer_id: w.wf, y_value: w.y, good_bad: E.lab.get(w.key) || 'N', ...(d.hasT ? { time: w.t == null ? '' : isoTime(w.t) } : {}),
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
  pmPrefs();
  $('#home-paste').addEventListener('click', () => togglePaste('home'));
  $('#paste-btn').addEventListener('click', () => togglePaste('card'));
  $('#pm-close').addEventListener('click', closePaste);
  $('#pm-paste').addEventListener('click', pmPasteButton);
  $('#pm-reset').addEventListener('click', pmReset);
  $('#pm-ud').addEventListener('click', pmToggleUd);
  $('#pm-run').addEventListener('click', pmRun);
  document.addEventListener('paste', (e) => {          // 창이 열려 있으면 Ctrl+V는 표로 (Job ID 같은 입력 칸에서는 그대로)
    if (!pmOpen() || e.target.closest('input, textarea, select')) return;
    e.preventDefault();
    pmPasteText(e.clipboardData ? e.clipboardData.getData('text/plain') : '');
  });
  document.addEventListener('keydown', (e) => {        // Esc: 메뉴 → (창 안에 있으면) 창 닫기. 검색창의 Esc는 그대로
    if (e.key !== 'Escape' || !pmOpen()) return;
    if (!$('#pm-menu').hidden) { pmMenu(null); e.stopImmediatePropagation(); return; }
    if (e.target.closest && e.target.closest('#pm')) { closePaste(); e.stopImmediatePropagation(); }
  }, true);
  document.addEventListener('pointerdown', (e) => {    // 메뉴 밖을 누르면 메뉴 닫기
    if (!$('#pm-menu').hidden && !e.target.closest('#pm-menu')) pmMenu(null);
  }, true);
  // 표: 스크롤하면 보이는 줄만 다시 · 머리글을 누르면 열 역할 · 머리글 끝을 끌어 열 폭 (두 번 누르면 내용에 맞춤) · 중복 합치는 법
  const grid = $('#pm-grid');
  grid.addEventListener('scroll', () => { cancelAnimationFrame(grid.f); grid.f = requestAnimationFrame(() => pmRenderRows()); }, { passive: true });
  grid.addEventListener('click', (e) => {
    const th = e.target.closest('th[data-k]');
    if (th && !e.target.closest('.pm-rs')) pmColMenu(+th.dataset.k, th);
  });
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
    const n = e.target.closest('.pm-note');
    if (n) { pmOpenColMenu(n.dataset.open === 'gb' ? pmCol('gb') : [...PM.unsure][0]); return; }
    const b = e.target.closest('#pm-dupseg button');
    if (!b) return;
    PM.dup = b.dataset.v;
    pmDirty();
    pmSave();
    pmRenderAll();
  });
  // 창 크기: 아래 · 양옆 · 오른쪽 아래 모서리를 끈다 (시작 화면은 가운데 맞춤이라 폭이 양쪽으로, 두 번 누르면 처음 크기)
  const pm = $('#pm');
  let rz = null;
  pm.addEventListener('pointerdown', (e) => {
    const h = e.target.closest('.pm-rz');
    if (!h || e.button !== 0) return;
    const r = pm.getBoundingClientRect();
    rz = { d: h.dataset.d, x: e.clientX, y: e.clientY, w: r.width, h: r.height, k: pmHost() === 'home' ? 2 : 1, mode: pmMode() };
    try { h.setPointerCapture(e.pointerId); } catch { /* 이미 뗌 */ }
    e.preventDefault();
  });
  pm.addEventListener('pointermove', (e) => {
    if (!rz) return;
    const dx = e.clientX - rz.x;
    if (rz.d.includes('e')) PM.size.w[rz.mode] = rz.w + dx * rz.k;
    if (rz.d.includes('w')) PM.size.w[rz.mode] = rz.w - dx * rz.k;
    if (rz.d.includes('s')) PM.size.h = rz.h + e.clientY - rz.y;
    pmLayout();
    pmRedraw();
  });
  const rzEnd = () => {
    if (!rz) return;
    if (/[ew]/.test(rz.d)) PM.size.w[rz.mode] = pm.getBoundingClientRect().width;   // 실제로 적용된(최소 · 최대 안) 크기로 기억
    if (rz.d.includes('s')) PM.size.h = pm.getBoundingClientRect().height;
    rz = null;
    pmSave();
  };
  pm.addEventListener('pointerup', rzEnd);
  pm.addEventListener('pointercancel', rzEnd);
  pm.addEventListener('dblclick', (e) => {
    const h = e.target.closest('.pm-rz');
    if (!h) return;
    if (/[ew]/.test(h.dataset.d)) PM.size.w[pmMode()] = null;
    if (h.dataset.d.includes('s')) PM.size.h = null;
    pmLayout();
    pmRedraw();
    pmSave();
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
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.role) { const j = PM.colPick; pmMenu(null); if (j >= 0) pmSetRole(j, b.dataset.role); return; }
    if (b.dataset.head) { pmMenu(null); pmToggleHead(); return; }
    if (b.dataset.gbv) { const j = PM.colPick; pmSetGb(b.dataset.gbv, b.dataset.to); pmOpenColMenu(j); return; }
    if (b.dataset.set && PM.sel) for (const k of PM.sel) PM.ud.over.set(k, b.dataset.set);
    pmMenu(null);
    pmSync();
  });
  pmChartEvents();
  window.addEventListener('resize', () => { if (pmOpen()) { pmLayout(); pmRedraw(); } });
}
document.addEventListener('DOMContentLoaded', bindPaste);
