'use strict';
// 화면 동작: 파일 올리기 → Run(진행 상태) → funnel · 순위표(서로 연동) → 고른 순위의 상세. 실행 기록에서 고르면 저장된 결과를 연다

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const S = {
  fileId: null, runId: null, res: null, rank: 0, hover: null, yMode: 'judg', pMode: 'judg', cMode: 'hi',
  det: null, sel: null, step: null, sort: { key: 'rank', dir: 1 }, fn: null,
  runs: [], workers: 1, watch: 0, detSeq: 0, histTimer: null, histQ: '', defaults: null,
};

async function api(path, opts = {}) {
  const r = await fetch(path, opts);
  let body = null;
  try { body = await r.json(); } catch { body = null; }
  if (!r.ok) throw new Error((body && body.detail) || `${r.status} ${r.statusText}`);
  return body;
}
const post = (path, data) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function status(html, cls = '') {
  const e = $('#status');
  e.hidden = !html;
  e.className = 'status ' + cls;
  e.innerHTML = html || '';
}

// ── 툴팁 ───────────────────────────────────────────────────────────────
function showTip(html, x, y) {
  const t = $('#tip');
  t.innerHTML = html;
  t.hidden = false;
  const r = t.getBoundingClientRect();
  t.style.left = Math.min(window.innerWidth - r.width - 8, x + 14) + 'px';
  t.style.top = (y + 14 + r.height > window.innerHeight ? y - r.height - 10 : y + 14) + 'px';
}
const hideTip = () => { $('#tip').hidden = true; };

// ── 파일 ───────────────────────────────────────────────────────────────
async function loadFiles(selectId) {
  const files = await api('/api/files');
  const sel = $('#recent');
  sel.innerHTML = files.length
    ? files.map((f) => `<option value="${esc(f.id)}">${esc(f.name)} · ${(f.size / 1e6).toFixed(0)}MB · ${esc(f.uploaded.replace('T', ' ').slice(5, 16))}</option>`).join('')
    : '<option value="">올린 파일 없음</option>';
  if (selectId) sel.value = selectId;
  S.fileId = sel.value || null;
}

function upload(file) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const fd = new FormData();
    fd.append('file', file);
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const p = e.loaded / e.total;
      status(`올리는 중 · ${esc(file.name)} · ${Math.round(p * 100)}%<div class="bar"><i style="width:${p * 100}%"></i></div>`);
    };
    xhr.onload = () => {
      let b = null;
      try { b = JSON.parse(xhr.responseText); } catch { b = null; }
      if (xhr.status < 300) resolve(b); else reject(new Error((b && b.detail) || xhr.statusText));
    };
    xhr.onerror = () => reject(new Error('올리지 못했습니다. 네트워크를 확인하세요.'));
    xhr.open('POST', '/api/upload');
    xhr.send(fd);
  });
}

// ── 설정 · 실행 ─────────────────────────────────────────────────────────
function settings() {
  const v = (id) => $('#' + id).value.trim();
  const pa = v('part_adjust');
  return {
    min_n: parseInt(v('min_n'), 10),
    max_depth: $('#no_limit').checked ? null : parseInt(v('max_depth'), 10),
    higher_is_worse: v('higher_is_worse') === 'true',
    y_transform: v('y_transform') || null,
    part_adjust: pa === 'true' ? true : pa === 'false' ? false : 'auto',
    part_min: parseInt(v('part_min'), 10),
    rework: v('rework'),
    spread_adjust: v('spread_adjust') === 'true',
    same_wafers: v('same_wafers') === '' ? null : Number(v('same_wafers')) / 100,
    part_id: v('part_id') || null,
    line_id: v('line_id') || null,
    step_suffix: v('step_suffix') || null,
  };
}

const STAGE_FRAC = { queued: 0.01, start: 0.02, read: 0.08, prepare: 0.22, analyze: 0.3, judge: 0.86, payload: 0.95 };

async function run() {
  if (!S.fileId) { status('먼저 raw.csv를 올리거나 최근 파일을 고르세요.', 'error'); return; }
  $('#run').disabled = true;
  let r;
  try {
    r = await post('/api/runs', { file_id: S.fileId, settings: settings() });
  } catch (e) {
    status(esc(e.message), 'error');
    $('#run').disabled = false;
    return;
  }
  $('#run').disabled = false;
  await refreshRuns();
  await openRun(r.run_id, r.reused ? '같은 파일 · 같은 설정으로 실행한 기록이 있어 저장된 결과를 열었습니다 (다시 계산하지 않음).' : '');
}

// 실행 하나를 연다: 끝났으면 저장된 결과를 바로, 돌고 있으면 진행 상태를 보다가 끝나면 연다. 다른 실행을 열면 앞의 기다림은 멈춘다
async function openRun(id, note = '') {
  const token = ++S.watch;
  S.runId = id;
  setHash(id);
  const v = S.runs.find((x) => x.id === id);
  if (v) {
    fillSettings(v.settings);
    if (v.file_exists) pickFile(v.file_id, v.file_name);
  }
  renderHistory();
  for (;;) {
    let st;
    try {
      st = await api(`/api/runs/${id}`);
    } catch (e) {
      if (token === S.watch) { hideResults(); status(esc(e.message), 'error'); }
      return;
    }
    if (token !== S.watch) return;
    if (st.status === 'done') {
      if (v && v.status !== 'done') refreshRuns();
      await loadResult(id, token, note);
      return;
    }
    hideResults();
    if (st.status === 'error') {
      status('실행 중 오류: ' + esc(st.error), 'error');
      refreshRuns();
      return;
    }
    let frac = STAGE_FRAC[st.stage] ?? 0.5;
    const m = /Order (\d+)개/.exec(st.text || '');
    if (st.stage === 'analyze' && m) frac = Math.min(0.84, 0.3 + 0.09 * parseInt(m[1], 10));
    const text = st.status === 'queued' && st.ahead ? `앞에 실행 ${st.ahead}개가 끝나기를 기다리는 중 (동시에 ${S.workers}개까지 실행)` : st.text || '실행 중';
    status(`${esc(text)} · ${st.seconds ?? 0}초<div class="bar"><i style="width:${frac * 100}%"></i></div>`);
    await sleep(1000);
    if (token !== S.watch) return;
  }
}

async function loadResult(id, token, note = '') {
  let res;
  try {
    res = await api(`/api/runs/${id}/result`);
  } catch (e) {
    if (token === S.watch) { hideResults(); status('결과를 불러오지 못했습니다: ' + esc(e.message), 'error'); }
    return;
  }
  if (token !== S.watch) return;
  status(note ? esc(note) : '');
  S.res = res;
  S.det = null;
  S.hover = null;
  S.rank = 0;
  S.sort = { key: 'rank', dir: 1 };
  $('#results').hidden = false;
  const hasBad = S.res.info.has_bad;
  for (const b of $$('#yseg button[data-v=bad], #pseg button[data-v=bad]')) b.disabled = !hasBad;
  if (!hasBad && S.yMode === 'bad') setSeg('#yseg', (S.yMode = 'judg'));
  if (!hasBad && S.pMode === 'bad') setSeg('#pseg', (S.pMode = 'judg'));
  const job = (S.res.info.data.job_ids || [])[0];
  $('#topnote').textContent = `${job ? job + ' · ' : ''}${S.res.info.data.wafers.toLocaleString('ko-KR')}장 · 혐의 대상 ${S.res.ranking.length}개`;
  renderSummary();
  renderFunnel();
  renderRanking();
  if (S.res.ranking.length) await pickRank(0);
  else $('#detail').hidden = true;
}

