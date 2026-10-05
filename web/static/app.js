'use strict';
// 화면 동작
//  · 시작 화면: Job ID로 실행 기록 찾기 · DB에서 가져와 분석 · raw.csv 올리기 · 최근 실행 · 사용자 가이드
//  · 분석 화면: 데이터(Job ID 또는 raw.csv) · 설정 → Run(진행 상태) → funnel · 순위표(서로 연동, 여러 개 고르기)
//    → 여러 개를 고르면 비교 띠 → 상세 하나(◀ ▶ · 비교 띠 · 묶음 버튼으로 대상을 바꿈).
//    실행 기록에서 고르면 저장된 결과를 다시 계산하지 않고 연다
// 주소: #run=<실행 id> 그 실행의 결과 · #analysis 분석 화면 · 그 밖은 시작 화면

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const CMP_MAX = 200;                 // 비교 띠에 그리는 최대 대상 수
const S = {
  view: null, fileId: null, runId: null, res: null, hover: null, yMode: 'judg', sort: { key: 'rank', dir: 1 }, fn: null,
  brush: null, brushed: false, hintTimer: null,
  picks: [], focus: null, ptSize: 4.5, files: [],
  cur: null, open: new Set(), panel: null, cmp: null, cmpSeq: 0, cmpPending: null,   // 상세에 보이는 대상 · 묶인 대상을 펼친 순위 · 상세 카드 · 비교 띠 값
  runs: [], workers: 1, watch: 0, histTimer: null, histQ: '', defaults: null,
  db: false,                                          // 서버에 DB 접속 정보가 있는지 (없으면 raw.csv로만)
  fView: 'all', pendingDel: new Set(), toasts: [], conclText: '',   // funnel 보는 범위 · 지우기 기다리는 실행 · 떠 있는 알림 · 결론 문장
  home: { items: [], at: -1, mode: null, q: '', db: false },
};

// 이 브라우저에만 남기는 화면 설정 (못 읽거나 못 써도 화면은 그대로)
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 저장하지 못해도 괜찮음 */ } },
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
const smooth = () => (matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');

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

// ── 알림: 화면 아래에 잠깐 뜨는 안내. 되돌리기 같은 버튼을 붙일 수 있다 ──────────────
function toast(html, { actions = [], timeout = 4000, onTimeout = null, kind = '' } = {}) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  el.innerHTML = `<span class="t-msg">${html}</span>${actions.map((a, i) => `<button type="button" class="t-act" data-i="${i}">${esc(a.label)}</button>`).join('')}`
    + '<button type="button" class="t-x" aria-label="알림 닫기"><svg class="ico-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button>';
  let timer = null;
  let done = false;
  const handle = {};
  const close = (expire) => {                          // expire = 시간이 다 됨(또는 ✕): 지우기 같은 미뤄 둔 일을 한다
    if (done) return;
    done = true;
    clearTimeout(timer);
    el.classList.add('out');
    setTimeout(() => el.remove(), 200);
    S.toasts = S.toasts.filter((t) => t !== handle);
    if (expire && onTimeout) onTimeout();
  };
  handle.close = close;
  const arm = (ms) => { clearTimeout(timer); if (ms) timer = setTimeout(() => close(true), ms); };
  el.addEventListener('click', (e) => {
    const b = e.target.closest('.t-act');
    if (b) { close(false); const a = actions[+b.dataset.i]; if (a.fn) a.fn(); return; }
    if (e.target.closest('.t-x')) close(true);
  });
  el.addEventListener('mouseenter', () => clearTimeout(timer));          // 읽는 동안은 닫지 않는다
  el.addEventListener('mouseleave', () => arm(timeout ? Math.max(2500, timeout / 2) : 0));
  S.toasts.push(handle);
  while (S.toasts.length > 4) S.toasts[0].close(true);
  $('#toasts').appendChild(el);
  arm(timeout);
  return handle;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 사내 서버(http)에서는 clipboard API가 막혀 있어 예전 방식으로
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;left:-9999px;opacity:0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}

