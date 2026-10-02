'use strict';
// 밝은 · 어두운 화면: 오른쪽 위 아이콘으로 바꾸고, 고른 것은 이 브라우저에 기억한다. 고르지 않았으면 운영체제 설정을 따른다.
// 화면이 그려지기 전에 정해야 깜빡이지 않아서 <head>에서 읽는다
(function () {
  const KEY = 'uc.theme';
  const root = document.documentElement;
  const mq = matchMedia('(prefers-color-scheme: dark)');
  const saved = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
  const apply = (t) => {
    root.dataset.theme = t;
    const label = t === 'dark' ? '밝은 화면으로' : '어두운 화면으로';
    for (const b of document.querySelectorAll('[data-theme-toggle]')) { b.title = label; b.setAttribute('aria-label', label); }
    document.dispatchEvent(new CustomEvent('uc-theme', { detail: t }));     // 차트는 색을 다시 읽어 그린다
  };
  apply(saved() || (mq.matches ? 'dark' : 'light'));
  mq.addEventListener('change', () => { if (!saved()) apply(mq.matches ? 'dark' : 'light'); });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('[data-theme-toggle]')) return;
    const t = root.dataset.theme === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem(KEY, t); } catch { /* 기억하지 못해도 지금 화면은 바뀐다 */ }
    apply(t);
  });
  document.addEventListener('DOMContentLoaded', () => apply(root.dataset.theme));   // 버튼 설명 맞추기
})();