function hideResults() {
  S.res = null;
  S.det = null;
  $('#results').hidden = true;
  $('#detail').hidden = true;
  $('#topnote').textContent = 'raw.csv를 올리고 Run을 누르세요';
}

function setHash(id) {
  history.replaceState(null, '', id ? '#run=' + id : location.pathname + location.search);
}

// ── 실행 기록 ───────────────────────────────────────────────────────────
const ACTIVE = new Set(['queued', 'running']);
const SET_TEXT = {
  higher_is_worse: (v) => `Value ${v ? '클수록 나쁨' : '클수록 좋음'}`,
  y_transform: (v) => `치우침 ${({ auto: '자동', rank: '순위로', log: '로그로' })[v] || '그대로'}`,
  part_adjust: (v) => `part 맞춤 ${v === true ? '켬' : v === false ? '끔' : '뚜렷할 때만'}`,
  part_min: (v) => `작은 part ${v}장 미만 묶기`,
  rework: (v) => `재작업 ${v === 'first' ? '처음 줄' : '마지막 줄'}`,
  spread_adjust: (v) => `퍼짐 보정 ${v ? '켬' : '끔'}`,
  same_wafers: (v) => (v == null ? '같은 웨이퍼 안 묶음' : `같은 웨이퍼 ${Math.round(v * 100)}%`),
  part_id: (v) => `part_id ${v || '전체'}`,
  line_id: (v) => `line_id ${v || '전체'}`,
  step_suffix: (v) => `STEP 이름 규칙 ${v || '없음'}`,
};
const two = (n) => String(n).padStart(2, '0');
const when = (sec, full) => {
  const t = new Date(sec * 1000);
  return (full ? t.getFullYear() + '-' : '') + `${two(t.getMonth() + 1)}-${two(t.getDate())} ${two(t.getHours())}:${two(t.getMinutes())}`;
};
const dur = (s) => (s == null ? '' : s < 60 ? `${Math.round(s)}초` : `${Math.floor(s / 60)}분 ${Math.round(s % 60)}초`);

function settingsText(st) {
  const extra = Object.keys(SET_TEXT).filter((k) => S.defaults && JSON.stringify(st[k]) !== JSON.stringify(S.defaults[k])).map((k) => SET_TEXT[k](st[k]));
  return { main: `MIN_N ${st.min_n} · MAX_DEPTH ${st.max_depth ?? '제한 없음'}`, extra: extra.join(' · ') };
}

function fillSettings(st) {
  const set = (id, v) => { $('#' + id).value = v; };
  set('min_n', st.min_n);
  $('#no_limit').checked = st.max_depth == null;
  $('#max_depth').disabled = st.max_depth == null;
  if (st.max_depth != null) set('max_depth', st.max_depth);
  set('higher_is_worse', String(st.higher_is_worse));
  set('y_transform', st.y_transform ?? '');
  set('part_adjust', String(st.part_adjust));
  set('part_min', st.part_min);
  set('rework', st.rework);
  set('spread_adjust', String(st.spread_adjust));
  set('same_wafers', st.same_wafers == null ? '' : Math.round(st.same_wafers * 100));
  set('part_id', st.part_id ?? '');
  set('line_id', st.line_id ?? '');
  set('step_suffix', st.step_suffix ?? '');
}

function pickFile(id, name) {
  const sel = $('#recent');
  if (![...sel.options].some((o) => o.value === id)) {
    if (!sel.options[0] || sel.options[0].value === '') sel.innerHTML = '';
    sel.insertAdjacentHTML('beforeend', `<option value="${esc(id)}">${esc(name || id)}</option>`);
  }
  sel.value = id;
  S.fileId = id;
}

// 목록 새로 읽기. 누가 돌리는 실행이 있으면 2초, 없으면 15초마다 (화면을 안 보고 있을 때 저절로 읽는 것은 건너뜀)
async function refreshRuns(auto = false) {
  clearTimeout(S.histTimer);
  let ok = false;
  if (!auto || !document.hidden) {
    try {
      const r = await api('/api/runs');
      S.runs = r.runs;
      S.workers = r.workers;
      S.defaults = r.defaults;
      renderHistory();
      ok = true;
    } catch {
      // 목록을 못 읽으면 다음 차례에 다시
    }
  }
  S.histTimer = setTimeout(() => refreshRuns(true), S.runs.some((v) => ACTIVE.has(v.status)) ? 2000 : 15000);
  return ok;
}

function resultCell(v) {
  if (v.status === 'done') {
    return `혐의 대상 <b>${fmt.int(v.targets)}</b>개 · ${fmt.int(v.wafers)}장 · ${dur(v.seconds)}${v.old ? '<span class="tag" title="판정 코드가 바뀌기 전에 계산한 결과">이전 코드</span>' : ''}`;
  }
  if (v.status === 'running') return `<span class="live"></span>실행 중 · ${esc(v.text)} · ${dur(v.seconds)}`;
  if (v.status === 'queued') return `<span class="live"></span>${v.ahead ? `대기 중 · 앞에 ${v.ahead}개` : '시작하는 중'}`;
  return `<span class="errtxt">오류</span><div class="note err" title="${esc(v.error || '')}">${esc(v.error || '')}</div>`;
}

function renderHistory() {
  const q = S.histQ.trim().toLowerCase();
  const hay = (v) => [...(v.job_ids || []), ...(v.analysis_dates || []), v.file_name || ''].join(' ').toLowerCase();
  const rows = q ? S.runs.filter((v) => hay(v).includes(q)) : S.runs;
  $('#hist-sub').textContent = S.runs.length ? `${S.runs.length}개 · 고르면 다시 계산하지 않고 저장된 결과를 엽니다 · 모든 사용자가 함께 보는 목록` : '';
  if (!rows.length) {
    $('#history').innerHTML = `<div class="empty muted">${S.runs.length ? '찾는 기록이 없습니다.' : '아직 실행 기록이 없습니다. raw.csv를 올리고 Run을 누르면 여기에 남습니다.'}</div>`;
    return;
  }
  const body = rows.map((v) => {
    const st = settingsText(v.settings);
    const jobs = v.job_ids || [];
    const dates = v.analysis_dates || [];
    const many = (a) => (a.length ? esc(a[0]) + (a.length > 1 ? ` <span class="muted">외 ${a.length - 1}개</span>` : '') : '<span class="muted">–</span>');
    const busy = ACTIVE.has(v.status);
    return `<tr data-id="${esc(v.id)}"${v.id === S.runId ? ' class="on"' : ''}>
      <td class="l nowrap" title="${when(v.created, true)}">${when(v.created)}</td>
      <td class="l path" title="${esc(jobs.join(', '))}">${many(jobs)}</td>
      <td class="l nowrap" title="${esc(dates.join(', '))}">${many(dates)}</td>
      <td class="l"><div class="fname">${esc(v.file_name || v.file_id)}</div>${v.file_exists ? '' : '<div class="note">올린 파일이 지워져 다시 계산은 못 함</div>'}</td>
      <td class="l">${esc(st.main)}${st.extra ? `<div class="note">${esc(st.extra)}</div>` : ''}</td>
      <td class="l">${resultCell(v)}</td>
      <td><button type="button" class="ghost del" data-del="${esc(v.id)}" title="${busy ? '계산을 멈추고 기록 삭제' : '기록 삭제'}">삭제</button></td>
    </tr>`;
  }).join('');
  $('#history').innerHTML = `<table class="rank hist"><thead><tr><th class="l">Run time</th><th class="l">job_id</th><th class="l">analysis_date</th>
    <th class="l">File</th><th class="l">Settings</th><th class="l">Result</th><th></th></tr></thead><tbody>${body}</tbody></table>`;
}