// CSV 내려받기: 첫 줄 = 열 이름. 엑셀에서 한글이 깨지지 않게 BOM을 붙이고, 수식으로 읽힐 글자(= + @)는 막는다
function download(name, rows) {
  const cell = (v) => {
    let x = v == null ? '' : String(v);
    if (/^[=+@]/.test(x)) x = "'" + x;
    return /[",\r\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x;
  };
  const url = URL.createObjectURL(new Blob(['\ufeff' + rows.map((r) => r.map(cell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
const safeName = (x) => String(x ?? '').replace(/[^\w.가-힣-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 60);
const jobTag = () => safeName((S.res?.info.data.job_ids || [])[0] || 'run');
const isoTime = (ms) => (ms == null ? '' : new Date(ms).toISOString().slice(0, 19).replace('T', ' '));   // 시각은 raw.csv에 적힌 그대로(시간대 변환 없이)

// 용어 도움말: data-help가 붙은 곳에 마우스를 올리면 뜻과 예시가 나온다
const HELP = {
  rank: '초과 bad(실제 bad 장수 − 예상 bad 장수)가 큰 순서입니다. 웨이퍼가 90% 이상 같은 대상은 한 줄로 묶습니다.',
  path: 'STEP 이름 · 설명과, 그 STEP 안에서 웨이퍼가 지난 Order:Unit 경로입니다. 예: O1:ETC101-A → O3:ETC301-A = 1번 Order에서 ETC101-A, 3번 Order에서 ETC301-A를 지난 웨이퍼.',
  n: '이 경로를 지난 웨이퍼 수입니다.',
  bad: '이 경로 웨이퍼 중 bad(good_bad = B)의 비율입니다.',
  exp_bad: '웨이퍼들의 part 구성으로 보면 나와야 할 bad 비율입니다. 예: bad가 잦은 part의 웨이퍼가 많이 지났으면 높게 잡힙니다.',
  excess: '실제 bad 장수 − 예상 bad 장수 = 이 경로를 고치면 줄어들 bad 웨이퍼 수입니다. 예: +17 = 예상보다 17장 더 bad.',
  dvalue: 'good_bad가 없을 때의 순위 기준: 웨이퍼 수 × (이 경로 y_value 평균 − 전체 평균).',
  certainty: '기준선 대비 위치입니다. 1을 넘으면 기준선 밖(우연으로 보기 어려움)입니다. 예: 2.0 = 가운데 선에서 기준선까지 거리의 2배만큼 벗어남.',
  overlap: '두 대상의 웨이퍼를 합친 것 중 양쪽 모두에 있는 비율입니다. 100%면 웨이퍼가 똑같아 데이터로는 둘을 가릴 수 없습니다.',
  rest: '이 경로의 Order를 모두 지났지만 그중 하나 이상에서 다른 Unit을 지난 웨이퍼입니다. 예: 경로가 O1:A → O3:B면 O1과 O3을 모두 지났는데 O1:A → O3:C, O1:D → O3:B처럼 지난 웨이퍼. bad 비율은 그 웨이퍼 전체의 bad 장수 ÷ 웨이퍼 수입니다.',
  cmp: '빨간 점 = 이 경로, 회색 점 = 같은 Order를 다른 Unit으로 지난 웨이퍼. 두 점이 멀수록 이 경로만 나쁩니다. 겹침 = 위쪽 순위와 웨이퍼가 겹치는 비율(50% 이상만 표시).',
};

// ── 파일 ───────────────────────────────────────────────────────────────
async function loadFiles(selectId) {
  S.files = await api('/api/files');
  if (selectId) attachFile(selectId);
}

function upload(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const fd = new FormData();
    fd.append('file', file);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
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
const uploadBar = (name, p) => `올리는 중 · ${esc(name)} · ${Math.round(p * 100)}%<div class="bar"><i style="width:${p * 100}%"></i></div>`;

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

const STAGE_FRAC = { queued: 0.01, start: 0.02, fetch: 0.04, read: 0.08, prepare: 0.22, analyze: 0.3, judge: 0.86, payload: 0.95 };
const JOB_RE = /^\d{1,18}$/;

// Run에 쓸 데이터: 왼쪽 csv로 붙인 raw.csv가 있으면 그 파일, 없으면 Job ID로 DB에서 가져온다
function attachFile(id, name) {
  const f = S.files.find((x) => x.id === id);
  S.fileId = id;
  $('#q-file-name').textContent = (f ? f.name : name || id) + (f ? ` · ${(f.size / 1e6).toFixed(0)}MB` : '');
  $('#q-file').hidden = false;
  $('#job_id').hidden = true;
}

function detachFile(jid) {
  S.fileId = null;
  $('#q-file').hidden = true;
  $('#job_id').hidden = false;
  if (jid != null) $('#job_id').value = jid;
}

function syncDb() {                                   // 서버에 DB 접속 정보가 없으면 Job ID 칸을 막고 raw.csv로 안내
  const inp = $('#job_id');
  inp.disabled = !S.db;
  inp.placeholder = S.db ? 'Job ID를 입력하세요 (예: 2281935)' : '서버에 DB 접속 정보가 없습니다 · 왼쪽 csv로 raw.csv를 올리세요';
  const note = $('#src-note');
  note.hidden = S.db;
  note.textContent = S.db ? '' : 'Job ID로 가져오려면 관리자가 서버의 .env에 COMBI_DB_URL을 넣어야 합니다. 지금은 raw.csv로 분석할 수 있습니다.';
}

async function run() {
  const job = !S.fileId;
  const jid = $('#job_id').value.trim();
  if (job && !S.db) { status('왼쪽 csv로 raw.csv를 올려 주세요. 서버에 DB 접속 정보가 없어 Job ID로는 가져올 수 없습니다.', 'error'); return; }
  if (job && !JOB_RE.test(jid)) { status('Job ID를 숫자로 넣거나(예: 2281935) 왼쪽 csv로 raw.csv를 올려 주세요.', 'error'); $('#job_id').focus(); return; }
  $('#run').disabled = true;
  let r;
  try {
    r = job ? await post('/api/jobs', { job_id: jid, settings: settings() }) : await post('/api/runs', { file_id: S.fileId, settings: settings() });
  } catch (e) {
    status(esc(e.message), 'error');
    $('#run').disabled = false;
    return;
  }
  $('#run').disabled = false;
  await refreshRuns();
  const note = !r.reused ? '' : job ? '같은 Job ID · 같은 설정으로 가져오는 중인 실행이 있어 그 실행을 함께 봅니다.'
    : '같은 파일 · 같은 설정으로 실행한 기록이 있어 저장된 결과를 열었습니다 (다시 계산하지 않음).';
  await openRun(r.run_id, note);
}

// ── 화면 전환 ─────────────────────────────────────────────────────────
function route() {
  const m = /^#run=([0-9a-f]+)$/.exec(location.hash);
  const view = m || location.hash === '#analysis' ? 'app' : 'home';
  const changed = view !== S.view;
  S.view = view;
  $('#home').hidden = view !== 'home';
  $('#app').hidden = view !== 'app';
  hideTip();
  if (view === 'home') {
    homeClose();
    closeDrawer();
    refreshRuns();
    if (changed) $('#home-q').focus();
    return;
  }
  if (m && m[1] !== S.runId) { openRun(m[1], '', false); return; }
  if (!m && S.runId) {                       // #analysis: 고른 실행 없이 설정 · 실행 기록만
    S.watch++;
    S.runId = null;
    hideLoader();
    hideResults();
    renderHistory();
  }
  if (changed) rerender();                   // 숨어 있는 동안 그린 차트는 크기가 0이라 다시 그린다
}

function go(hash) {
  if (location.hash !== hash) history.pushState(null, '', hash);
  route();
}

// 실행 하나를 연다: 끝났으면 저장된 결과를 바로, 돌고 있으면 진행 상태를 보다가 끝나면 연다. 다른 실행을 열면 앞의 기다림은 멈춘다
async function openRun(id, note = '', push = true) {
  const token = ++S.watch;
  S.runId = id;
  const h = '#run=' + id;
  if (location.hash !== h) history[push ? 'pushState' : 'replaceState'](null, '', h);
  if (S.view !== 'app') route();
  const v = S.runs.find((x) => x.id === id);
  if (v) {
    fillSettings(v.settings);
    if (v.file_exists) attachFile(v.file_id, v.file_name);   // DB에서 가져온 실행도 다시 돌릴 때는 가져온 raw.csv를 쓴다
    else if (v.job_source) detachFile(v.job_source);
  }
  renderHistory();
  hideLoader();
  for (;;) {
    let st;
    try {
      st = await api(`/api/runs/${id}`);
    } catch (e) {
      if (token === S.watch) {
        hideLoader();
        hideResults();
        status(esc(e.message), 'error');
        S.runId = null;
        history.replaceState(null, '', '#analysis');
        renderHistory();
      }
      return;
    }
    if (token !== S.watch) return;
    if (st.status === 'done') {
      if (v && v.status !== 'done') refreshRuns();
      hideLoader();
      if (st.job_source && st.file_exists && S.fileId !== st.file_id) {
        try { await loadFiles(st.file_id); } catch { /* 파일 목록을 못 읽어도 결과는 연다 */ }   // DB에서 가져온 raw.csv를 붙여 두어 설정만 바꿔 다시 돌릴 때는 DB에 다시 묻지 않는다
      }
      await loadResult(id, token, note);
      return;
    }
    hideResults();
    if (st.status === 'error') {
      hideLoader();
      if (st.no_data) {                                  // DB에 없으면 raw.csv를 올려서 분석
        detachFile();
        status(`${esc(st.error)} <button type="button" class="mini" data-act="upload">raw.csv 올리기</button>`, 'error');
      } else status('실행 중 오류: ' + esc(st.error), 'error');
      refreshRuns();
      return;
    }
    let frac = STAGE_FRAC[st.stage] ?? 0.5;
    const m = /Order (\d+)개/.exec(st.text || '');
    if (st.stage === 'analyze' && m) frac = Math.min(0.84, 0.3 + 0.09 * parseInt(m[1], 10));
    const text = st.status === 'queued' && st.ahead ? `앞에 실행 ${st.ahead}개가 끝나기를 기다리는 중 (동시에 ${S.workers}개까지 실행)` : st.text || '실행 중';
    status('');
    showLoader(text, st.seconds, frac);
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
  for (const r of res.ranking) {                       // 예전 코드로 저장한 결과에는 없는 값
    r.parts = r.parts || r.path.split(' → ');
    r.merged = r.merged || [];
    r.cross = r.cross || null;
  }
  status('');
  if (note) toast(esc(note));
  S.res = res;
  S.hover = null;
  S.sort = { key: 'rank', dir: 1 };
  S.picks = [];
  S.focus = null;
  resetDetail();
  $('#results').hidden = false;
  setSetup(false);                                     // 결과가 화면 위로 오게 설정은 한 줄로 접는다
  syncEmpty();
  const hasBad = S.res.info.has_bad;
  for (const b of $$('#yseg button[data-v=bad]')) b.disabled = !hasBad;
  if (!hasBad && S.yMode === 'bad') setSeg($('#yseg'), (S.yMode = 'judg'));
  const jobs = S.res.info.data.job_ids || [];
  $('#topnote').textContent = `${jobs.length ? `JOB ID : ${jobs[0]}${jobs.length > 1 ? ` 외 ${jobs.length - 1}개` : ''} · ` : ''}${S.res.info.data.wafers.toLocaleString('ko-KR')}장 · 혐의 대상 ${S.res.ranking.length}개`;
  renderConcl();
  renderSummary();
  renderFunnel();
  if (S.res.ranking.length) {
    S.focus = 0;
    setPicks([0]);
  } else {
    renderRanking();
    $('#details').hidden = true;
  }
}

function hideResults() {
  S.res = null;
  S.picks = [];
  resetDetail();
  $('#results').hidden = true;
  $('#details').hidden = true;
  $('#topnote').textContent = '';
  setSetup(true);
  syncEmpty();
}

// 설정 카드: 결과가 있으면 한 줄 요약(데이터 · 설정 · [설정 바꾸기])으로 접고, 없으면 펼친다
const ICON_INFO = '<svg class="ico-info" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><path d="M12 7.6v.1"/></svg>';   // ⓘ 글자는 PC마다 다른 글꼴로 그려져서 그림으로
const ICON_FILE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/></svg>';
const ICON_DB = '<svg viewBox="0 0 24 24" aria-hidden="true"><ellipse cx="12" cy="5.5" rx="7" ry="2.8"/><path d="M5 5.5v13c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8v-13"/><path d="M5 12c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8"/></svg>';
function setSetup(open) {
  const full = open || !S.res;
  $('#setup-full').hidden = !full;
  $('#setup-mini').hidden = full;
  $('#setup-close').hidden = !(S.res && full);
  $('#setup-open').setAttribute('aria-expanded', String(full));
  if (!full) renderMini();
}

function renderMini() {
  const v = S.runs.find((x) => x.id === S.runId);
  const st = settingsText(v ? v.settings : settings());
  const job = v ? v.job_source : null;
  const name = v ? (job ? `job ${job}` : v.file_name || 'raw.csv') : S.fileId ? $('#q-file-name').textContent : `job ${$('#job_id').value}`;
  $('#mini-src').innerHTML = `${job ? ICON_DB : ICON_FILE}<b>${esc(name)}</b>`;
  $('#mini-set').textContent = st.main + (st.extra ? ' · ' + st.extra : '');
}

// 결론: 1위를 한 문장으로 (복사해 회의 · 메신저에 붙여 쓰도록 같은 내용을 글로도 만들어 둔다)
function renderConcl() {
  const I = S.res.info;
  const R = S.res.ranking;
  const hasBad = I.has_bad;
  const job = (I.data.job_ids || [])[0];
  const pre = job ? `[job ${job}] ` : '';
  if (!R.length) {
    $('#concl-body').innerHTML = `<div class="concl-main">기준선을 넘은 혐의 대상이 없습니다</div>
      <div class="muted small">조합 ${fmt.int(I.judge.combos)}개를 검사했습니다. MIN_N을 낮추거나 MAX_DEPTH를 늘려 다시 볼 수 있습니다.</div>`;
    S.conclText = `${pre}기준선을 넘은 혐의 대상 없음 (조합 ${I.judge.combos}개 검사)`;
    return;
  }
  const r = R[0];
  const vmu = S.res.funnel.bounds.mean.mid;
  const cert = r.certainty == null ? '–' : r.certainty.toFixed(2);
  const stat = hasBad ? `웨이퍼 <b>${fmt.int(r.n)}장</b> 중 bad <b class="badtxt">${fmt.pct(r.bad)}</b> (예상 ${fmt.pct(r.exp_bad)}) → 예상보다 <b>${fmt.int(r.excess)}장</b> 더 bad`
    : `웨이퍼 <b>${fmt.int(r.n)}장</b>의 y_value 평균 <b>${fmt.num(r.vmean)}</b> (전체 ${fmt.num(vmu)})`;
  const statT = hasBad ? `${r.n}장 중 bad ${fmt.pct(r.bad)} (예상 ${fmt.pct(r.exp_bad)}), 예상보다 ${Math.round(r.excess)}장 더 bad`
    : `${r.n}장의 y_value 평균 ${fmt.num(r.vmean)} (전체 ${fmt.num(vmu)})`;
  const others = R.slice(1, 3).map((x) => `${x.rank}위 ${x.step_name} ${x.path} (${hasBad ? `초과 bad ${fmt.signed(x.excess)}장` : `N × ΔValue ${fmt.num(x.excess)}`})`);
  const more = R.length > 3 ? ` 외 ${R.length - 3}개` : '';
  const merged = r.merged.length ? ` · 웨이퍼가 같은 대상 ${r.merged.length}개가 1위 줄에 묶여 있습니다(순위표의 "+${r.merged.length} 같은 웨이퍼"나 상세의 묶음 버튼으로 봄)` : '';
  $('#concl-body').innerHTML = `<div class="concl-main"><span class="concl-tag">1위</span><b>${esc(r.step_name)}</b>${r.desc ? `<span class="muted"> · ${esc(r.desc)}</span>` : ''}
      <span class="path inline">${pathHtml(r.parts)}</span></div>
    <div class="concl-stat">${stat} · <span class="help-term" data-help="certainty">Certainty</span> ${cert}</div>
    <div class="muted small">혐의 대상 ${R.length}개${others.length ? ' · ' + esc(others.join(' · ')) + more : ''}${merged}</div>`;
  S.conclText = `${pre}1위 ${r.step_name}${r.desc ? ` (${r.desc})` : ''} ${r.path}: ${statT}, Certainty ${cert}.`
    + (R.length > 1 ? ` 혐의 대상 ${R.length}개: ${others.join(', ')}${more}.` : '');
}

// 실행 기록 서랍 (위쪽 시계 아이콘)
function openDrawer() {
  const d = $('#drawer');
  d.classList.add('open');
  d.removeAttribute('inert');
  d.setAttribute('aria-hidden', 'false');
  $('#backdrop').classList.add('open');
  $('#top-history').setAttribute('aria-expanded', 'true');
  refreshRuns();
  setTimeout(() => $('#hist-q').focus(), 60);
}

function closeDrawer() {
  const d = $('#drawer');
  if (!d.classList.contains('open')) return;
  d.classList.remove('open');
  d.setAttribute('inert', '');
  d.setAttribute('aria-hidden', 'true');
  $('#backdrop').classList.remove('open');
  $('#top-history').setAttribute('aria-expanded', 'false');
}

// 연 결과가 없을 때: 최근 실행 6개를 바로 열 수 있게
function renderRecent(all) {
  $('#recent-list').innerHTML = all.slice(0, 6).map((v) => {
    const jobs = v.job_ids || [];
    return `<div class="rl-row" role="button" tabindex="0" data-id="${esc(v.id)}">
      <div class="rl-job"><b>${jobs.length ? esc(jobs[0]) : '–'}</b><span class="muted"> · ${esc((v.analysis_dates || [])[0] || '')}</span></div>
      <div class="rl-res">${homeResult(v)}</div>
      <div class="rl-meta">${esc(v.file_name || v.file_id)} · ${when(v.created)} 실행 · ${esc(settingsText(v.settings).main)}</div></div>`;
  }).join('');
  syncEmpty();
}

function syncEmpty() {
  $('#empty').hidden = !!S.res || !$('#loader').hidden || !$('#recent-list').children.length;
}

function setHash(id) {
  history.replaceState(null, '', id ? '#run=' + id : '#analysis');
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
      S.db = !!r.db;
      syncDb();
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
  if (v.status === 'running') return `<span class="live"></span>${v.stage === 'fetch' ? 'DB에서 가져오는 중' : '실행 중'} · ${esc(v.text)} · ${dur(v.seconds)}`;
  if (v.status === 'queued') return `<span class="live"></span>${v.ahead ? `대기 중 · 앞에 ${v.ahead}개` : '시작하는 중'}`;
  return `<span class="errtxt">오류</span><div class="note err" title="${esc(v.error || '')}">${esc(v.error || '')}</div>`;
}

function renderHistory() {
  const all = S.runs.filter((v) => !S.pendingDel.has(v.id));
  renderRecent(all);
  $('#top-history').classList.toggle('busy', all.some((v) => ACTIVE.has(v.status)));
  const q = S.histQ.trim().toLowerCase();
  const hay = (v) => [...(v.job_ids || []), ...(v.analysis_dates || []), v.file_name || ''].join(' ').toLowerCase();
  const rows = q ? all.filter((v) => hay(v).includes(q)) : all;
  $('#hist-sub').textContent = all.length ? `${all.length}개 · 고르면 다시 계산하지 않고 저장된 결과를 엽니다 · 모든 사용자가 함께 보는 목록` : '';
  if (!rows.length) {
    $('#history').innerHTML = `<div class="empty muted">${all.length ? '찾는 기록이 없습니다.' : '아직 실행 기록이 없습니다. Job ID를 넣거나 raw.csv를 올리고 Run을 누르면 여기에 남습니다.'}</div>`;
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
      <td class="l jid" title="${esc(jobs.join(', '))}">${many(jobs)}</td>
      <td class="l nowrap" title="${esc(dates.join(', '))}">${many(dates)}</td>
      <td class="l"><div class="fname">${esc(v.file_name || v.file_id)}</div>${v.job_source ? `<div class="note">${v.file_exists ? 'DB에서 가져옴' : v.status === 'error' ? 'DB에서 가져오지 못함' : 'DB에서 가져오는 중'} (job_id ${esc(v.job_source)})</div>` : v.file_exists ? '' : '<div class="note">올린 파일이 지워져 다시 계산은 못 함</div>'}</td>
      <td class="l">${esc(st.main)}${st.extra ? `<div class="note">${esc(st.extra)}</div>` : ''}</td>
      <td class="l">${resultCell(v)}</td>
      <td><button type="button" class="ghost del" data-del="${esc(v.id)}" title="${busy ? '계산을 멈추고 기록 삭제' : '기록 삭제'}">삭제</button></td>
    </tr>`;
  }).join('');
  $('#history').innerHTML = `<table class="rank hist"><thead><tr><th class="l">Run time</th><th class="l">job_id</th><th class="l">analysis_date</th>
    <th class="l">File</th><th class="l">Settings</th><th class="l">Result</th><th></th></tr></thead><tbody>${body}</tbody></table>`;
}

function removeRun(id) {
  const v = S.runs.find((x) => x.id === id);
  if (!v) return;
  const what = `${(v.job_ids || [])[0] || v.file_name || v.file_id} · ${when(v.created)} 실행`;
  if (ACTIVE.has(v.status)) {                          // 돌고 있는 실행은 멈추면 되돌릴 수 없어서 한 번 묻는다
    toast(`돌고 있는 판정을 멈추고 지울까요? <span class="t-sub">${esc(what)}</span>`,
      { timeout: 0, actions: [{ label: '멈추고 지우기', fn: () => dropRun(id, true, what) }, { label: '취소' }] });
    return;
  }
  dropRun(id, false, what);
}

// 목록에서 바로 빼고, 6초 안에 되돌리기를 누르지 않으면 서버에서 지운다 (돌고 있던 실행은 바로)
function dropRun(id, now, what) {
  const wasOpen = S.runId === id;
  S.pendingDel.add(id);
  if (wasOpen) {
    S.watch++;
    S.runId = null;
    setHash(null);
    hideLoader();
    hideResults();
  }
  renderHistory();
  const commit = async () => {
    try {
      await api(`/api/runs/${id}`, { method: 'DELETE' });
    } catch (e) {
      toast('지우지 못했습니다: ' + esc(e.message), { kind: 'error' });
    }
    S.pendingDel.delete(id);
    await refreshRuns();
  };
  if (now) {
    commit();
    toast(`실행을 멈추고 기록을 지웠습니다 <span class="t-sub">${esc(what)}</span>`);
    return;
  }
  toast(`실행 기록을 지웠습니다 <span class="t-sub">${esc(what)}</span>`, {
    timeout: 6000,
    onTimeout: commit,
    actions: [{ label: '되돌리기', fn: () => { S.pendingDel.delete(id); renderHistory(); if (wasOpen) openRun(id); } }],
  });
}

function setSeg(el, v) {
  for (const b of $$('button', el)) b.classList.toggle('on', b.dataset.v === v);
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

// 세로축 범위: 가운데 선을 기준으로 위아래를 같은 폭으로 잡아, 경계선 양 끝(웨이퍼가 적은 쪽에서 벌어진 끝)과 점이 모두 보이게
function symRange(b, ns, vals) {
  const ok = vals.filter((v) => v != null && isFinite(v));
  if (!b || b.mid == null) {
    let lo = ok.length ? Math.min(...ok) : 0;
    let hi = ok.length ? Math.max(...ok) : 1;
    const pad = (hi - lo || 1) * 0.06;
    lo -= pad;
    hi += pad;
    return [lo, hi];
  }
  let half = 0;
  for (let i = 0; i < ns.length; i++) {
    if (b.hi[i] != null) half = Math.max(half, b.hi[i] - b.mid);
    if (b.lo[i] != null) half = Math.max(half, b.mid - b.lo[i]);
  }
  for (const v of ok) half = Math.max(half, Math.abs(v - b.mid));
  half = (half || 1) * 1.05;
  return [b.mid - half, b.mid + half];
}

// 점 위주: 점이 있는 범위와 가운데 웨이퍼 수에서의 경계선만 (띠 양 끝은 잘릴 수 있음)
function fitRange(b, ns, vals) {
  const ok = vals.filter((v) => v != null && isFinite(v));
  let lo = ok.length ? Math.min(...ok) : 0;
  let hi = ok.length ? Math.max(...ok) : 1;
  if (b) {
    const mid = Math.floor(ns.length / 2);
    if (b.lo[mid] != null) lo = Math.min(lo, b.lo[mid]);
    if (b.hi[mid] != null) hi = Math.max(hi, b.hi[mid]);
  }
  const pad = (hi - lo || 1) * 0.06;
  return [lo - pad, hi + pad];
}

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
  const gv = (fn.gray[m] || []).filter((v) => v != null).sort((a, c) => a - c);
  const vals = gv.length ? [quantile(gv, 0.002), quantile(gv, 0.998)] : [];
  for (const k of fn.marks) if (k[m] != null) vals.push(k[m]);
  const b = bd[m];
  let [lo, hi] = S.fView === 'pts' ? fitRange(b, ns, vals) : symRange(b, ns, vals);
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
  // 위(SVG): 경계선 · 축 · 경계 밖 점 · 드래그 상자
  let s = `<defs><clipPath id="fclip"><rect x="${L}" y="${T}" width="${R - L}" height="${B - T}"/></clipPath></defs><g clip-path="url(#fclip)">`;
  if (b) {
    const line = (arr) => ns.map((n, i) => (arr[i] == null ? null : `${xs(n).toFixed(1)},${ys(arr[i]).toFixed(1)}`)).filter(Boolean).join(' ');
    s += `<polyline points="${line(b.hi)}" fill="none" stroke="${C.ink2}" stroke-width="1.4"/><polyline points="${line(b.lo)}" fill="none" stroke="${C.ink2}" stroke-width="1.4"/>`;
    if (b.mid != null) s += `<line x1="${L}" x2="${R}" y1="${ys(b.mid)}" y2="${ys(b.mid)}" stroke="${C.line2}" stroke-dasharray="4 3"/>`;
  }
  s += '</g>';
  const yt = m === 'judg' ? [] : linTicks(lo, hi, 5).map((v) => ({ v, l: m === 'bad' ? Math.round(v * 100) + '%' : fmt.tick(v) }));
  s += axes({ L, R, T, B, xs, ys, xt: logTicks(ns[0], ns[ns.length - 1]).map((v) => ({ v, l: fmt.int(v) })), yt, xl: '웨이퍼 수 N (조합을 지난 웨이퍼)', yl: Y_TITLE[m], yo: 44 });
  s += '<g id="fmarks"></g><g id="fbrush"></g>';
  sv.innerHTML = s;
  drawMarks();
  $('#funnel-legend').innerHTML = [
    `<span class="item"><span class="dot" style="background:${C.muted}"></span>기준선 안 ${fmt.int(fn.gray_total)}개${gn.length < fn.gray_total ? ` (${fmt.int(gn.length)}개만 그림)` : ''}</span>`,
    `<span class="item"><span class="dot" style="background:${C.bad}"></span>bad path ${fmt.int(fn.marks.filter((k) => k.side === 'bad').length)}개</span>`,
    `<span class="item"><span class="dot" style="background:${C.good}"></span>good path ${fmt.int(fn.marks.filter((k) => k.side === 'good').length)}개</span>`,
    `<span class="item">— ${BOUND_NOTE[m]}</span>`,
    `<span class="item"><span class="dot" style="border:2px solid ${C.ring};width:10px;height:10px"></span>고른 순위</span>`,
  ].join('');
}

function drawMarks() {
  const f = S.fn;
  const host = $('#fmarks');
  if (!f || !host || !S.res) return;
  const m = S.yMode;
  const picked = new Set(S.picks.map((i) => i + 1));                // 순위 = 순위표 index + 1
  const cur = S.cur;
  const hv = S.hover;
  const isCur = (k) => !!cur && (cur.kind === 'rank' ? k.rank === cur.t.rank : k.key != null && k.key === cur.key);
  const lit = (k) => !hv || k.rank === hv.rank || k.target === hv.rank || (hv.key != null && k.key === hv.key);
  const hvRing = (k) => !!hv && (hv.key != null ? k.key === hv.key : k.rank != null && k.rank === hv.rank);
  const marks = S.res.funnel.marks;
  const order = marks.map((k, i) => i).sort((a, c) => (marks[a].rank ? 1 : 0) - (marks[c].rank ? 1 : 0));
  let s = '';
  for (const i of order) {
    const k = marks[i];
    if (k[m] == null) continue;
    const x = f.xs(k.n).toFixed(1);
    const y = f.ys(k[m]).toFixed(1);
    const op = lit(k) ? 1 : 0.25;
    s += `<circle cx="${x}" cy="${y}" r="${k.rank ? 5 : 3.5}" fill="${k.side === 'bad' ? C.bad : C.good}" opacity="${op}" data-i="${i}" style="cursor:${k.rank || k.target ? 'pointer' : 'default'}"/>`;
    if (k.rank && k.rank <= 10) s += `<text x="${(+x + 8).toFixed(1)}" y="${(+y - 7).toFixed(1)}" fill="${C.bad}" font-size="11" font-weight="600" opacity="${op}" pointer-events="none">${k.rank}</text>`;
    const here = isCur(k);
    if (here && (S.picks.length > 1 || cur.kind !== 'rank')) s += `<circle cx="${x}" cy="${y}" r="14" fill="none" stroke="${C.ring}" stroke-opacity="0.35" stroke-width="5" pointer-events="none"/>`;   // 아래 상세에 보이는 대상
    if (k.rank != null && picked.has(k.rank)) s += `<circle cx="${x}" cy="${y}" r="10" fill="none" stroke="${C.ring}" stroke-width="2.2" pointer-events="none"/>`;
    else if (here) s += `<circle cx="${x}" cy="${y}" r="8" fill="none" stroke="${C.ring}" stroke-width="1.8" stroke-dasharray="3 2" pointer-events="none"/>`;
    else if (hvRing(k)) s += `<circle cx="${x}" cy="${y}" r="10" fill="none" stroke="${C.ink}" stroke-width="1.3" pointer-events="none"/>`;
  }
  host.innerHTML = s;
}

// 순위표 · 비교 띠에서 가리킨 대상: rank = 그 순위(점을 밝게), key = 묶인 대상 하나(그 점에 고리)
const sameHover = (a, b) => (a ? a.rank : null) === (b ? b.rank : null) && (a ? a.key : null) === (b ? b.key : null);
function setHover(hv) {
  if (sameHover(hv, S.hover)) return;
  S.hover = hv;
  drawMarks();
}

function markTip(e) {
  if (S.brush && S.brush.moved) return;
  const c = e.target.closest('circle[data-i]');
  if (!c) { hideTip(); return; }
  const k = S.res.funnel.marks[+c.dataset.i];
  const who = k.rank ? `${k.rank}위 혐의 대상`
    : k.merged ? `웨이퍼가 ${k.merged}위와 같아 그 줄에 묶인 대상 · 누르면 이 대상의 상세를 봅니다`
      : k.target ? `${k.target}위 대상에 포함 (같이 올라온 조합)`
        : k.side === 'bad' ? '기준선 밖 (혐의 대상과 묶이지 않음)' : 'good path (기준선보다 뚜렷하게 좋음)';
  showTip(`<b>${esc(k.label)}</b><br>${who}<br>웨이퍼 ${fmt.int(k.n)}장 · Order ${k.k}개 · Certainty ${k.certainty == null ? '–' : k.certainty.toFixed(2)}`
    + (k.mean != null ? `<br>y_value 평균 ${fmt.num(k.mean)}` : '') + (k.bad != null ? ` · bad ${fmt.pct(k.bad)}` : ''), e.clientX, e.clientY);
}

// 끌어서 고르기: 상자 안의 순위가 매겨진 점(그 순위에 포함된 점 포함)을 모두 고른다. Ctrl · ⌘ · Shift를 누르고 끌면 더한다
function bindBrush() {
  const sv = $('#funnel svg');
  const pos = (e) => { const r = sv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const clear = () => { const g = $('#fbrush'); if (g) g.innerHTML = ''; };
  sv.addEventListener('pointerdown', (e) => {
    const f = S.fn;
    if (e.button !== 0 || !S.res || !f) return;
    const [x, y] = pos(e);
    if (x < f.L || x > f.R || y < f.T || y > f.B) return;
    S.brush = { x0: x, y0: y, x1: x, y1: y, add: e.shiftKey || e.ctrlKey || e.metaKey, moved: false, id: e.pointerId };
  });
  sv.addEventListener('pointermove', (e) => {
    const b = S.brush;
    if (!b) return;
    const f = S.fn;
    const [x, y] = pos(e);
    b.x1 = clamp(x, f.L, f.R);
    b.y1 = clamp(y, f.T, f.B);
    if (!b.moved && Math.abs(b.x1 - b.x0) + Math.abs(b.y1 - b.y0) > 6) {
      b.moved = true;
      hideTip();
      try { sv.setPointerCapture(b.id); } catch { /* 이미 손을 뗀 경우 */ }
    }
    if (!b.moved) return;
    const g = $('#fbrush');
    if (g) g.innerHTML = `<rect x="${Math.min(b.x0, b.x1)}" y="${Math.min(b.y0, b.y1)}" width="${Math.abs(b.x1 - b.x0)}" height="${Math.abs(b.y1 - b.y0)}" fill="${C.ring}" fill-opacity="0.1" stroke="${C.ring}" stroke-dasharray="4 3"/>`;
  });
  const end = () => {
    const b = S.brush;
    S.brush = null;
    clear();
    if (!b || !b.moved) return;
    S.brushed = true;                          // 끌기 뒤에 따라오는 click은 무시
    setTimeout(() => { S.brushed = false; }, 0);
    brushSelect(b);
  };
  sv.addEventListener('pointerup', end);
  window.addEventListener('pointerup', end);
  sv.addEventListener('pointercancel', () => { S.brush = null; clear(); });
}

function brushSelect(b) {
  const f = S.fn;
  const m = S.yMode;
  const [xa, xb] = [Math.min(b.x0, b.x1), Math.max(b.x0, b.x1)];
  const [ya, yb] = [Math.min(b.y0, b.y1), Math.max(b.y0, b.y1)];
  const idx = new Set();
  for (const k of S.res.funnel.marks) {
    const r = k.rank || k.target;
    if (!r || k[m] == null) continue;
    const x = f.xs(k.n);
    const y = f.ys(k[m]);
    if (x >= xa && x <= xb && y >= ya && y <= yb) idx.add(r - 1);
  }
  if (!idx.size) {
    if (b.add) flashHint('고른 영역에 순위가 매겨진 점이 없습니다');
    else clearPicks();
    return;
  }
  const list = [...idx].sort((a, c) => a - c);
  S.focus = list[0];
  setPicks(list, b.add);
  revealRow(S.focus);
}

function clearPicks() {
  if (!S.picks.length) return;
  S.picks = [];
  S.focus = null;
  S.cur = null;
  afterPicks();
  flashHint('선택을 풀었습니다 · 점을 누르거나 끌어서 다시 고르세요');
}

function flashHint(text) {
  const h = $('#fhint');
  if (!h.dataset.text) h.dataset.text = h.textContent;
  h.textContent = text;
  h.classList.add('warn');
  clearTimeout(S.hintTimer);
  S.hintTimer = setTimeout(() => { h.textContent = h.dataset.text; h.classList.remove('warn'); }, 2500);
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

// 경로: "O1:유닛" 덩어리 안에서는 줄을 바꾸지 않고, 덩어리 사이(→ 앞)에서만 바꾼다
const pathHtml = (parts) => parts.map((p, j) => `<span class="ps">${j ? '<span class="arr">→ </span>' : ''}${esc(p)}</span>`).join('');
const stepText = (t) => `${t.step_name}${t.desc ? ' · ' + t.desc : ''}`;

function renderRanking() {
  const hasBad = S.res.info.has_bad;
  const cols = COLS.filter((c) => hasBad || !c.bad);
  const label = (c) => (c.key === 'excess' && !hasBad ? 'N × ΔValue' : c.label);   // good_bad가 없으면 순위 기준 = 웨이퍼 수 × Value 차이
  const help = (c) => `<span class="help" data-help="${c.key === 'excess' && !hasBad ? 'dvalue' : c.key}">${ICON_INFO}</span>`;
  const head = cols.map((c) => `<th class="${c.left ? 'l' : 'num'}" data-k="${c.key}">${label(c)}${help(c)}${S.sort.key === c.key ? (S.sort.dir > 0 ? ' ▴' : ' ▾') : ''}</th>`).join('');
  const sw = Math.round((S.res.info.settings.same_wafers ?? 0.9) * 100);
  const cert = (v) => (v == null ? '–' : v.toFixed(2));
  const cell = (c, r, i) => {
    switch (c.key) {
      case 'rank': return `<td class="num">${r.rank}</td>`;
      case 'path': {
        const open = S.open.has(i);
        const grp = r.merged.length ? `<div class="grp-line"><button type="button" class="grp" data-grp="${i}" aria-expanded="${open}"
          title="웨이퍼가 ${sw}% 이상 같아 이 줄에 묶인 대상 ${r.merged.length}개 ${open ? '접기' : '펼치기'}">+${r.merged.length} 같은 웨이퍼 ${open ? '▴' : '▾'}</button></div>` : '';
        return `<td class="l pathcell" title="${esc(stepText(r) + '\n' + r.path + (r.note ? '\n' + r.note : ''))}"><div class="step">${esc(stepText(r))}</div>`
          + `<div class="path">${pathHtml(r.parts)}</div>${grp}${r.note ? `<div class="note">${esc(r.note)}</div>` : ''}</td>`;
      }
      case 'n': return `<td class="num">${fmt.int(r.n)}</td>`;
      case 'bad': case 'exp_bad': return `<td class="num">${fmt.pct(r[c.key])}</td>`;
      case 'excess': return `<td class="num">${hasBad ? fmt.signed(r.excess) : fmt.num(r.excess)}</td>`;
      default: return `<td class="num">${cert(r.certainty)}</td>`;
    }
  };
  const subCell = (c, t) => {                          // 묶인 대상 한 줄 (순위 칸 = ↳)
    switch (c.key) {
      case 'rank': return '<td class="num"><span class="sub-mark" aria-hidden="true">↳</span></td>';
      case 'path': return `<td class="l pathcell" title="${esc(stepText(t) + '\n' + t.path)}"><div class="step"><span class="tag">겹침 ${fmt.pct(t.overlap, 0)}</span>${esc(stepText(t))}</div>`
        + `<div class="path">${pathHtml(t.parts)}</div></td>`;
      default: return cell(c, t, -1);
    }
  };
  const multi = S.picks.length > 1;
  const curId = S.cur ? S.cur.id : null;
  const body = sortedRows().map(({ r, i }) => {
    const cls = [S.picks.includes(i) ? 'on' : '', multi && curId === 'r' + r.rank ? 'cur' : ''].join(' ').trim();
    const subs = S.open.has(i) ? r.merged.map((t) => `<tr class="sub${curId === 'x' + t.key ? ' cur' : ''}" data-i="${i}" data-key="${esc(t.key)}">${cols.map((c) => subCell(c, t)).join('')}</tr>`).join('') : '';
    return `<tr data-i="${i}" class="${cls}">${cols.map((c) => cell(c, r, i)).join('')}</tr>${subs}`;
  }).join('');
  $('#ranking').innerHTML = S.res.ranking.length
    ? `<table class="rank rk"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`
    : '<div class="muted" style="padding:10px">기준선을 넘은 혐의 대상이 없습니다.</div>';
  $('#rank-sub').textContent = S.res.ranking.length
    ? `${S.res.ranking.length}개 · ${hasBad ? '초과 bad' : 'N × ΔValue'} 순${multi ? ` · ${S.picks.length}개 고름` : ''} · Ctrl/Shift+클릭으로 여러 개`
    : '';
}

// 표 안에서만 스크롤해 줄을 보이게 한다 (페이지 전체는 움직이지 않음)
function scrollInto(wrap, tr) {
  const head = $('thead', wrap);
  const w = wrap.getBoundingClientRect();
  const r = tr.getBoundingClientRect();
  const top = w.top + (head ? head.offsetHeight : 0);
  if (r.top < top) wrap.scrollTop -= top - r.top;
  else if (r.bottom > w.bottom) wrap.scrollTop += r.bottom - w.bottom;
}
function revealRow(i, key = null) {
  const tr = key != null ? $(`#ranking tr[data-key="${CSS.escape(key)}"]`) : $(`#ranking tr[data-i="${i}"]:not(.sub)`);
  if (tr) scrollInto($('#ranking'), tr);
}

// ── 고르기: 순위표 · funnel에서 고른 순위(여러 개)와 상세에 보이는 대상 하나 ─────────────
// S.picks = 고른 순위(순위표 index, 순위 순). S.cur = 상세에 보이는 대상:
//   kind 'rank' 순위 · 'member' 웨이퍼가 같아 그 순위에 묶인 대상 · 'cross' 그 순위의 다른 STEP 탓 의심 대상(순위표에 없는 것)
const tRank = (i) => { const r = S.res.ranking[i]; return { id: 'r' + r.rank, kind: 'rank', i, key: r.key, step: r.step, items: r.items, t: r }; };
const tSub = (i, t, kind) => ({ id: 'x' + t.key, kind, i, key: t.key, step: t.step, items: t.items, t });

// 순위 하나와 그 순위에 얽힌 대상: [순위, 묶인 대상…, 다른 STEP 탓 의심 대상]
function groupOf(i) {
  const r = S.res.ranking[i];
  const out = [tRank(i), ...r.merged.map((t) => tSub(i, t, 'member'))];
  if (r.cross && !S.res.ranking.some((x) => x.key === r.cross.key)) out.push(tSub(i, r.cross, 'cross'));
  return out;
}

// 비교 띠에 나오는 대상 (고른 순위마다 그 순위와 얽힌 대상, 순위 순)
function stripItems() {
  const seen = new Set();
  return S.picks.flatMap(groupOf).filter((t) => !seen.has(t.id) && seen.add(t.id)).slice(0, CMP_MAX);
}

// list의 순위를 고른다(add면 더한다). cur = 상세에 보일 대상 (없으면 고른 것 중 순위가 가장 높은 것, 더할 때는 지금 보던 것 그대로)
function setPicks(list, add = false, cur = null) {
  const next = new Set(add ? S.picks : []);
  for (const i of list) next.add(i);
  S.picks = [...next].sort((a, b) => a - b);
  if (cur) S.cur = cur;
  else if (!(add && S.cur && S.picks.includes(S.cur.i))) S.cur = S.picks.length ? tRank(list.length ? Math.min(...list) : S.picks[0]) : null;
  afterPicks();
}

function togglePick(i) {
  if (S.picks.includes(i)) {
    S.picks = S.picks.filter((x) => x !== i);
    if (S.cur && S.cur.i === i) {                       // 보던 순위를 빼면 다음 순위(없으면 마지막 순위)를 본다
      const nx = S.picks.find((x) => x > i) ?? S.picks[S.picks.length - 1];
      S.cur = nx == null ? null : tRank(nx);
    }
  } else {
    S.picks = [...S.picks, i].sort((a, b) => a - b);
    S.cur = tRank(i);
  }
  afterPicks();
}

// 순위 i에 묶인 대상(key)을 상세로 본다. add면 지금 고른 순위는 그대로 두고 i를 더한다
function focusMember(i, key, add = false) {
  const t = groupOf(i).find((x) => x.key === key);
  S.focus = i;
  if (t && t.kind === 'member') S.open.add(i);
  setPicks([i], add, t || null);
  revealRow(i, t && t.kind === 'member' ? key : null);
}

// 고른 순위는 그대로 두고 상세에 보일 대상만 바꾼다 (비교 띠 · 묶음 버튼 · ◀ ▶)
function setFocus(t) {
  if (t.kind === 'member') S.open.add(t.i);
  S.cur = t;
  S.focus = t.i;
  afterPicks();
  revealRow(t.i, t.kind === 'member' ? t.key : null);
}

// ◀ ▶: 하나만 골랐으면 순위를, 여러 개면 비교 띠의 대상을 차례로
function stepTarget(d) {
  const sp = S.cur;
  if (!sp || !S.res) return;
  if (S.picks.length > 1) {
    const items = stripItems();
    const t = items[items.findIndex((x) => x.id === sp.id) + d];
    if (t) setFocus(t);
    return;
  }
  const i = sp.i + d;
  if (i < 0 || i >= S.res.ranking.length) return;
  S.focus = i;
  setPicks([i]);
  revealRow(i);
}

function afterPicks() {
  renderRanking();
  drawMarks();
  renderStrip();
  showPanel();
}

// ── 비교 띠: 여러 순위를 골랐을 때 대상마다 한 줄. 회색 점 = 같은 Order를 다른 Unit으로 지난 웨이퍼, 빨간 점 = 이 경로 ──
const cmpKey = (items) => S.runId + ':' + items.map((t) => t.id).join(',');

async function renderStrip() {
  const box = $('#cmp');
  if (!S.res || S.picks.length < 2) { box.hidden = true; return; }
  box.hidden = false;
  const items = stripItems();
  const key = cmpKey(items);
  if (S.cmp && S.cmp.key === key) { drawStrip(items, S.cmp.data); return; }
  drawStrip(items, null);
  if (S.cmpPending === key) return;                    // 같은 대상으로 이미 묻는 중
  S.cmpPending = key;
  const seq = ++S.cmpSeq;
  try {
    const data = await post(`/api/runs/${S.runId}/compare`, { targets: items.map((t) => ({ step: t.step, items: t.items })) });
    if (seq !== S.cmpSeq) return;
    S.cmp = { key, data };
    drawStrip(items, data);
  } catch (e) {
    if (seq === S.cmpSeq) $('#cmp-body').innerHTML = `<div class="errtxt">비교를 불러오지 못했습니다: ${esc(e.message)}</div>`;
  } finally {
    if (seq === S.cmpSeq) S.cmpPending = null;
  }
}

function drawStrip(items, data) {
  const hasBad = S.res.info.has_bad;
  const rows = data ? data.targets : null;
  const ov = data ? data.overlap : null;
  const [vk, rk] = hasBad ? ['bad', 'rest_bad'] : ['vmean', 'rest_vmean'];
  let lo = 0;
  let hi = 1;
  if (rows) {                                           // 모든 줄이 같은 눈금 (bad는 0부터)
    const vals = rows.flatMap((r) => [r[vk], r[rk]]).filter((v) => v != null);
    if (hasBad) hi = Math.max(0.02, ...vals) * 1.08;
    else if (vals.length) {
      lo = Math.min(...vals);
      hi = Math.max(...vals);
      const pad = (hi - lo) * 0.08 || Math.abs(hi) * 0.05 || 1;
      lo -= pad;
      hi += pad;
    }
  }
  const ticks = rows ? linTicks(lo, hi, 5) : [];
  const stepPct = ticks.length > 1 ? (ticks[1] - ticks[0]) * 100 : 1;
  const tickLabel = (v) => (hasBad ? (v * 100).toFixed(stepPct >= 1 ? 0 : stepPct >= 0.1 ? 1 : 2) + '%' : fmt.tick(v));
  const X = (v) => ((v - lo) / (hi - lo || 1)) * 100;
  const P = (v) => X(v).toFixed(2) + '%';
  const grid = ticks.map((v) => `<span class="cmp-gl" style="left:${P(v)}"></span>`).join('');
  const dots = (a, b) => {                              // 회색 점(다른 Unit) — 선 — 빨간 점(이 경로)
    let h = '';
    if (a != null && b != null) h += `<span class="cmp-link" style="left:${P(Math.min(a, b))};width:${(X(Math.max(a, b)) - X(Math.min(a, b))).toFixed(2)}%"></span>`;
    if (b != null) h += `<span class="cmp-dot rest" style="left:${P(b)}"></span>`;
    if (a != null) h += `<span class="cmp-dot this" style="left:${P(a)}"></span>`;
    return h;
  };
  const curId = S.cur ? S.cur.id : null;
  const rankAt = (i) => items.findIndex((x) => x.kind === 'rank' && x.i === i);
  const badge = (t, j) => {                             // 웨이퍼 겹침: 묶인 대상 = 그 순위와, 순위 = 위쪽 순위 중 가장 많이 겹치는 것(50% 이상)
    if (!ov) return '';
    let v = null;
    let rank = null;
    if (t.kind !== 'rank') { v = ov[j][rankAt(t.i)]; rank = S.res.ranking[t.i].rank; } else {
      items.forEach((x, k) => {
        if (k < j && x.kind === 'rank' && ov[j][k] >= 0.5 && (v == null || ov[j][k] > v)) { v = ov[j][k]; rank = S.res.ranking[x.i].rank; }
      });
    }
    return v == null ? '' : `<span class="ovb${v >= 0.9 ? ' hi' : ''}">${rank}위와 웨이퍼 ${fmt.pct(v, 0)} 겹침</span>`;
  };
  const body = items.map((t, j) => {
    const r = rows ? rows[j] : null;
    const sub = t.kind !== 'rank';
    const name = sub ? `<span class="tag">${t.kind === 'member' ? '같은 웨이퍼' : '다른 STEP 의심'}</span>` : `<span class="no">${S.res.ranking[t.i].rank}위</span>`;
    const num = !r ? '<span class="muted">…</span>'
      : (hasBad ? `<b class="badtxt">${fmt.pct(r.bad)}</b><span class="muted"> vs ${fmt.pct(r.rest_bad)}</span>` : `<b>${fmt.num(r.vmean)}</b><span class="muted"> vs ${fmt.num(r.rest_vmean)}</span>`)
        + `<span class="muted"> · ${fmt.int(r.n)}장</span>`;
    return `<div class="cmp-row${sub ? ' sub' : ''}${t.id === curId ? ' cur' : ''}" role="row" tabindex="0" data-id="${esc(t.id)}" data-j="${j}" aria-current="${t.id === curId}">
      <div class="cmp-name" role="cell" title="${esc(stepText(t.t) + '\n' + t.t.path)}">${name}<span class="step">${esc(t.t.step_name)}</span><span class="cmp-path">${esc(t.t.path)}</span></div>
      <div class="cmp-track" role="cell">${grid}${r ? dots(r[vk], r[rk]) : ''}</div>
      <div class="cmp-num" role="cell">${num}</div>
      <div class="cmp-ov" role="cell">${badge(t, j)}</div></div>`;
  }).join('');
  const axis = `<div class="cmp-row cmp-axis" aria-hidden="true"><div class="cmp-name muted small">대상</div>
    <div class="cmp-track">${ticks.map((v) => `<span class="cmp-tk" style="left:${P(v)}">${tickLabel(v)}</span>`).join('')}</div>
    <div class="cmp-num muted small">${hasBad ? 'bad: 이 경로 vs 다른 Unit' : 'y_value 평균: 이 경로 vs 다른 Unit'}</div>
    <div class="cmp-ov muted small">웨이퍼 겹침<span class="help" data-help="overlap">${ICON_INFO}</span></div></div>`;
  const had = document.activeElement && document.activeElement.closest ? document.activeElement.closest('#cmp-body .cmp-row[data-id]') : null;
  const box = $('#cmp-body');
  box.innerHTML = `<div role="table" aria-label="고른 대상 비교">${axis}${body}</div>`
    + (S.picks.flatMap(groupOf).length > items.length ? `<div class="muted small cmp-more">대상이 많아 앞의 ${CMP_MAX}개만 그렸습니다.</div>` : '');
  if (had) { const el = $(`.cmp-row[data-id="${CSS.escape(had.dataset.id)}"]`, box); if (el) el.focus({ preventScroll: true }); }
  $('#cmp-sub').textContent = `${S.picks.length}개 순위 · ${items.length}개 대상 · ${hasBad ? 'bad 비율 = bad 웨이퍼 ÷ 웨이퍼' : 'y_value 평균'} · 줄을 누르면 아래 상세가 그 대상으로 바뀝니다`;
}

// 비교 띠 한 줄의 수 (점 위에 올리면)
function stripTip(j, e) {
  const items = stripItems();
  const t = items[j];
  const D = S.cmp && S.cmp.key === cmpKey(items) ? S.cmp.data : null;
  const r = D && D.targets[j];
  if (!t || !r) { hideTip(); return; }
  const row = S.res.ranking[t.i];
  const who = t.kind === 'rank' ? `${row.rank}위` : t.kind === 'member' ? `${row.rank}위에 묶인 대상` : `${row.rank}위 · 다른 STEP 탓 의심`;
  const v = (b, m) => (D.has_bad ? `bad ${fmt.pct(b)}` : `y_value 평균 ${fmt.num(m)}`);
  const diff = D.has_bad && r.bad != null && r.rest_bad != null ? `<br>차이 ${fmt.signed((r.bad - r.rest_bad) * 100, 1)}%p` : '';
  showTip(`<b>${who} · ${esc(t.t.step_name)} ${esc(t.t.path)}</b>`
    + `<br><span class="dot" style="background:${C.bad}"></span> 이 경로 ${fmt.int(r.n)}장 · ${v(r.bad, r.vmean)}`
    + `<br><span class="dot" style="background:${C.muted}"></span> 같은 Order를 다른 Unit으로 지난 웨이퍼 ${fmt.int(r.rest_n)}장 · ${v(r.rest_bad, r.rest_vmean)}${diff}`, e.clientX, e.clientY);
}

function bindStrip() {
  const body = $('#cmp-body');
  const rowOf = (e) => e.target.closest('.cmp-row[data-id]');
  const itemOf = (el) => stripItems().find((x) => x.id === el.dataset.id);
  const pick = (el) => { const t = itemOf(el); if (t && (!S.cur || S.cur.id !== t.id)) setFocus(t); };
  body.addEventListener('click', (e) => { if (!e.target.closest('.help')) { const r = rowOf(e); if (r) pick(r); } });
  body.addEventListener('keydown', (e) => {
    const r = rowOf(e);
    if (!r) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(r); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {     // 위아래 화살표로 줄을 옮겨 가며 본다
      e.preventDefault();
      const sib = e.key === 'ArrowDown' ? r.nextElementSibling : r.previousElementSibling;
      if (sib && sib.dataset.id) { sib.focus(); pick(sib); }
    }
  });
  body.addEventListener('mouseover', (e) => {
    const r = rowOf(e);
    const t = r ? itemOf(r) : null;
    setHover(t ? { rank: S.res.ranking[t.i].rank, key: t.kind === 'rank' ? null : t.key } : null);
  });
  body.addEventListener('mouseleave', () => { setHover(null); hideTip(); });
  body.addEventListener('mousemove', (e) => {
    const r = rowOf(e);
    if (r && e.target.closest('.cmp-track')) stripTip(+r.dataset.j, e);
    else if (!e.target.closest('[data-help]')) hideTip();
  });
}

// ── 상세: 대상 하나를 크기를 고정한 2 × 2로 ─────────────────────────────
function resetDetail() {
  if (S.panel) S.panel.el.remove();
  S.panel = null;
  S.cur = null;
  S.open = new Set();
  S.cmp = null;
  S.cmpPending = null;
  S.cmpSeq++;
  $('#cmp').hidden = true;
}

function showPanel() {
  const box = $('#details');
  box.hidden = !S.cur;
  if (!S.cur) return;
  if (!S.panel) {
    S.panel = makePanel();
    box.appendChild(S.panel.el);
  }
  const p = S.panel;
  const changed = !p.spec || p.spec.id !== S.cur.id;
  p.spec = S.cur;
  if (changed) {                                        // 대상이 바뀌면 원래 경로로 다시 연다 (탐색 중이던 선택은 버림)
    p.sel = p.spec.items.map((x) => x.slice());
    p.det = null;
    loadPanel(p);
  }
  renderHead(p);
}

function makePanel() {
  const el = $('#panel-tpl').content.firstElementChild.cloneNode(true);
  const p = { spec: null, el, sel: [], det: null, cMode: 'hi', pMode: 'judg', seq: 0 };
  const size = $('[data-a=size]', el);
  size.value = S.ptSize;
  size.addEventListener('input', () => {
    S.ptSize = +size.value;
    store.set('uc.ptSize2', S.ptSize);
    if (p.det) renderScatter(p);
  });
  if (!S.res.info.has_bad) $('[data-r=pseg] button[data-v=bad]', el).disabled = true;
  bindAxisTips($('[data-r=pseg]', el));
  el.addEventListener('click', (e) => panelClick(p, e));
  const peers = $('[data-r=peers]', el);
  peers.addEventListener('mousemove', (e) => peerTip(p, e));
  peers.addEventListener('mouseleave', hideTip);
  const sc = $('[data-r=scatter]', el);
  sc.addEventListener('mousemove', (e) => scatterTip(p, e));
  sc.addEventListener('mouseleave', hideTip);
  return p;
}

// 산점도 점 = 웨이퍼 하나: lot · wafer_id · 경로 · 시각 · y_value · good/bad
function scatterTip(p, e) {
  const c = e.target.closest('circle[data-i]');
  if (!c || !p.det) { hideTip(); return; }
  const D = p.det;
  const w = D.wafers;
  const i = +c.dataset.i;
  const name = w.wid ? `${esc(w.lots[w.li[i]])} · wafer ${esc(w.wid[i])}` : `웨이퍼 ${i + 1} (이 실행은 웨이퍼 번호를 저장하지 않았습니다)`;
  showTip(`<b>${name}</b><br>${w.g[i] === D.sel_group ? '선택 경로' : '다른 Unit 조합'} ${esc(D.groups[w.g[i]].label)}`
    + `<br>tkin_time (${esc(D.time_order)}) ${isoTime(w.t[i]).slice(0, 16)}<br>y_value ${fmt.num(w.v[i])}`
    + (D.has_bad ? ` · ${w.b[i] ? '<span class="badtxt">bad</span>' : 'good'}` : ''), e.clientX, e.clientY);
}

// 이 카드의 웨이퍼 목록(고른 Order를 모두 지난 웨이퍼)을 CSV로
function waferCsv(p) {
  const D = p.det;
  const w = D.wafers;
  const ids = !!w.wid;
  const head = [...(ids ? ['root_lot_id', 'wafer_id'] : []), `tkin_time_${D.time_order}`, 'y_value', ...(D.has_bad ? ['good_bad'] : []), 'unit_path', 'selected_path'];
  const rows = w.v.map((v, i) => [...(ids ? [w.lots[w.li[i]], w.wid[i]] : []), isoTime(w.t[i]), v, ...(D.has_bad ? [w.b[i] ? 'B' : 'G'] : []),
    D.groups[w.g[i]].label, w.g[i] === D.sel_group ? 'Y' : 'N']);
  download(`wafers_${jobTag()}_${safeName(D.step_name)}_${safeName(D.selection.label)}.csv`, [head, ...rows]);
  toast(`웨이퍼 ${fmt.int(rows.length)}장 목록을 내려받았습니다${ids ? '' : ' (이 실행은 웨이퍼 번호 없이 저장돼 있어 번호 열은 빠졌습니다. 다시 실행하면 생깁니다)'}`);
}

// 순위표 전체를 CSV로
function rankingCsv() {
  const hasBad = S.res.info.has_bad;
  const head = ['rank', 'step', 'step_desc', 'path', 'n', ...(hasBad ? ['bad_rate', 'expected_bad_rate', 'excess_bad'] : ['n_x_dvalue']), 'certainty', 'y_value_mean', 'same_wafer_targets', 'note'];
  const rows = S.res.ranking.map((r) => [r.rank, r.step_name, r.desc, r.path, r.n, ...(hasBad ? [r.bad, r.exp_bad, r.excess] : [r.excess]), r.certainty, r.vmean,
    r.merged.map((m) => `${m.step_name} ${m.path}`).join(' | '), r.note]);
  download(`ranking_${jobTag()}.csv`, [head, ...rows]);
  toast(`순위표 ${rows.length}줄을 내려받았습니다`);
}

function panelClick(p, e) {
  const a = e.target.closest('[data-a]');
  const act = a ? a.dataset.a : null;
  if (act === 'prev' || act === 'next') { stepTarget(act === 'prev' ? -1 : 1); return; }
  if (act === 'close') { togglePick(p.spec.i); return; }
  if (act === 'wcsv') { if (p.det) waferCsv(p); return; }
  if (act === 'reset') { p.sel = p.spec.items.map((x) => x.slice()); loadPanel(p); return; }
  const g = e.target.closest('[data-gid]');                // 묶음 버튼 · 묶인 대상 표의 "보기"
  if (g) {
    const t = groupOf(p.spec.i).find((x) => x.id === g.dataset.gid);
    if (t && t.id !== p.spec.id) setFocus(t);
    return;
  }
  const jr = e.target.closest('[data-rank]');              // 다른 STEP 탓 의심 대상이 순위표에 있으면 그 순위를 더해 본다
  if (jr) {
    const j = +jr.dataset.rank;
    S.focus = j;
    setPicks([j], true, tRank(j));
    revealRow(j);
    return;
  }
  if (!p.det) return;                                      // 새 대상을 불러오는 중에는 칸 · 칩을 누르지 않음
  const seg = e.target.closest('[data-r=cseg] button, [data-r=pseg] button');
  if (seg) {
    if (seg.disabled) return;
    if (seg.parentElement.dataset.r === 'cseg') { p.cMode = seg.dataset.v; renderScatter(p); } else { p.pMode = seg.dataset.v; renderPeers(p); }
    setSeg(seg.parentElement, seg.dataset.v);
    return;
  }
  const chip = e.target.closest('.chip');
  if (chip) {
    if (p.sel.length <= 1) return;
    p.sel = p.sel.filter(([q]) => q !== +chip.dataset.q);
    loadPanel(p);
    return;
  }
  const b = e.target.closest('.b[data-q]');
  if (b) {
    const q = +b.dataset.q;
    const u = +b.dataset.u;
    const at = p.sel.findIndex(([qq]) => qq === q);
    if (at >= 0 && p.sel[at][1] === u) {
      if (p.sel.length <= 1) return;
      p.sel.splice(at, 1);
    } else if (at >= 0) p.sel[at][1] = u;
    else p.sel.push([q, u]);
    loadPanel(p);
  }
}

async function loadPanel(p) {
  const rid = S.runId;
  const seq = ++p.seq;
  p.el.classList.add('loading');
  try {
    const det = await post(`/api/runs/${rid}/detail`, { step: p.spec.step, items: p.sel });
    if (rid !== S.runId || seq !== p.seq || S.panel !== p) return;
    p.det = det;
    renderPanel(p);
  } catch (e) {
    if (seq === p.seq && S.panel === p) $('[data-r=dstat]', p.el).innerHTML = `<span class="errtxt">상세를 불러오지 못했습니다: ${esc(e.message)}</span>`;
  } finally {
    if (seq === p.seq) p.el.classList.remove('loading');
  }
}

function renderPanel(p) {
  if (!p.det || !S.res) return;
  renderHead(p);
  renderStat(p);
  renderRelated(p);
  renderBlocks(p);
  renderScatter(p);
  renderPeers(p);
  renderCompare(p);
}

function renderHead(p) {
  const sp = p.spec;
  if (!sp) return;
  const row = S.res.ranking[sp.i];
  const t = sp.t;
  const multi = S.picks.length > 1;                     // 하나만 골랐으면 ◀ ▶로 순위를, 여러 개면 비교 띠의 대상을 넘긴다
  const items = multi ? stripItems() : [];
  const at = items.findIndex((x) => x.id === sp.id);
  const [prev, next, close] = ['prev', 'next', 'close'].map((a) => $(`[data-a=${a}]`, p.el));
  close.hidden = !multi;
  prev.disabled = multi ? at <= 0 : sp.i === 0;
  next.disabled = multi ? at < 0 || at >= items.length - 1 : sp.i >= S.res.ranking.length - 1;
  for (const [b, w] of [[prev, '이전'], [next, '다음']]) {
    const l = `${w} ${multi ? '대상' : '순위'}`;
    b.title = l;
    b.setAttribute('aria-label', l);
  }
  $('[data-r=count]', p.el).textContent = multi ? (at >= 0 ? `고른 대상 ${at + 1} / ${items.length}` : '') : `순위 ${row.rank} / ${S.res.ranking.length}`;
  const title = sp.kind === 'rank' ? `${row.rank}위` : sp.kind === 'member' ? `${row.rank}위에 묶인 대상` : `${row.rank}위 · 다른 STEP 탓 의심`;
  const rel = sp.kind === 'rank' ? '' : ` · ${row.rank}위와 웨이퍼 ${fmt.pct(t.overlap, 0)} 겹침`;
  $('[data-r=dh]', p.el).innerHTML = `<span class="t">${title} · STEP ${esc(stepText(t))}</span>
    <span class="muted"> · ${sp.kind === 'rank' ? '원래 경로' : '경로'} ${esc(t.path)}${rel} · Certainty ${t.certainty == null ? '–' : t.certainty.toFixed(2)}</span>`;
  p.el.classList.toggle('rel', sp.kind !== 'rank');
  renderGroup(p);
}

// 묶음 버튼: 이 순위와 얽힌 대상(대표 · 같은 웨이퍼로 묶인 대상 · 다른 STEP 탓 의심)을 바꿔 본다
function renderGroup(p) {
  const box = $('[data-r=group]', p.el);
  const sp = p.spec;
  const g = groupOf(sp.i);
  if (g.length < 2) { box.hidden = true; box.innerHTML = ''; return; }
  const rank = S.res.ranking[sp.i].rank;
  const name = (x) => (g.filter((y) => y.t.step_name === x.t.step_name).length > 1 ? `${x.t.step_name} ${x.t.path}` : x.t.step_name);
  const label = (x) => (x.kind === 'rank' ? `${name(x)} · 대표` : x.kind === 'member' ? `${name(x)} · 겹침 ${fmt.pct(x.t.overlap, 0)}` : `다른 STEP 의심 · ${name(x)}`);
  box.innerHTML = `<span class="muted small">${rank}위 묶음</span><span class="seg small gsw" role="group" aria-label="${rank}위와 얽힌 대상">`
    + g.map((x) => `<button type="button" data-gid="${esc(x.id)}" class="${x.id === sp.id ? 'on' : ''}" aria-pressed="${x.id === sp.id}" title="${esc(stepText(x.t) + '\n' + x.t.path)}">${esc(label(x))}</button>`).join('')
    + '</span>';
  box.hidden = false;
}

const sameSel = (a, b) => JSON.stringify([...a].sort((x, y) => x[0] - y[0])) === JSON.stringify([...b].sort((x, y) => x[0] - y[0]));

function renderStat(p) {
  const D = p.det;
  const orig = sameSel(p.sel, p.spec.items);
  const sel = D.selection;
  $('[data-r=dstat]', p.el).innerHTML = `지금 선택 <b>${esc(sel.label)}</b> · 웨이퍼 <b>${fmt.int(sel.n)}</b>장`
    + (D.has_bad ? ` · bad <span class="badtxt">${fmt.pct(sel.bad)}</span> (<span class="help-term" data-help="rest">같은 Order를 다른 Unit으로 지난</span> ${fmt.int(sel.rest_n)}장 ${fmt.pct(sel.rest_bad)})` : '')
    + ` · y_value 평균 ${fmt.num(sel.vmean)} · <span class="help-term" data-help="certainty">Certainty</span> ${sel.certainty == null ? '–' : sel.certainty.toFixed(2)}`
    + (orig ? '' : '<span class="badge">탐색 중 (판정 아님)</span>');
  $('[data-r=chips]', p.el).innerHTML = p.sel.slice().sort((a, b) => a[0] - b[0]).map(([q, u]) => {
    const o = D.orders[q];
    return `<button type="button" class="chip" data-q="${q}" title="이 Order 빼기">${esc(o.name)}:${esc(o.units[u].name)} <span aria-hidden="true">×</span></button>`;
  }).join('');
  $('[data-a=reset]', p.el).disabled = orig;
}

function diffText(t, hasBad) {
  if (!t.only_n && !t.ref_only_n) return '없음 (웨이퍼가 똑같음)';
  const part = (n, b) => `${fmt.int(n)}장${hasBad && n ? ` (bad ${fmt.pct(b)})` : ''}`;
  return `이 대상에만 ${part(t.only_n, t.only_bad)} · 대표에만 ${part(t.ref_only_n, t.ref_only_bad)}`;
}

// 순위 하나와 얽힌 다른 대상: 웨이퍼가 같아 이 줄에 묶인 대상 · 다른 STEP 탓 의심 대상 (지금 보는 대상은 '보는 중')
function renderRelated(p) {
  const box = $('[data-r=related]', p.el);
  const sp = p.spec;
  const row = S.res.ranking[sp.i];
  if (!row.merged.length && !row.cross) { box.hidden = true; box.innerHTML = ''; return; }
  const hasBad = S.res.info.has_bad;
  const sw = S.res.info.settings.same_wafers;
  const cert = (v) => (v == null ? '–' : v.toFixed(2));
  const ex = (v) => (hasBad ? fmt.signed(v, 1) : fmt.num(v));
  const metric = hasBad ? '초과 bad' : 'N × ΔValue';
  const act = (id) => (id === sp.id ? '<span class="muted small">보는 중</span>' : `<button type="button" class="ghost mini" data-gid="${esc(id)}">보기</button>`);
  let h = '';
  if (row.merged.length) {
    const tr = (t, rep) => {
      const id = rep ? 'r' + row.rank : 'x' + t.key;
      return `<tr class="${rep ? 'rep' : ''}${id === sp.id ? ' cur' : ''}">
      <td class="l pathcell" title="${esc(stepText(t) + '\n' + t.path)}"><div class="step">${rep ? '<span class="tag">대표</span> ' : ''}${esc(stepText(t))}</div><div class="path">${pathHtml(t.parts)}</div></td>
      <td class="num">${fmt.int(t.n)}</td><td class="num">${rep ? '–' : fmt.pct(t.overlap, 0)}</td>${hasBad ? `<td class="num">${fmt.pct(t.bad)}</td>` : ''}
      <td class="num">${ex(t.excess)}</td><td class="num">${cert(t.certainty)}</td>
      <td class="l diff">${rep ? '' : diffText(t, hasBad)}</td>
      <td class="num">${act(id)}</td></tr>`;
    };
    h += `<div class="rel-head"><b>같은 웨이퍼로 ${row.rank}위에 묶인 대상</b><span class="muted small">웨이퍼가 ${Math.round((sw ?? 0.9) * 100)}% 이상 같은 대상은 순위표에 한 줄로 나오고, 그 줄의 "+${row.merged.length} 같은 웨이퍼"로 펼칩니다</span></div>
      <div class="rel-wrap"><table class="rank rk rel"><thead><tr><th class="l">STEP / Path</th><th class="num">N</th><th class="num">겹침<span class="help" data-help="overlap">${ICON_INFO}</span></th>${hasBad ? '<th class="num">Bad %</th>' : ''}
      <th class="num">${hasBad ? 'Excess bad' : 'N × ΔValue'}</th><th class="num">Certainty</th><th class="l">서로 다른 웨이퍼</th><th></th></tr></thead>
      <tbody>${tr(row, true)}${row.merged.map((t) => tr(t, false)).join('')}</tbody></table></div>
      <div class="muted small rel-why">대표는 ${metric}가 큰 쪽이고, 같으면 계산에서 먼저 나온 쪽(대개 STEP 순서가 앞선 쪽)입니다.
      겹침이 100%면 데이터로는 어느 STEP 탓인지 가릴 수 없고, 100%보다 작으면 '서로 다른 웨이퍼'의 bad가 차이를 만듭니다.</div>`;
  }
  if (row.cross) {
    const c = row.cross;
    const j = S.res.ranking.findIndex((x) => x.key === c.key);
    const btn = j >= 0 ? `<button type="button" class="ghost mini" data-rank="${j}">${j + 1}위로 더해 보기</button>` : act('x' + c.key);
    h += `<div class="rel-head"><b>다른 STEP 탓 의심</b><span class="muted small">이 경로에서 아래 경로를 지난 웨이퍼를 빼면 차이가 사라지고, 아래 경로는 이 경로의 웨이퍼를 빼도 기준선을 넘습니다</span></div>
      <div class="rel-cross"><span class="step">${esc(stepText(c))}</span> <span class="path inline">${pathHtml(c.parts)}</span>
      <span class="muted">· 웨이퍼 ${fmt.int(c.n)}장 · 겹침 ${fmt.pct(c.overlap, 0)}${hasBad ? ` · bad ${fmt.pct(c.bad)}` : ''} · Certainty ${cert(c.certainty)}</span>
      ${btn}</div>`;
  }
  box.innerHTML = h;
  box.hidden = false;
}

function renderBlocks(p) {
  const D = p.det;
  const selMap = new Map(p.sel.map(([q, u]) => [q, u]));
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
      const tip = `${o.name}:${u.name} · 이 Order에서 이 Unit을 지난 웨이퍼 ${u.n}장${D.has_bad ? ` 중 bad ${fmt.pct(u.bad)}` : ''} · y_value 평균 ${fmt.num(u.vmean)}`;
      h += `<div class="b ${on ? 'on' : ''}" style="${bg}" data-q="${o.q}" data-u="${u.u}" title="${esc(tip)}"><div class="nm">${esc(u.name)}</div><div>${val} · ${fmt.int(u.n)}</div></div>`;
    }
  }
  $('[data-r=blocks]', p.el).innerHTML = h + '</div>';
}

// 차트 칸의 크기(CSS로 고정)를 재서 viewBox로
function svgBox(el) {
  const r = el.getBoundingClientRect();
  const W = Math.max(260, Math.round(r.width));
  const H = Math.max(180, Math.round(r.height));
  el.setAttribute('viewBox', `0 0 ${W} ${H}`);
  return [W, H];
}

// 산점도 · 비교 차트에서 웨이퍼마다 어느 묶음(색)인지
function waferGroups(p) {
  const D = p.det;
  const selG = D.sel_group;
  if (p.cMode === 'hi') {
    return { color: (g) => (g === selG ? C.bad : C.muted), items: [{ g: [selG], c: C.bad, l: '선택 경로 ' + (D.groups[selG]?.label ?? '') }, { rest: true, c: C.muted, l: '같은 Order를 다른 Unit으로 지난 웨이퍼' }] };
  }
  const order = D.groups.map((x, g) => g).filter((g) => g !== selG).sort((a, b) => D.groups[b].n - D.groups[a].n);
  const top = order.slice(0, PALETTE.length - 1);
  const other = order.slice(PALETTE.length - 1);
  const col = new Map([[selG, C.bad], ...top.map((g, i) => [g, PALETTE[i]])]);
  const items = [{ g: [selG], c: C.bad, l: D.groups[selG]?.label ?? '' }, ...top.map((g, i) => ({ g: [g], c: PALETTE[i], l: D.groups[g].label }))];
  if (other.length) items.push({ g: other, c: C.muted, l: `기타 ${other.length}개 조합` });
  return { color: (g) => col.get(g) ?? C.muted, items };
}

function groupStats(p, gs) {
  const D = p.det;
  const w = D.wafers;
  let n = 0;
  let b = 0;
  for (let i = 0; i < w.g.length; i++) {
    const g = w.g[i];
    if (gs.rest ? g !== D.sel_group : gs.g.includes(g)) { n++; if (w.b) b += w.b[i]; }
  }
  return { n, bad: n && w.b ? b / n : null };
}

function renderScatter(p) {
  const D = p.det;
  const el = $('[data-r=scatter]', p.el);
  const w = D.wafers;
  const idx = w.t.map((t, i) => i).filter((i) => w.t[i] != null);
  const G = waferGroups(p);
  $('[data-r=slegend]', p.el).innerHTML = G.items.filter((it) => it.g === undefined || it.g[0] >= 0).map((it) => {
    const st = groupStats(p, it);
    return `<span class="item"><span class="dot" style="background:${it.c}"></span>${esc(it.l)} · ${fmt.int(st.n)}장${st.bad != null ? ' · bad ' + fmt.pct(st.bad) : ''}</span>`;
  }).join('') + (D.missing_time ? `<span class="item">track-in 시각이 없는 웨이퍼 ${D.missing_time}장은 빼고 그림</span>` : '');
  const [W, H] = svgBox(el);
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
  const r = S.ptSize;
  const op = r > 4 ? 0.7 : 0.85;
  const selFirst = idx.slice().sort((a, b) => (w.g[a] === D.sel_group ? 1 : 0) - (w.g[b] === D.sel_group ? 1 : 0));
  for (const i of selFirst) s += `<circle cx="${xs(w.t[i]).toFixed(1)}" cy="${ys(w.v[i]).toFixed(1)}" r="${r}" fill="${G.color(w.g[i])}" opacity="${op}" data-i="${i}"/>`;
  el.innerHTML = s;
}

function renderPeers(p) {
  const D = p.det;
  const el = $('[data-r=peers]', p.el);
  const [W, H] = svgBox(el);
  const m = p.pMode;
  const P = D.peers.filter((q) => q[m] != null);
  if (!P.length) { el.innerHTML = `<text x="20" y="40" fill="${C.ink2}">비교할 경로가 없습니다</text>`; return; }
  const L = 56, R = W - 12, T = 10, B = H - 46;
  const nmax = Math.max(...P.map((q) => q.n)) * 1.15;
  const bd = D.peer_bounds && D.peer_bounds[m];
  const bn = D.peer_bounds ? D.peer_bounds.n : [];
  let [lo, hi] = symRange(bd, bn, P.map((q) => q[m]));
  if (m === 'bad') { lo = Math.max(0, lo); hi = Math.min(1, hi); }
  const xs = scaleLin(0, nmax, L, R);
  const ys = scaleLin(lo, hi, B, T);
  const clip = 'pclip';
  let s = `<defs><clipPath id="${clip}"><rect x="${L}" y="${T}" width="${R - L}" height="${B - T}"/></clipPath></defs><g clip-path="url(#${clip})">`;
  if (bd) {
    s += band(bn, bd.lo, bd.hi, xs, ys, [lo, hi]);
    if (bd.mid != null) s += `<line x1="${L}" x2="${R}" y1="${ys(bd.mid)}" y2="${ys(bd.mid)}" stroke="${C.line2}" stroke-dasharray="4 3"/>`;
  }
  s += '</g>';
  const yt = m === 'judg' ? [] : linTicks(lo, hi, 4).map((v) => ({ v, l: m === 'bad' ? Math.round(v * 100) + '%' : fmt.tick(v) }));
  s += axes({ L, R, T, B, xs, ys, xt: linTicks(0, nmax, 5).map((v) => ({ v, l: fmt.int(v) })), yt, xl: '웨이퍼 수', yl: { judg: '종합 점수', mean: 'y_value 평균', bad: 'bad 비율' }[m], yo: 42 });
  const ordered = P.slice().sort((a, b) => (a.g === D.sel_group ? 1 : 0) - (b.g === D.sel_group ? 1 : 0));
  for (const q of ordered) {
    const on = q.g === D.sel_group;
    s += `<circle cx="${xs(q.n).toFixed(1)}" cy="${ys(q[m]).toFixed(1)}" r="${on ? 6 : 4}" fill="${on ? C.bad : C.muted}" opacity="${on ? 1 : 0.85}" data-g="${q.g}"/>`;
  }
  el.innerHTML = s;
}

function peerTip(p, e) {
  const c = e.target.closest('circle[data-g]');
  if (!c || !p.det) { hideTip(); return; }
  const D = p.det;
  const g = +c.dataset.g;
  const q = D.peers.find((x) => x.g === g);
  const grp = D.groups[g];
  showTip(`<b>${esc(grp.label)}</b>${g === D.sel_group ? ' (지금 선택)' : ''}<br>웨이퍼 ${fmt.int(q.n)}장${q.bad != null ? ' · bad ' + fmt.pct(q.bad) : ''} · y_value 평균 ${fmt.num(q.mean)}<br>Certainty ${q.certainty == null ? '–' : q.certainty.toFixed(2)}`, e.clientX, e.clientY);
}

function renderCompare(p) {
  const D = p.det;
  const el = $('[data-r=compare]', p.el);
  const [W] = svgBox(el);
  const w = D.wafers;
  const mem = [];
  const rest = [];
  w.g.forEach((g, i) => (g === D.sel_group ? mem : rest).push(i));
  const L = 66, R = W - 46;
  const GR = [[mem, '이 경로', C.bad], [rest, '다른 Unit', C.muted]];
  let s = '';
  let y0 = 18;
  if (D.has_bad) {
    const br = (a) => (a.length ? a.reduce((x, i) => x + w.b[i], 0) / a.length : 0);
    const bmax = Math.max(br(mem), br(rest), 0.05) * 1.25;
    s += `<text x="0" y="${y0}" fill="${C.ink2}" font-size="12">bad 비율</text>`;
    GR.forEach(([a, l, c], k) => {
      const y = y0 + 10 + k * 24;
      const bw = (br(a) / bmax) * (R - L);
      s += `<text x="${L - 6}" y="${y + 12}" text-anchor="end" fill="${C.ink2}" font-size="12">${l}</text><rect x="${L}" y="${y}" width="${bw.toFixed(1)}" height="16" rx="3" fill="${c}"/>`
        + `<text x="${(L + bw + 5).toFixed(1)}" y="${y + 12}" fill="${C.ink}" font-size="12">${fmt.pct(br(a))} · ${fmt.int(a.length)}장</text>`;
    });
    y0 += 84;
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
    const y = y0 + 14 + k * 52;
    s += `<text x="${L - 6}" y="${y + 20}" text-anchor="end" fill="${C.ink2}" font-size="12">${l}</text>`;
    if (!v.length) return;
    const q = [0.05, 0.25, 0.5, 0.75, 0.95].map((pp) => quantile(v, pp));
    const show = a.length > 600 ? a.filter((_, j) => j % Math.ceil(a.length / 600) === 0) : a;
    for (const i of show) s += `<circle cx="${xs(w.v[i]).toFixed(1)}" cy="${(y + 16 + rnd() * 26).toFixed(1)}" r="2" fill="${c}" opacity="0.45"/>`;
    s += `<line x1="${xs(q[0])}" x2="${xs(q[4])}" y1="${y + 16}" y2="${y + 16}" stroke="${c}" stroke-width="1.2"/>`
      + `<rect x="${xs(q[1])}" y="${y + 3}" width="${Math.max(1, xs(q[3]) - xs(q[1]))}" height="26" fill="none" stroke="${c}" stroke-width="1.4"/>`
      + `<line x1="${xs(q[2])}" x2="${xs(q[2])}" y1="${y + 1}" y2="${y + 31}" stroke="${C.ink}" stroke-width="2.2"/>`;
  });
  const ay = y0 + 14 + 2 * 52 + 4;
  const tk = log ? logTicks(sv[0], sv[sv.length - 1]) : linTicks(sv[0], sv[sv.length - 1], 5);
  s += `<line x1="${L}" x2="${R}" y1="${ay}" y2="${ay}" stroke="${C.line2}"/>` + tk.map((v) => `<text x="${xs(v)}" y="${ay + 14}" text-anchor="middle" fill="${C.ink2}" font-size="11">${fmt.tick(v)}</text>`).join('')
    + `<text x="${(L + R) / 2}" y="${ay + 30}" text-anchor="middle" fill="${C.ink}" font-size="12">y_value${log ? ' (로그 눈금)' : ''}</text>`;
  el.innerHTML = s;
}

// ── 로딩 장면: 픽셀 칩 캐릭터가 걷고, 줄무늬 구름과 땅이 흘러간다 (계산 · DB 가져오기 중) ─────────
// 칸 하나 = 픽셀 하나. B 몸 · D 그늘 · E 눈 · K 1번 핀 표시 · P 핀 · L 다리
const CRITTER_STAND = ['..............', '..............', '...BBBBBBBD...', '.PPBKBBBBBDPP.', '...BBEBBEBD...',
  '.PPBBBBBBBDPP.', '...BBBBBBBD...', '...BBBBBBBD...', '....LL..LL....', '....LL..LL....'];
const CRITTER_UP_L = ['..............', '...BBBBBBBD...', '.PPBKBBBBBDPP.', '...BBEBBEBD...', '.PPBBBBBBBDPP.',
  '...BBBBBBBD...', '...BBBBBBBD...', '....LL..LL....', '........LL....', '........LL....'];
const CRITTER_UP_R = ['..............', '...BBBBBBBD...', '.PPBKBBBBBDPP.', '...BBEBBEBD...', '.PPBBBBBBBDPP.',
  '...BBBBBBBD...', '...BBBBBBBD...', '....LL..LL....', '....LL........', '....LL........'];
const CLOUD_A = ['..........######....', '.........#########..', '..####..###########.', '.##################.', '####################'];
const CLOUD_B = ['.....####.....', '..#########...', '.############.', '##############'];

// 픽셀 그림 → 같은 글자가 이어진 가로 줄마다 rect 하나
function pixelRects(rows, cell, fill) {
  let s = '';
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length;) {
      const ch = row[x];
      let w = 1;
      while (row[x + w] === ch) w++;
      if (ch !== '.') s += `<rect x="${x * cell}" y="${y * cell}" width="${w * cell}" height="${cell}" ${fill(ch)}/>`;
      x += w;
    }
  });
  return s;
}

function buildScene() {
  const strip = (w, clouds) => `<svg width="${w}" height="52" viewBox="0 0 ${w} 52" shape-rendering="crispEdges">`
    + clouds.map(([shape, x, y]) => `<g transform="translate(${x} ${y})">${pixelRects(shape, 4, () => 'fill="url(#uc-hatch)"')}</g>`).join('') + '</svg>';
  const layer = (cls, w, clouds) => `<div class="clouds ${cls}">${strip(w, clouds).repeat(5)}</div>`;
  const frames = [CRITTER_STAND, CRITTER_UP_L, CRITTER_STAND, CRITTER_UP_R]
    .map((f, i) => `<g class="f f${i + 1}">${pixelRects(f, 1, (ch) => `class="px-${ch}"`)}</g>`).join('');
  $('#scene').innerHTML = '<svg width="0" height="0" style="position:absolute"><defs><pattern id="uc-hatch" width="2" height="3" patternUnits="userSpaceOnUse">'
    + '<rect width="1" height="3" class="hatch"/></pattern></defs></svg>'
    + layer('far', 560, [[CLOUD_B, 40, 6], [CLOUD_A, 300, 0]])
    + layer('near', 700, [[CLOUD_A, 110, 8], [CLOUD_B, 460, 20]])
    + '<div class="ground"></div>'
    + `<svg class="critter" viewBox="0 0 14 10" shape-rendering="crispEdges">${frames}</svg>`;
}

function showLoader(text, sec, frac) {
  $('#loader').hidden = false;
  syncEmpty();
  $('#loader-text').textContent = text;
  $('#loader-time').textContent = sec != null ? ` · ${Math.round(sec)}초` : '';
  $('#loader-bar').style.width = `${Math.round(frac * 100)}%`;
}

function hideLoader() {
  $('#loader').hidden = true;
  syncEmpty();
}

// ── 시작 화면 ─────────────────────────────────────────────────────────
function homeMsg(html, cls = '') {
  const e = $('#home-msg');
  e.className = 'home-msg ' + cls;
  e.innerHTML = html || '';
}

// mode 'search' = 입력한 Job ID로 찾은 실행 · 'recent' = 최근 실행
function homeOpen(mode) {
  const q = $('#home-q').value.trim();
  const k = q.toLowerCase();
  const items = mode === 'recent' ? S.runs.slice(0, 8)
    : k ? S.runs.filter((v) => [...(v.job_ids || []), v.file_name || ''].join(' ').toLowerCase().includes(k)) : [];
  const db = mode === 'search' && S.db && JOB_RE.test(q);   // 숫자 Job ID면 목록 끝에 "DB에서 가져와 분석"
  S.home = { items, at: items.length || db ? 0 : -1, mode, q, db };
  homeRender();
}

function homeClose() {
  S.home.mode = null;
  homeRender();
}

function homeResult(v) {
  if (v.status === 'done') return `혐의 대상 <b>${fmt.int(v.targets)}</b>개`;
  if (v.status === 'running') return '<span class="live"></span>실행 중';
  if (v.status === 'queued') return '<span class="live"></span>대기 중';
  return '<span class="errtxt">오류</span>';
}

function homeRender() {
  const box = $('#home-list');
  const input = $('#home-q');
  const { items, at, mode, q, db } = S.home;
  $('#home-recent').setAttribute('aria-expanded', String(mode === 'recent'));
  if (!mode || (mode === 'search' && !q)) {
    box.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    return;
  }
  const rows = items.slice(0, 8).map((v, j) => {
    const jobs = v.job_ids || [];
    return `<div class="hl-row${j === at ? ' on' : ''}" id="hl-${j}" role="option" aria-selected="${j === at}" data-id="${esc(v.id)}">
      <div class="hl-job"><b>${jobs.length ? esc(jobs[0]) : '–'}</b>${jobs.length > 1 ? ` <span class="muted">외 ${jobs.length - 1}</span>` : ''}<span class="muted"> · ${esc((v.analysis_dates || [])[0] || '')}</span></div>
      <div class="hl-res">${homeResult(v)}</div>
      <div class="hl-meta">${esc(v.file_name || v.file_id)} · ${when(v.created)} 실행 · ${esc(settingsText(v.settings).main)}</div></div>`;
  }).join('');
  const n = Math.min(8, items.length);
  const dbRow = db ? `<div class="hl-row hl-db${at === n ? ' on' : ''}" id="hl-${n}" role="option" aria-selected="${at === n}" data-db="${esc(q)}">
      <div class="hl-job"><b>DB에서 job_id ${esc(q)} 가져와 분석</b></div><div class="hl-res">새로 실행 →</div>
      <div class="hl-meta">DB에서 이력을 읽어 raw.csv를 만든 뒤 기본 설정(${esc(settingsText(S.defaults || {}).main)})으로 실행합니다. 데이터가 없으면 raw.csv를 올리라고 알려 드립니다.</div></div>` : '';
  const head = mode === 'recent' ? '최근 실행' : items.length ? `‘${esc(q)}’ 실행 기록 ${items.length}개${items.length > 8 ? ' (최근 8개)' : ''}` : `‘${esc(q)}’`;
  const noDb = mode === 'search' && JOB_RE.test(q) && !S.db ? ' 서버에 DB 접속 정보가 없어 Job ID로는 가져올 수 없습니다.' : '';
  const empty = mode === 'recent' ? '아직 실행 기록이 없습니다. Job ID를 넣거나 왼쪽 CSV 버튼으로 raw.csv를 올려 시작하세요.'
    : `‘${esc(q)}’로 실행한 기록이 없습니다.${noDb} 왼쪽 CSV 버튼으로 이 Job의 raw.csv를 올려 분석할 수 있습니다.`;
  box.innerHTML = `<div class="hl-head">${head}</div>${rows || (db ? '' : `<div class="hl-empty">${empty}</div>`)}${dbRow}<a class="hl-all" href="#analysis">전체 실행 기록 · 설정 화면으로 →</a>`;
  box.hidden = false;
  input.setAttribute('aria-expanded', 'true');
  if (at >= 0) input.setAttribute('aria-activedescendant', 'hl-' + at); else input.removeAttribute('aria-activedescendant');
}

function homePick(id) {
  homeClose();
  go('#run=' + id);
}

// Job ID로 DB에서 가져와 실행 (기본 설정). 데이터가 없으면 분석 화면에서 raw.csv를 올리라고 안내한다
async function homeFetch(jid) {
  homeClose();
  homeMsg(`DB에서 job_id ${esc(jid)} 가져오기를 시작합니다…`);
  try {
    const r = await post('/api/jobs', { job_id: jid, settings: {} });
    homeMsg('');
    await refreshRuns();
    detachFile(jid);
    go('#run=' + r.run_id);
  } catch (e) {
    homeMsg(esc(e.message), 'error');
  }
}

function bindHome() {
  const q = $('#home-q');
  q.addEventListener('input', () => homeOpen('search'));
  q.addEventListener('keydown', (e) => {
    const h = S.home;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!h.mode) { homeOpen(q.value.trim() ? 'search' : 'recent'); return; }
      const n = Math.min(8, h.items.length) + (h.db ? 1 : 0);
      if (!n) return;
      h.at = (h.at + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
      homeRender();
    } else if (e.key === 'Escape') homeClose();
  });
  $('#home-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = q.value.trim();
    if (!v) { homeOpen('recent'); return; }
    if (S.home.mode !== 'search' || S.home.q !== v) homeOpen('search');
    const h = S.home;
    if (h.at >= 0 && h.at < Math.min(8, h.items.length)) homePick(h.items[h.at].id);
    else if (h.db && h.at === Math.min(8, h.items.length)) homeFetch(v);   // 기록이 없으면 DB에서 가져오고, 그것도 안 되면 목록에 안내가 나온다
  });
  $('#home-list').addEventListener('click', (e) => {
    const r = e.target.closest('.hl-row');
    if (!r) return;
    if (r.dataset.db) homeFetch(r.dataset.db); else homePick(r.dataset.id);
  });
  $('#home-recent').addEventListener('click', () => { if (S.home.mode === 'recent') homeClose(); else homeOpen('recent'); });
  document.addEventListener('pointerdown', (e) => { if (S.home.mode && !e.target.closest('.query-panel')) homeClose(); });
  $('#home-upload').addEventListener('click', () => $('#home-file').click());
  $('#home-file').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    const btn = $('#home-upload');
    btn.disabled = true;
    try {
      const meta = await upload(f, (pr) => homeMsg(uploadBar(f.name, pr)));
      await loadFiles(meta.id);
      homeMsg('');
      go('#analysis');
      status('');
      toast(`올렸습니다 · ${esc(meta.name)} (${(meta.size / 1e6).toFixed(0)}MB). 설정을 확인하고 Run을 누르세요.`);
      $('#run').focus();
    } catch (err) {
      homeMsg(esc(err.message), 'error');
    }
    btn.disabled = false;
  });
  const logo = $('.home .uc-logo');                   // 처음 한 번만 움직이고, 다시 돌아오면 그대로
  logo.addEventListener('animationend', (e) => { if (e.target.classList.contains('us')) logo.classList.add('still'); });
}

// ── 이벤트 ─────────────────────────────────────────────────────────────
function bindAxisTips(el) {
  for (const b of $$('button', el)) {
    b.addEventListener('mouseenter', () => {
      const k = b.dataset.v;
      const r = b.getBoundingClientRect();
      showTip(`<b>${AXIS_TIP[k][0]}</b><svg viewBox="0 0 230 84" width="230" height="84">${axisTipSvg(k)}</svg><div class="muted">${AXIS_TIP[k][1]}</div>`, r.left, r.bottom - 8);
    });
    b.addEventListener('mouseleave', hideTip);
  }
}

let resizeTimer = null;
// 화면 폭이 바뀌면(창 크기 · Windows 스크롤바가 생기고 없어질 때 · 확대) 차트를 그 폭으로 다시 그린다.
// 예전 폭으로 그린 그림을 늘리거나 줄여 보여 주면 글자가 흐려지기 때문
function watchWidths() {
  const last = new WeakMap();
  const ro = new ResizeObserver((entries) => {
    let changed = false;
    for (const en of entries) {
      const w = Math.round(en.contentRect.width);
      if (last.has(en.target) && last.get(en.target) !== w) changed = true;
      last.set(en.target, w);
    }
    if (changed) { clearTimeout(resizeTimer); resizeTimer = setTimeout(rerender, 120); }
  });
  ro.observe($('.page'));
  ro.observe($('#funnel'));
}

function rerender() {
  if (!S.res || S.view !== 'app') return;
  renderFunnel();
  if (S.panel && S.panel.det) renderPanel(S.panel);
}

function bindRanking() {
  const tbl = $('#ranking');
  tbl.addEventListener('mouseover', (e) => {
    const tr = e.target.closest('tbody tr[data-i]');
    setHover(tr ? { rank: S.res.ranking[+tr.dataset.i].rank, key: tr.dataset.key || null } : null);
  });
  tbl.addEventListener('mouseleave', () => setHover(null));
  tbl.addEventListener('mousedown', (e) => { if (e.shiftKey) e.preventDefault(); });   // Shift+클릭 때 글자가 선택되지 않게
  tbl.addEventListener('click', (e) => {
    if (e.target.closest('.help')) return;              // ⓘ는 설명만 (정렬하지 않음)
    const grp = e.target.closest('.grp[data-grp]');        // "+n 같은 웨이퍼": 묶인 대상 줄을 펼치거나 접기
    if (grp) {
      const i = +grp.dataset.grp;
      if (S.open.has(i)) S.open.delete(i); else S.open.add(i);
      renderRanking();
      return;
    }
    const th = e.target.closest('th');
    if (th) {
      const k = th.dataset.k;
      S.sort = { key: k, dir: S.sort.key === k ? -S.sort.dir : (k === 'rank' || k === 'path' ? 1 : -1) };
      renderRanking();
      return;
    }
    const tr = e.target.closest('tbody tr[data-i]');
    if (!tr) return;
    const i = +tr.dataset.i;
    if (tr.dataset.key) { focusMember(i, tr.dataset.key, e.ctrlKey || e.metaKey); return; }   // 묶인 대상 줄
    if (e.shiftKey && S.focus != null) {                    // Shift: 마지막으로 고른 줄부터 이 줄까지 (지금 정렬 순서로)
      const rows = sortedRows().map((o) => o.i);
      const a = rows.indexOf(S.focus);
      const b = rows.indexOf(i);
      setPicks(rows.slice(Math.min(a, b), Math.max(a, b) + 1), e.ctrlKey || e.metaKey, tRank(i));
      return;
    }
    S.focus = i;
    if (e.ctrlKey || e.metaKey) togglePick(i); else setPicks([i]);
  });
  tbl.addEventListener('keydown', (e) => {
    if (!S.res || !['ArrowDown', 'ArrowUp'].includes(e.key)) return;
    e.preventDefault();
    const rows = sortedRows().map((o) => o.i);
    const at = Math.max(0, rows.indexOf(S.focus));
    const next = rows[Math.max(0, Math.min(rows.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (next === undefined) return;
    S.focus = next;
    setPicks([next]);
    revealRow(next);
  });
}

function bindFunnel() {
  $('#yseg').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || b.disabled || !S.res) return;
    S.yMode = b.dataset.v;
    setSeg($('#yseg'), S.yMode);
    renderFunnel();
  });
  bindAxisTips($('#yseg'));
  const fsv = $('#funnel svg');
  fsv.addEventListener('mousemove', markTip);
  fsv.addEventListener('mouseleave', hideTip);
  fsv.addEventListener('click', (e) => {
    if (S.brushed || !S.res || !S.fn) return;
    const add = e.shiftKey || e.ctrlKey || e.metaKey;
    const c = e.target.closest('circle[data-i]');
    const k = c ? S.res.funnel.marks[+c.dataset.i] : null;
    const r = k ? k.rank || k.target : null;
    if (!r) {                                         // 빈 곳(또는 순위와 상관없는 점)을 누르면 선택을 푼다
      const box = fsv.getBoundingClientRect();
      const x = e.clientX - box.left;
      const y = e.clientY - box.top;
      const f = S.fn;
      if (!add && x >= f.L && x <= f.R && y >= f.T && y <= f.B) clearPicks();
      return;
    }
    if (k.merged && !k.rank && k.key != null) { focusMember(k.merged - 1, k.key, add); return; }   // 묶인 대상의 점 (번호 없음)
    S.focus = r - 1;
    if (add) togglePick(r - 1); else setPicks([r - 1]);
    revealRow(r - 1);
  });
  bindBrush();
}

function init() {
  readColors();
  S.ptSize = store.get('uc.ptSize2', 4.5);
  S.fView = store.get('uc.fview', 'all');
  setSeg($('#fview'), S.fView);
  document.addEventListener('uc-theme', () => { readColors(); rerender(); });   // 밝은 · 어두운 화면을 바꾸면 차트 색을 다시 읽어 그린다
  watchWidths();
  window.addEventListener('hashchange', route);
  window.addEventListener('popstate', route);
  $('#file').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const meta = await upload(f, (p) => status(uploadBar(f.name, p)));
      await loadFiles(meta.id);
      status('');
      toast(`올렸습니다 · ${esc(meta.name)} (${(meta.size / 1e6).toFixed(0)}MB). Run을 누르세요.`);
    } catch (err) {
      status(esc(err.message), 'error');
    }
    e.target.value = '';
  });
  $('#no_limit').addEventListener('change', (e) => { $('#max_depth').disabled = e.target.checked; });
  $('#adv-btn').addEventListener('click', () => {
    const adv = $('#adv');
    adv.hidden = !adv.hidden;
    $('#adv-btn').setAttribute('aria-expanded', String(!adv.hidden));
    $('#adv-ico').textContent = adv.hidden ? '▾' : '▴';
  });
  $('#run').addEventListener('click', run);
  $('#csv-btn').addEventListener('click', () => $('#file').click());
  $('#q-file-x').addEventListener('click', () => { detachFile(); $('#job_id').focus(); });
  $('#job_id').addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
  $('#status').addEventListener('click', (e) => { if (e.target.closest('[data-act=upload]')) $('#file').click(); });
  $('#top-history').addEventListener('click', () => { if ($('#drawer').classList.contains('open')) closeDrawer(); else openDrawer(); });
  $('#drawer-close').addEventListener('click', closeDrawer);
  $('#backdrop').addEventListener('click', closeDrawer);
  $('#empty-all').addEventListener('click', openDrawer);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
  $('#history').addEventListener('click', (e) => {
    const del = e.target.closest('[data-del]');
    if (del) { removeRun(del.dataset.del); return; }
    const tr = e.target.closest('tbody tr[data-id]');
    if (!tr) return;
    closeDrawer();
    if (tr.dataset.id !== S.runId || !S.res) openRun(tr.dataset.id);
  });
  const openRecent = (e) => { const r = e.target.closest('.rl-row'); if (r) openRun(r.dataset.id); };
  $('#recent-list').addEventListener('click', openRecent);
  $('#recent-list').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openRecent(e); } });
  $('#setup-open').addEventListener('click', () => { setSetup(true); if (!S.fileId) $('#job_id').focus(); });
  $('#setup-close').addEventListener('click', () => setSetup(false));
  $('#concl-copy').addEventListener('click', async () => {
    toast(await copyText(S.conclText) ? '결론 문장을 복사했습니다. 회의록 · 메신저에 붙여 넣으세요.' : '복사하지 못했습니다. 문장을 드래그해서 복사하세요.', { kind: '' });
  });
  $('#rank-csv').addEventListener('click', () => { if (S.res) rankingCsv(); });
  $('#fview').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || !S.res) return;
    S.fView = b.dataset.v;
    store.set('uc.fview', S.fView);
    setSeg($('#fview'), S.fView);
    renderFunnel();
  });
  document.addEventListener('mouseover', (e) => {      // 용어 도움말
    const h = e.target.closest('[data-help]');
    if (!h) return;
    const r = h.getBoundingClientRect();
    showTip(`<div class="help-tip">${esc(HELP[h.dataset.help] || '')}</div>`, r.left, r.bottom - 6);
  });
  document.addEventListener('mouseout', (e) => {
    const h = e.target.closest('[data-help]');
    if (h && !(e.relatedTarget && h.contains(e.relatedTarget))) hideTip();
  });
  $('#hist-q').addEventListener('input', (e) => { S.histQ = e.target.value; renderHistory(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshRuns(); });   // 다시 보면 바로 새로 읽음
  bindFunnel();
  bindRanking();
  bindStrip();
  bindHome();
  buildScene();
  loadFiles().catch((e) => status('파일 목록을 읽지 못했습니다: ' + esc(e.message), 'error'))
    .then(() => refreshRuns())
    .then((ok) => {
      const m = /^#run=([0-9a-f]+)$/.exec(location.hash);        // 주소에 실행 id가 있으면 그 기록을 연다 (링크 공유)
      if (m && ok && !S.runs.some((v) => v.id === m[1])) history.replaceState(null, '', '#analysis');
      route();
    });
}

document.addEventListener('DOMContentLoaded', init);
