// 순열 기반 경험적 envelope (Westfall–Young max-T)
// Y를 웨이퍼 간에 섞어 "불량이 전혀 없을 때"의 깊이별 최대 z 분포를 만들고,
// 그 (1−α) 분위수를 envelope 임계값으로 쓴다. 조합들이 웨이퍼를 공유하는 상관 구조가 그대로 반영된다.
// (후보 조합 집합은 원 데이터 기준으로 고정)

self.onmessage = (ev) => {
  const { Y, members, offsets, depth, nPerm, alpha, seed, maxDepth } = ev.data;
  const N = Y.length;
  const C = depth.length;

  let a = seed >>> 0;
  const rand = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  let tot = 0, tss = 0;
  for (let i = 0; i < N; i++) {
    tot += Y[i];
    tss += Y[i] * Y[i];
  }
  const mu = tot / N;
  const sd = Math.sqrt((tss - (tot * tot) / N) / (N - 1));
  const invSe = new Float64Array(C);
  for (let c = 0; c < C; c++) invSe[c] = Math.sqrt(offsets[c + 1] - offsets[c]) / sd;

  const perm = Float64Array.from(Y);
  const maxZ = Array.from({ length: maxDepth + 1 }, () => []);
  const cur = new Float64Array(maxDepth + 1);

  for (let r = 0; r < nPerm; r++) {
    for (let i = N - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const t = perm[i];
      perm[i] = perm[j];
      perm[j] = t;
    }
    cur.fill(-Infinity);
    for (let c = 0; c < C; c++) {
      const lo = offsets[c], hi = offsets[c + 1];
      let s = 0;
      for (let m = lo; m < hi; m++) s += perm[members[m]];
      const z = (s / (hi - lo) - mu) * invSe[c];
      if (z > cur[depth[c]]) cur[depth[c]] = z;
    }
    for (let k = 1; k <= maxDepth; k++) if (cur[k] > -Infinity) maxZ[k].push(cur[k]);
    if ((r + 1) % 5 === 0 || r === nPerm - 1) self.postMessage({ type: 'progress', done: r + 1, total: nPerm });
  }

  const z = [0];
  for (let k = 1; k <= maxDepth; k++) {
    const arr = maxZ[k].sort((x, y) => x - y);
    if (!arr.length) {
      z[k] = null;
      continue;
    }
    const h = (arr.length - 1) * (1 - alpha);
    const lo = Math.floor(h);
    z[k] = arr[lo] + (h - lo) * ((arr[Math.min(lo + 1, arr.length - 1)]) - arr[lo]);
  }
  self.postMessage({ type: 'done', z, nPerm });
};