async function removeRun(id) {
  const v = S.runs.find((x) => x.id === id);
  if (!v) return;
  const what = `${(v.job_ids || [])[0] || v.file_name || v.file_id} · ${when(v.created, true)} 실행`;
  const msg = ACTIVE.has(v.status)
    ? `돌고 있는 판정을 멈추고 이 기록을 지울까요?\n${what}`
    : `이 실행 기록을 지울까요? 서버에 저장된 결과도 지워져 되돌릴 수 없습니다.\n${what}`;
  if (!confirm(msg)) return;
  try {
    await api(`/api/runs/${id}`, { method: 'DELETE' });
  } catch (e) {
    status('지우지 못했습니다: ' + esc(e.message), 'error');
    return;
  }
  if (S.runId === id) {
    S.watch++;
    S.runId = null;
    setHash(null);
    hideResults();
    status('실행 기록을 지웠습니다.');
  }
  await refreshRuns();
}

function setSeg(sel, v) {
  for (const b of $$(sel + ' button')) b.classList.toggle('on', b.dataset.v === v);
}

// ── 요약 ───────────────────────────────────────────────────────────────
function renderSummary() {
  const I = S.res.info;
  const d = I.data;
  const j = I.judge;
  const notes = [...I.notes];
  if (j.spread > 1) notes.push(`z가 이론보다 ${j.spread.toFixed(2)}배 퍼짐 → 기준선도 ${j.spread.toFixed(2)}배로`);
  const st = I.settings;
  const groups = j.groups.map((g) => `<tr><td>Order ${esc(g.name)}</td><td>${fmt.int(g.possible)}</td><td>${g.z == null ? '–' : g.z.toFixed(2)}</td><td>${g.z_spread == null ? '–' : g.z_spread.toFixed(2)}</td></tr>`).join('');
  const v = S.runs.find((x) => x.id === S.runId);
  const jobs = d.job_ids || [];
  $('#summary').innerHTML = [
    `<div><b>실행</b> job_id ${jobs.length ? esc(jobs.join(', ')) : '–'} · analysis_date ${esc((d.analysis_dates || []).join(', ') || '–')}${v ? ` · ${esc(v.file_name || '')} · ${when(v.created, true)} 실행` : ''}</div>`,
    `<div><b>데이터</b> 웨이퍼 ${fmt.int(d.wafers)}장${d.n_excluded ? ` (good_bad N 등 ${fmt.int(d.n_excluded)}장은 계산에서 뺌)` : ''} · lot ${fmt.int(d.lots)}개 · STEP ${fmt.int(d.steps)}개 (STEP SEQ ${fmt.int(d.step_seqs)}개)${d.bad_rate != null ? ` · bad 비율 ${fmt.pct(d.bad_rate)}` : ''}</div>`,
    `<div><b>보정</b> ${notes.length ? esc(notes.join(' · ')) : '필요 없음'}</div>`,
    `<div><b>판정</b> 조합 ${fmt.int(j.combos)}개 검사 (가능한 ${fmt.int(j.possible)}개 중) → 기준선 밖 ${fmt.int(j.over)}개 → 혐의 대상 ${fmt.int(j.targets)}개 · ${I.timings.total}초</div>`,
    I.warnings.length ? `<div class="warn"><b>확인할 점</b> ${esc(I.warnings.join(' · '))}</div>` : '',
    `<details><summary>판정 정보</summary>
      <table><tr><th>묶음</th><th>가능한 조합</th><th>기본 기준 z</th><th>기준 z (퍼짐 반영)</th></tr>${groups}</table>
      <div class="muted small">5%를 묶음 ${j.groups.length}개에 똑같이 나눔 · 조합이 나온 가장 큰 Order 수 ${j.depth} ·
      ${j.sigma ? `Order 2개 이상에서 웨이퍼 ${j.sigma}장 미만은 가장 나쁜 경우에도 기준선을 넘을 수 없어 만들지 않음` : '넘을 수 없는 조합 없음'} ·
      같은 Order ${fmt.int(j.same_orders)}개는 앞 Order로 합쳐 계산 · MIN_N ${st.min_n} · MAX_DEPTH ${st.max_depth ?? '제한 없음'}</div></details>`,
  ].join('');
}

// ── Funnel ─────────────────────────────────────────────────────────────
const Y_TITLE = { judg: '종합 점수 (위쪽이 나쁨)', mean: 'y_value 평균', bad: 'bad 비율' };
const BOUND_NOTE = { judg: '경계선 (판정 기준)', mean: '경계선 (Value만 볼 때 · Order 1개 기준)', bad: '경계선 (bad만 볼 때 · Order 1개 기준)' };

