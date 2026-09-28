// 시드 고정 난수: mulberry32 + Box-Muller 정규난수

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeRng(seed) {
  const u = mulberry32(seed);
  let spare = null;
  return {
    u,
    normal() {
      if (spare !== null) {
        const s = spare;
        spare = null;
        return s;
      }
      let a, b, r;
      do {
        a = u() * 2 - 1;
        b = u() * 2 - 1;
        r = a * a + b * b;
      } while (r === 0 || r >= 1);
      const f = Math.sqrt((-2 * Math.log(r)) / r);
      spare = b * f;
      return a * f;
    },
    // [lo, hi] 정수
    int(lo, hi) {
      return lo + Math.floor(u() * (hi - lo + 1));
    },
    pick(arr) {
      return arr[Math.floor(u() * arr.length)];
    },
    // 성공확률 p 인 기하분포의 실패 횟수 (0, 1, 2, ...) — 상한 없음
    geometric(p) {
      return Math.floor(Math.log(1 - u()) / Math.log(1 - p));
    },
    // 누적 가중치 배열에서 인덱스 선택
    weighted(cum) {
      const x = u() * cum[cum.length - 1];
      let i = 0;
      while (cum[i] < x) i++;
      return i;
    },
    shuffle(arr) {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(u() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr;
    },
  };
}