function renderFunnel() {
  const box = $('#funnel');
  const cv = $('canvas', box);
  const sv = $('svg', box);
  const W = box.clientWidth;
  const H = box.clientHeight;
  const dpr = window.devicePixelRatio || 1;
  cv.width = Math.round(W * dpr);
  cv.height = Math.round(H * dpr);
  sv.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const fn = S.res.funnel;
  const m = S.yMode;
  const bd = fn.bounds;
  const ns = bd.n;
  const L = 60, R = W - 14, T = 12, B = H - 48;
  const xs = scaleLog(ns[0], ns[ns.length - 1], L, R);
  const gv = (fn.gray[m] || []).filter((v) => v != null).sort((a, b) => a - b);
  let lo = quantile(gv, 0.002);
  let hi = quantile(gv, 0.998);
  for (const k of fn.marks) if (k[m] != null) { lo = Math.min(lo, k[m]); hi = Math.max(hi, k[m]); }
  const b = bd[m];
  if (b) {                                     // 점들이 모인 웨이퍼 수(가운데)에서는 경계선이 보이게
    const mid = Math.floor(ns.length / 2);
    if (b.lo[mid] != null) lo = Math.min(lo, b.lo[mid]);
    if (b.hi[mid] != null) hi = Math.max(hi, b.hi[mid]);
  }
  if (!isFinite(lo) || !isFinite(hi)) { lo = 0; hi = 1; }
  const pad = (hi - lo || 1) * 0.06;
  lo -= pad; hi += pad;
  if (m === 'bad') { lo = Math.max(0, lo); hi = Math.min(1, hi); }
  const ys = scaleLin(lo, hi, B, T);
  S.fn = { L, R, T, B, xs, ys, lo, hi };
  // 바탕(캔버스): 경계선 사이 칠 → 기준선 안 점
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  g.save();
  g.beginPath();
  g.rect(L, T, R - L, B - T);
  g.clip();
  if (b) {
    g.beginPath();
    let first = true;
    for (let i = 0; i < ns.length; i++) if (b.hi[i] != null) { const x = xs(ns[i]); const y = ys(b.hi[i]); if (first) { g.moveTo(x, y); first = false; } else g.lineTo(x, y); }
    for (let i = ns.length - 1; i >= 0; i--) if (b.lo[i] != null) g.lineTo(xs(ns[i]), ys(b.lo[i]));
    g.closePath();
    g.fillStyle = C.band;
    g.fill();
  }
  g.fillStyle = C.muted;
  g.globalAlpha = 0.45;
  const gn = fn.gray.n;
  const gy = fn.gray[m] || [];
  for (let i = 0; i < gn.length; i++) {
    const v = gy[i];
    if (v == null || v < lo || v > hi) continue;
    g.fillRect(xs(gn[i]) - 1, ys(v) - 1, 2, 2);
  }
  g.restore();
  // 위(SVG): 경계선 · 축 · 경계 밖 점
  let s = `<defs><clipPath id="fclip"><rect x="${L}" y="${T}" width="${R - L}" height="${B - T}"/></clipPath></defs><g clip-path="url(#fclip)">`;
  if (b) {
    const line = (arr) => ns.map((n, i) => (arr[i] == null ? null : `${xs(n).toFixed(1)},${ys(arr[i]).toFixed(1)}`)).filter(Boolean).join(' ');
    s += `<polyline points="${line(b.hi)}" fill="none" stroke="${C.ink2}" stroke-width="1.4"/><polyline points="${line(b.lo)}" fill="none" stroke="${C.ink2}" stroke-width="1.4"/>`;
    if (b.mid != null) s += `<line x1="${L}" x2="${R}" y1="${ys(b.mid)}" y2="${ys(b.mid)}" stroke="${C.line2}" stroke-dasharray="4 3"/>`;
  }
  s += '</g>';
  const yt = m === 'judg' ? [] : linTicks(lo, hi, 5).map((v) => ({ v, l: m === 'bad' ? Math.round(v * 100) + '%' : fmt.tick(v) }));
  s += axes({ L, R, T, B, xs, ys, xt: logTicks(ns[0], ns[ns.length - 1]).map((v) => ({ v, l: fmt.int(v) })), yt, xl: '웨이퍼 수 N (조합을 지난 웨이퍼)', yl: Y_TITLE[m], yo: 44 });
  s += '<g id="fmarks"></g>';
  sv.innerHTML = s;
  drawMarks();
  $('#funnel-legend').innerHTML = [
    `<span class="item"><span class="dot" style="background:${C.muted}"></span>기준선 안 ${fmt.int(fn.gray_total)}개${gn.length < fn.gray_total ? ` (${fmt.int(gn.length)}개만 그림)` : ''}</span>`,
    `<span class="item"><span class="dot" style="background:${C.bad}"></span>bad path ${fmt.int(fn.marks.filter((k) => k.side === 'bad').length)}개</span>`,
    `<span class="item"><span class="dot" style="background:${C.good}"></span>good path ${fmt.int(fn.marks.filter((k) => k.side === 'good').length)}개</span>`,
    `<span class="item">— ${BOUND_NOTE[m]}</span>`,
    `<span class="item"><span class="dot" style="border:2px solid ${C.accent};width:10px;height:10px"></span>선택한 순위</span>`,
  ].join('');
}

function drawMarks() {
  const f = S.fn;
  const host = $('#fmarks');
  if (!f || !host) return;
  const m = S.yMode;
  const sel = S.res.ranking.length ? S.res.ranking[S.rank].rank : null;
  const dim = S.hover != null;
  const marks = S.res.funnel.marks;
  const order = marks.map((k, i) => i).sort((a, b) => (marks[a].rank ? 1 : 0) - (marks[b].rank ? 1 : 0));
  let s = '';
  for (const i of order) {
    const k = marks[i];
    if (k[m] == null) continue;
    const x = f.xs(k.n);
    const y = f.ys(k[m]);
    const mine = k.rank != null && (k.rank === S.hover || k.rank === sel);
    const op = dim && k.rank !== S.hover && k.target !== S.hover ? 0.25 : 1;
    const r = k.rank ? 5 : 3.5;
    s += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r}" fill="${k.side === 'bad' ? C.bad : C.good}" opacity="${op}" data-i="${i}" style="cursor:${k.rank || k.target ? 'pointer' : 'default'}"/>`;
    if (k.rank && k.rank <= 10) s += `<text x="${(x + 8).toFixed(1)}" y="${(y - 7).toFixed(1)}" fill="${C.bad}" font-size="11" font-weight="600" opacity="${op}" pointer-events="none">${k.rank}</text>`;
    if (k.rank != null && k.rank === sel) s += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="10" fill="none" stroke="${C.accent}" stroke-width="2" pointer-events="none"/>`;
    else if (mine) s += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="10" fill="none" stroke="${C.ink}" stroke-width="1.3" pointer-events="none"/>`;
  }
  host.innerHTML = s;
}

function markTip(e) {
  const c = e.target.closest('circle[data-i]');
  if (!c) { hideTip(); return; }
  const k = S.res.funnel.marks[+c.dataset.i];
  const who = k.rank ? `${k.rank}위 혐의 대상` : k.target ? `${k.target}위 대상에 포함 (같이 올라온 조합)` : k.side === 'bad' ? '기준선 밖 (혐의 대상과 묶이지 않음)' : 'good path (기준선보다 뚜렷하게 좋음)';
  showTip(`<b>${esc(k.label)}</b><br>${who}<br>웨이퍼 ${fmt.int(k.n)}장 · Order ${k.k}개 · Certainty ${k.certainty == null ? '–' : k.certainty.toFixed(2)}`
    + (k.mean != null ? `<br>y_value 평균 ${fmt.num(k.mean)}` : '') + (k.bad != null ? ` · bad ${fmt.pct(k.bad)}` : ''), e.clientX, e.clientY);
}

// ── 순위표 ─────────────────────────────────────────────────────────────
const COLS = [
  { key: 'rank', label: 'Rank' }, { key: 'path', label: 'STEP / Path', left: true }, { key: 'n', label: 'N' },
  { key: 'bad', label: 'Bad %', bad: true }, { key: 'exp_bad', label: 'Exp. bad %', bad: true }, { key: 'excess', label: 'Excess bad' },
  { key: 'certainty', label: 'Certainty' },
];

function sortedRows() {
  const rows = S.res.ranking.map((r, i) => ({ r, i }));
  const { key, dir } = S.sort;
  const val = (o) => (key === 'path' ? `${o.r.step_name} ${o.r.path}` : o.r[key] ?? -Infinity);
  rows.sort((a, b) => (val(a) > val(b) ? dir : val(a) < val(b) ? -dir : a.i - b.i));
  return rows;
}

function renderRanking() {
  const hasBad = S.res.info.has_bad;
  const cols = COLS.filter((c) => hasBad || !c.bad);
  const label = (c) => (c.key === 'excess' && !hasBad ? 'N × ΔValue' : c.label);   // good_bad가 없으면 순위 기준 = 웨이퍼 수 × Value 차이
  const head = cols.map((c) => `<th class="${c.left ? 'l' : ''}" data-k="${c.key}">${label(c)}${S.sort.key === c.key ? (S.sort.dir > 0 ? ' ▴' : ' ▾') : ''}</th>`).join('');
  const cell = (c, r) => {
    switch (c.key) {
      case 'rank': return `<td>${r.rank}</td>`;
      case 'path': return `<td class="l"><div class="step">${esc(r.step_name)}${r.desc ? ' · ' + esc(r.desc) : ''}</div><div class="path">${esc(r.path)}</div>${r.note ? `<div class="note">${esc(r.note)}</div>` : ''}</td>`;
      case 'n': return `<td>${fmt.int(r.n)}</td>`;
      case 'bad': case 'exp_bad': return `<td>${fmt.pct(r[c.key])}</td>`;
      case 'excess': return `<td>${hasBad ? fmt.signed(r.excess) : fmt.num(r.excess)}</td>`;
      default: return `<td>${r.certainty == null ? '–' : r.certainty.toFixed(2)}</td>`;
    }
  };
  const body = sortedRows().map(({ r, i }) => `<tr data-i="${i}" class="${i === S.rank ? 'on' : ''}">${cols.map((c) => cell(c, r)).join('')}</tr>`).join('');
  $('#ranking').innerHTML = S.res.ranking.length
    ? `<table class="rank"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`
    : '<div class="muted" style="padding:10px">기준선을 넘은 혐의 대상이 없습니다.</div>';
  $('#rank-sub').textContent = S.res.ranking.length ? `${S.res.ranking.length}개 · 초과 bad 순` : '';
}

// ── 상세 ───────────────────────────────────────────────────────────────
// 표 안에서만 스크롤해 줄을 보이게 한다 (페이지 전체는 움직이지 않음)
function scrollInto(wrap, tr) {
  const head = $('thead', wrap);
  const w = wrap.getBoundingClientRect();
  const r = tr.getBoundingClientRect();
  const top = w.top + (head ? head.offsetHeight : 0);
  if (r.top < top) wrap.scrollTop -= top - r.top;
  else if (r.bottom > w.bottom) wrap.scrollTop += r.bottom - w.bottom;
}

async function pickRank(i) {
  if (!S.res.ranking.length) return;
  S.rank = Math.max(0, Math.min(S.res.ranking.length - 1, i));
  const row = S.res.ranking[S.rank];
  S.step = row.step;
  S.sel = row.items.map((x) => x.slice());
  renderRanking();
  drawMarks();
  const tr = $(`#ranking tr[data-i="${S.rank}"]`);
  if (tr) scrollInto($('#ranking'), tr);
  await loadDetail();
}

async function loadDetail() {
  const rid = S.runId;
  const seq = ++S.detSeq;
  try {
    const det = await post(`/api/runs/${rid}/detail`, { step: S.step, items: S.sel });
    if (rid !== S.runId || seq !== S.detSeq || !S.res) return;
    S.det = det;
    $('#detail').hidden = false;
    renderDetail();
  } catch (e) {
    status('상세를 불러오지 못했습니다: ' + esc(e.message), 'error');
  }
}

const sameSel = (a, b) => JSON.stringify([...a].sort((x, y) => x[0] - y[0])) === JSON.stringify([...b].sort((x, y) => x[0] - y[0]));

function renderDetail() {
  const D = S.det;
  const row = S.res.ranking[S.rank];
  const orig = sameSel(S.sel, row.items);
  const sel = D.selection;
  $('#dh').innerHTML = `<span class="t">${row.rank}위 · STEP ${esc(D.step_name)}${D.desc ? ' · ' + esc(D.desc) : ''}</span>
    <span class="muted"> · 원래 경로 ${esc(row.path)} · Certainty ${row.certainty == null ? '–' : row.certainty.toFixed(2)}</span>`;
  $('#prev').disabled = S.rank === 0;
  $('#next').disabled = S.rank >= S.res.ranking.length - 1;
  $('#dstat').innerHTML = `지금 선택 <b>${esc(sel.label)}</b> · 웨이퍼 <b>${fmt.int(sel.n)}</b>장`
    + (D.has_bad ? ` · bad <span class="badtxt">${fmt.pct(sel.bad)}</span> (같은 Order를 지난 나머지 ${fmt.int(sel.rest_n)}장 ${fmt.pct(sel.rest_bad)})` : '')
    + ` · y_value 평균 ${fmt.num(sel.vmean)} · Certainty ${sel.certainty == null ? '–' : sel.certainty.toFixed(2)}`
    + (orig ? '' : '<span class="badge">탐색 중 (판정 아님)</span>');
  $('#chips').innerHTML = S.sel.slice().sort((a, b) => a[0] - b[0]).map(([q, u]) => {
    const o = D.orders[q];
    return `<button type="button" class="chip" data-q="${q}" title="이 Order 빼기">${esc(o.name)}:${esc(o.units[u].name)} <span aria-hidden="true">×</span></button>`;
  }).join('');
  $('#reset').disabled = orig;
  renderBlocks();
  renderScatter();
  renderPeers();
  renderCompare();
  renderTrend();
}

function renderBlocks() {
  const D = S.det;
  const selMap = new Map(S.sel.map(([q, u]) => [q, u]));
  const all = D.orders.flatMap((o) => o.units.filter((u) => u.n > 0));
  const key = D.has_bad ? 'bad' : 'vmean';
  const tot = all.reduce((a, u) => a + u.n, 0);
  const base = all.reduce((a, u) => a + (u[key] ?? 0) * u.n, 0) / (tot || 1);
  const dev = Math.max(1e-9, ...all.map((u) => (u[key] ?? base) - base));
  const maxU = Math.max(...D.orders.map((o) => o.units.length));
  let h = `<div class="grid" style="grid-template-columns:repeat(${D.orders.length}, minmax(74px, 1fr))">`;
  h += D.orders.map((o) => `<div class="oh ${selMap.has(o.q) ? 'on' : ''}" title="${esc(o.seq)} · ${esc(o.desc)}">${esc(o.name)}</div>`).join('');
  for (let k = 0; k < maxU; k++) {
    for (const o of D.orders) {
      const u = o.units[k];
      if (!u) { h += '<div></div>'; continue; }
      const on = selMap.get(o.q) === u.u;
      const t = Math.max(0, Math.min(1, ((u[key] ?? base) - base) / dev));
      const bg = on ? '' : `background:color-mix(in srgb, ${C.bad} ${Math.round(t * 40)}%, ${C.band})`;
      const val = D.has_bad ? fmt.pct(u.bad, 0) : fmt.num(u.vmean);
      h += `<div class="b ${on ? 'on' : ''}" style="${bg}" data-q="${o.q}" data-u="${u.u}" title="${esc(o.name)}:${esc(u.name)} · 웨이퍼 ${u.n}장${D.has_bad ? ' · bad ' + fmt.pct(u.bad) : ''} · y_value 평균 ${fmt.num(u.vmean)}"><div class="nm">${esc(u.name)}</div><div>${val} · ${fmt.int(u.n)}</div></div>`;
    }
  }
  $('#blocks').innerHTML = h + '</div>';
}

function svgBox(el, H) {
  const W = Math.max(260, Math.round(el.getBoundingClientRect().width || el.parentElement.clientWidth - 20));
  el.setAttribute('viewBox', `0 0 ${W} ${H}`);
  el.setAttribute('height', H);
  return W;
}

// 산점도 · 비교 차트에서 웨이퍼마다 어느 묶음(색)인지
function waferGroups() {
  const D = S.det;
  const selG = D.sel_group;
  if (S.cMode === 'hi') {
    return { color: (g) => (g === selG ? C.bad : C.muted), items: [{ g: [selG], c: C.bad, l: '선택 경로 ' + (D.groups[selG]?.label ?? '') }, { rest: true, c: C.muted, l: '나머지 (같은 Order를 지난 다른 경로)' }] };
  }
  const order = D.groups.map((x, g) => g).filter((g) => g !== selG).sort((a, b) => D.groups[b].n - D.groups[a].n);
  const top = order.slice(0, PALETTE.length - 1);
  const other = order.slice(PALETTE.length - 1);
  const col = new Map([[selG, C.bad], ...top.map((g, i) => [g, PALETTE[i]])]);
  const items = [{ g: [selG], c: C.bad, l: D.groups[selG]?.label ?? '' }, ...top.map((g, i) => ({ g: [g], c: PALETTE[i], l: D.groups[g].label }))];
  if (other.length) items.push({ g: other, c: C.muted, l: `기타 ${other.length}개 조합` });
  return { color: (g) => col.get(g) ?? C.muted, items };
}

function groupStats(gs) {
  const D = S.det;
  const w = D.wafers;
  let n = 0;
  let b = 0;
  for (let i = 0; i < w.g.length; i++) {
    const g = w.g[i];
    if (gs.rest ? g !== D.sel_group : gs.g.includes(g)) { n++; if (w.b) b += w.b[i]; }
  }
  return { n, bad: n && w.b ? b / n : null };
}

function renderScatter() {
  const D = S.det;
  const el = $('#scatter');
  const H = 320;
  const W = svgBox(el, H);
  const w = D.wafers;
  const idx = w.t.map((t, i) => i).filter((i) => w.t[i] != null);
  const G = waferGroups();
  $('#scatter-legend').innerHTML = G.items.filter((it) => it.g === undefined || it.g[0] >= 0).map((it) => {
    const st = groupStats(it);
    return `<span class="item"><span class="dot" style="background:${it.c}"></span>${esc(it.l)} · ${fmt.int(st.n)}장${st.bad != null ? ' · bad ' + fmt.pct(st.bad) : ''}</span>`;
  }).join('') + (D.missing_time ? `<span class="item">track-in 시각이 없는 웨이퍼 ${D.missing_time}장은 빼고 그림</span>` : '');
  if (!idx.length) { el.innerHTML = `<text x="20" y="40" fill="${C.ink2}">track-in 시각이 있는 웨이퍼가 없습니다</text>`; return; }
  const L = 58, R = W - 12, T = 10, B = H - 46;
  const ts = idx.map((i) => w.t[i]);
  const vs = idx.map((i) => w.v[i]);
  const tlo = Math.min(...ts), thi = Math.max(...ts);
  const log = vs.every((v) => v > 0) && skewness(vs) > 1;
  const sv = vs.slice().sort((a, b) => a - b);
  const vlo = sv[0], vhi = sv[sv.length - 1];
  const xs = scaleLin(tlo - (thi - tlo) * 0.02 - 1, thi + (thi - tlo) * 0.02 + 1, L, R);
  const ys = log ? scaleLog(vlo / 1.08, vhi * 1.08, B, T) : scaleLin(vlo - (vhi - vlo) * 0.05, vhi + (vhi - vlo) * 0.05, B, T);
  const yt = log ? logTicks(vlo, vhi) : linTicks(vlo, vhi, 5);
  let s = axes({ L, R, T, B, xs, ys, xt: timeTicks(tlo, thi, 6), yt: yt.map((v) => ({ v, l: fmt.tick(v) })), xl: `tkin_time (${D.time_order})`, yl: 'y_value' + (log ? ' (로그 눈금)' : ''), yo: 44 });
  const selFirst = idx.slice().sort((a, b) => (w.g[a] === D.sel_group ? 1 : 0) - (w.g[b] === D.sel_group ? 1 : 0));
  for (const i of selFirst) s += `<circle cx="${xs(w.t[i]).toFixed(1)}" cy="${ys(w.v[i]).toFixed(1)}" r="2.8" fill="${G.color(w.g[i])}" opacity="0.85"/>`;
  el.innerHTML = s;
}

function renderPeers() {
  const D = S.det;
  const el = $('#peers');
  const H = 300;
  const W = svgBox(el, H);
  const m = S.pMode;
  const P = D.peers.filter((p) => p[m] != null);
  if (!P.length) { el.innerHTML = `<text x="20" y="40" fill="${C.ink2}">비교할 경로가 없습니다</text>`; return; }
  const L = 56, R = W - 12, T = 10, B = H - 46;
  const nmax = Math.max(...P.map((p) => p.n)) * 1.15;
  const bd = D.peer_bounds && D.peer_bounds[m];
  const bn = D.peer_bounds ? D.peer_bounds.n : [];
  let lo = Math.min(...P.map((p) => p[m]));
  let hi = Math.max(...P.map((p) => p[m]));
  if (bd) {
    const mid = Math.floor(bn.length / 2);
    if (bd.lo[mid] != null) lo = Math.min(lo, bd.lo[mid]);
    if (bd.hi[mid] != null) hi = Math.max(hi, bd.hi[mid]);
  }
  const pad = (hi - lo || 1) * 0.08;
  lo -= pad; hi += pad;
  if (m === 'bad') { lo = Math.max(0, lo); hi = Math.min(1, hi); }
  const xs = scaleLin(0, nmax, L, R);
  const ys = scaleLin(lo, hi, B, T);
  let s = `<defs><clipPath id="pclip"><rect x="${L}" y="${T}" width="${R - L}" height="${B - T}"/></clipPath></defs><g clip-path="url(#pclip)">`;
  if (bd) {
    s += band(bn, bd.lo, bd.hi, xs, ys, [lo, hi]);
    if (bd.mid != null) s += `<line x1="${L}" x2="${R}" y1="${ys(bd.mid)}" y2="${ys(bd.mid)}" stroke="${C.line2}" stroke-dasharray="4 3"/>`;
  }
  s += '</g>';
  const yt = m === 'judg' ? [] : linTicks(lo, hi, 4).map((v) => ({ v, l: m === 'bad' ? Math.round(v * 100) + '%' : fmt.tick(v) }));
  s += axes({ L, R, T, B, xs, ys, xt: linTicks(0, nmax, 5).map((v) => ({ v, l: fmt.int(v) })), yt, xl: '웨이퍼 수', yl: { judg: '종합 점수', mean: 'y_value 평균', bad: 'bad 비율' }[m], yo: 42 });
  const ordered = P.slice().sort((a, b) => (a.g === D.sel_group ? 1 : 0) - (b.g === D.sel_group ? 1 : 0));
  for (const p of ordered) {
    const on = p.g === D.sel_group;
    s += `<circle cx="${xs(p.n).toFixed(1)}" cy="${ys(p[m]).toFixed(1)}" r="${on ? 6 : 4}" fill="${on ? C.bad : C.muted}" opacity="${on ? 1 : 0.85}" data-g="${p.g}"/>`;
  }
  el.innerHTML = s;
}

function peerTip(e) {
  const c = e.target.closest('circle[data-g]');
  if (!c) { hideTip(); return; }
  const D = S.det;
  const g = +c.dataset.g;
  const p = D.peers.find((x) => x.g === g);
  const grp = D.groups[g];
  showTip(`<b>${esc(grp.label)}</b>${g === D.sel_group ? ' (지금 선택)' : ''}<br>웨이퍼 ${fmt.int(p.n)}장${p.bad != null ? ' · bad ' + fmt.pct(p.bad) : ''} · y_value 평균 ${fmt.num(p.mean)}<br>Certainty ${p.certainty == null ? '–' : p.certainty.toFixed(2)}`, e.clientX, e.clientY);
}

function renderCompare() {
  const D = S.det;
  const el = $('#compare');
  const H = 300;
  const W = svgBox(el, H);
  const w = D.wafers;
  const mem = [];
  const rest = [];
  w.g.forEach((g, i) => (g === D.sel_group ? mem : rest).push(i));
  const L = 66, R = W - 46;
  const GR = [[mem, '이 경로', C.bad], [rest, '나머지', C.muted]];
  let s = '';
  let y0 = 14;
  if (D.has_bad) {
    const br = (a) => (a.length ? a.reduce((x, i) => x + w.b[i], 0) / a.length : 0);
    const bmax = Math.max(br(mem), br(rest), 0.05) * 1.25;
    s += `<text x="0" y="${y0}" fill="${C.ink2}" font-size="12">bad 비율</text>`;
    GR.forEach(([a, l, c], k) => {
      const y = y0 + 8 + k * 20;
      const bw = (br(a) / bmax) * (R - L);
      s += `<text x="${L - 6}" y="${y + 11}" text-anchor="end" fill="${C.ink2}" font-size="12">${l}</text><rect x="${L}" y="${y}" width="${bw.toFixed(1)}" height="14" rx="3" fill="${c}"/>`
        + `<text x="${(L + bw + 5).toFixed(1)}" y="${y + 11}" fill="${C.ink}" font-size="12">${fmt.pct(br(a))} · ${fmt.int(a.length)}장</text>`;
    });
    y0 += 70;
  }
  const vals = [...mem, ...rest].map((i) => w.v[i]);
  if (!vals.length) { el.innerHTML = s; return; }
  const log = vals.every((v) => v > 0) && skewness(vals) > 1;
  const sv = vals.slice().sort((a, b) => a - b);
  const xs = log ? scaleLog(sv[0] / 1.05, sv[sv.length - 1] * 1.05, L, R) : scaleLin(sv[0], sv[sv.length - 1], L, R);
  s += `<text x="0" y="${y0}" fill="${C.ink2}" font-size="12">y_value 분포 · 상자 = 가운데 50% · 굵은 선 = 중앙값</text>`;
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
  GR.forEach(([a, l, c], k) => {
    const v = a.map((i) => w.v[i]).sort((x, y) => x - y);
    const y = y0 + 14 + k * 46;
    s += `<text x="${L - 6}" y="${y + 20}" text-anchor="end" fill="${C.ink2}" font-size="12">${l}</text>`;
    if (!v.length) return;
    const q = [0.05, 0.25, 0.5, 0.75, 0.95].map((p) => quantile(v, p));
    const show = a.length > 600 ? a.filter((_, j) => j % Math.ceil(a.length / 600) === 0) : a;
    for (const i of show) s += `<circle cx="${xs(w.v[i]).toFixed(1)}" cy="${(y + 16 + rnd() * 24).toFixed(1)}" r="2" fill="${c}" opacity="0.45"/>`;
    s += `<line x1="${xs(q[0])}" x2="${xs(q[4])}" y1="${y + 16}" y2="${y + 16}" stroke="${c}" stroke-width="1.2"/>`
      + `<rect x="${xs(q[1])}" y="${y + 4}" width="${Math.max(1, xs(q[3]) - xs(q[1]))}" height="24" fill="none" stroke="${c}" stroke-width="1.4"/>`
      + `<line x1="${xs(q[2])}" x2="${xs(q[2])}" y1="${y + 2}" y2="${y + 30}" stroke="${C.ink}" stroke-width="2.2"/>`;
  });
  const ay = y0 + 14 + 2 * 46 + 4;
  const tk = log ? logTicks(sv[0], sv[sv.length - 1]) : linTicks(sv[0], sv[sv.length - 1], 5);
  s += `<line x1="${L}" x2="${R}" y1="${ay}" y2="${ay}" stroke="${C.line2}"/>` + tk.map((v) => `<text x="${xs(v)}" y="${ay + 14}" text-anchor="middle" fill="${C.ink2}" font-size="11">${fmt.tick(v)}</text>`).join('')
    + `<text x="${(L + R) / 2}" y="${ay + 30}" text-anchor="middle" fill="${C.ink}" font-size="12">y_value${log ? ' (로그 눈금)' : ''}</text>`;
  el.setAttribute('height', Math.max(H, ay + 40));
  el.setAttribute('viewBox', `0 0 ${W} ${Math.max(H, ay + 40)}`);
  el.innerHTML = s;
}

function rolling(points, win, useMedian) {
  const out = [];
  for (let i = win - 1; i < points.length; i++) {
    const seg = points.slice(i - win + 1, i + 1).map((p) => p[1]);
    let v;
    if (useMedian) { seg.sort((a, b) => a - b); v = quantile(seg, 0.5); } else v = seg.reduce((a, b) => a + b, 0) / win;
    out.push([points[i][0], v]);
  }
  return out;
}

function renderTrend() {
  const D = S.det;
  const el = $('#trend');
  const H = 300;
  const W = svgBox(el, H);
  const w = D.wafers;
  const hasBad = D.has_bad;
  const pts = (pred) => w.t.map((t, i) => [t, hasBad ? w.b[i] : w.v[i], i]).filter((p) => p[0] != null && pred(p[2])).sort((a, b) => a[0] - b[0]);
  const me = pts((i) => w.g[i] === D.sel_group);
  const rs = pts((i) => w.g[i] !== D.sel_group);
  if (me.length < 4) { el.innerHTML = `<text x="20" y="40" fill="${C.ink2}">시각이 있는 웨이퍼가 적어 추이를 그리지 않습니다</text>`; return; }
  const wm = Math.max(8, Math.min(60, Math.round(me.length / 8)));
  const wr = Math.max(20, Math.min(250, Math.round(rs.length / 20)));
  const lm = rolling(me, Math.min(wm, me.length), !hasBad);
  const lr = rs.length >= wr ? rolling(rs, wr, !hasBad) : [];
  const L = 56, R = W - 12, T = 22, B = H - 46;
  const all = [...me, ...rs];
  const tlo = Math.min(...all.map((p) => p[0]));
  const thi = Math.max(...all.map((p) => p[0]));
  const vals = [...lm, ...lr].map((p) => p[1]);
  let lo = hasBad ? 0 : Math.min(...vals);
  let hi = Math.max(...vals);
  if (hasBad) hi = Math.min(1, Math.max(0.1, hi * 1.15)); else { const pad = (hi - lo || 1) * 0.1; lo -= pad; hi += pad; }
  const xs = scaleLin(tlo, thi || tlo + 1, L, R);
  const ys = scaleLin(lo, hi, B, T);
  let s = axes({ L, R, T, B, xs, ys, xt: timeTicks(tlo, thi, 4), yt: linTicks(lo, hi, 4).map((v) => ({ v, l: hasBad ? Math.round(v * 100) + '%' : fmt.tick(v) })),
    xl: `tkin_time (${D.time_order})`, yl: hasBad ? 'bad 비율 (이동 평균)' : 'y_value (이동 중앙값)', yo: 42 });
  const line = (p, c, wdt) => (p.length ? `<polyline points="${p.map((q) => `${xs(q[0]).toFixed(1)},${ys(q[1]).toFixed(1)}`).join(' ')}" fill="none" stroke="${c}" stroke-width="${wdt}"/>` : '');
  s += line(lr, C.muted, 1.6) + line(lm, C.bad, 2.2);
  s += `<text x="${R}" y="12" text-anchor="end" font-size="11"><tspan fill="${C.bad}">— 이 경로 (${wm}장씩)</tspan><tspan fill="${C.ink2}">  — 나머지 (${wr}장씩)</tspan></text>`;
  el.innerHTML = s;
}

// ── 이벤트 ─────────────────────────────────────────────────────────────
function bindAxisTips(sel) {
  for (const b of $$(sel + ' button')) {
    b.addEventListener('mouseenter', (e) => {
      const k = b.dataset.v;
      const r = b.getBoundingClientRect();
      showTip(`<b>${AXIS_TIP[k][0]}</b><svg viewBox="0 0 230 84" width="230" height="84">${axisTipSvg(k)}</svg><div class="muted">${AXIS_TIP[k][1]}</div>`, r.left, r.bottom - 8);
    });
    b.addEventListener('mouseleave', hideTip);
  }
}

let resizeTimer = null;
function rerender() {
  if (!S.res) return;
  renderFunnel();
  if (S.det) renderDetail();
}

function init() {
  readColors();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { readColors(); rerender(); });
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(rerender, 150); });
  $('#file').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const meta = await upload(f);
      await loadFiles(meta.id);
      status(`올렸습니다 · ${esc(meta.name)} (${(meta.size / 1e6).toFixed(0)}MB). Run을 누르세요.`);
    } catch (err) {
      status(esc(err.message), 'error');
    }
    e.target.value = '';
  });
  $('#recent').addEventListener('change', (e) => { S.fileId = e.target.value || null; });
  $('#no_limit').addEventListener('change', (e) => { $('#max_depth').disabled = e.target.checked; });
  $('#adv-btn').addEventListener('click', () => {
    const adv = $('#adv');
    adv.hidden = !adv.hidden;
    $('#adv-btn').setAttribute('aria-expanded', String(!adv.hidden));
    $('#adv-ico').textContent = adv.hidden ? '▾' : '▴';
  });
  $('#run').addEventListener('click', run);
  $('#history').addEventListener('click', (e) => {
    const del = e.target.closest('[data-del]');
    if (del) { removeRun(del.dataset.del); return; }
    const tr = e.target.closest('tbody tr[data-id]');
    if (tr && (tr.dataset.id !== S.runId || !S.res)) openRun(tr.dataset.id);
  });
  $('#hist-q').addEventListener('input', (e) => { S.histQ = e.target.value; renderHistory(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshRuns(); });   // 다시 보면 바로 새로 읽음
  for (const [sel, key, draw] of [['#yseg', 'yMode', () => renderFunnel()], ['#pseg', 'pMode', () => renderPeers()], ['#cseg', 'cMode', () => { renderScatter(); }]]) {
    $(sel).addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b || b.disabled || !S.res) return;
      S[key] = b.dataset.v;
      setSeg(sel, b.dataset.v);
      draw();
    });
  }
  bindAxisTips('#yseg');
  bindAxisTips('#pseg');
  const fsv = $('#funnel svg');
  fsv.addEventListener('mousemove', markTip);
  fsv.addEventListener('mouseleave', hideTip);
  fsv.addEventListener('click', (e) => {
    const c = e.target.closest('circle[data-i]');
    if (!c) return;
    const k = S.res.funnel.marks[+c.dataset.i];
    const r = k.rank || k.target;
    if (r) pickRank(r - 1);
  });
  const tbl = $('#ranking');
  tbl.addEventListener('mouseover', (e) => {
    const tr = e.target.closest('tbody tr');
    const r = tr ? S.res.ranking[+tr.dataset.i].rank : null;
    if (r !== S.hover) { S.hover = r; drawMarks(); }
  });
  tbl.addEventListener('mouseleave', () => { S.hover = null; drawMarks(); });
  tbl.addEventListener('click', (e) => {
    const th = e.target.closest('th');
    if (th) {
      const k = th.dataset.k;
      S.sort = { key: k, dir: S.sort.key === k ? -S.sort.dir : (k === 'rank' || k === 'path' ? 1 : -1) };
      renderRanking();
      return;
    }
    const tr = e.target.closest('tbody tr');
    if (tr) pickRank(+tr.dataset.i);
  });
  tbl.addEventListener('keydown', (e) => {
    if (!S.res || !['ArrowDown', 'ArrowUp'].includes(e.key)) return;
    e.preventDefault();
    const rows = sortedRows().map((o) => o.i);
    const at = rows.indexOf(S.rank);
    const next = rows[Math.max(0, Math.min(rows.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (next !== undefined && next !== S.rank) pickRank(next);
  });
  $('#prev').addEventListener('click', () => pickRank(S.rank - 1));
  $('#next').addEventListener('click', () => pickRank(S.rank + 1));
  $('#reset').addEventListener('click', () => { S.sel = S.res.ranking[S.rank].items.map((x) => x.slice()); loadDetail(); });
  $('#chips').addEventListener('click', (e) => {
    const b = e.target.closest('.chip');
    if (!b || S.sel.length <= 1) return;
    S.sel = S.sel.filter(([q]) => q !== +b.dataset.q);
    loadDetail();
  });
  $('#blocks').addEventListener('click', (e) => {
    const b = e.target.closest('.b[data-q]');
    if (!b) return;
    const q = +b.dataset.q;
    const u = +b.dataset.u;
    const at = S.sel.findIndex(([qq]) => qq === q);
    if (at >= 0 && S.sel[at][1] === u) {
      if (S.sel.length <= 1) return;
      S.sel.splice(at, 1);
    } else if (at >= 0) S.sel[at][1] = u;
    else S.sel.push([q, u]);
    loadDetail();
  });
  $('#peers').addEventListener('mousemove', peerTip);
  $('#peers').addEventListener('mouseleave', hideTip);
  loadFiles().catch((e) => status('파일 목록을 읽지 못했습니다: ' + esc(e.message), 'error'))
    .then(() => refreshRuns())
    .then((ok) => {
      const m = /^#run=([0-9a-f]+)$/.exec(location.hash);        // 주소에 실행 id가 있으면 그 기록을 연다 (링크 공유)
      if (m && S.runs.some((v) => v.id === m[1])) openRun(m[1]);
      else if (m && ok) setHash(null);
    });
}

document.addEventListener('DOMContentLoaded', init);
