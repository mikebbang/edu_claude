// 분석: 순서별 유닛 ANOVA → 스텝 내 유닛 조합(Apriori 확장) → funnel 판정
//
// 조합(combo) = 한 스텝 안에서 k개 순서의 유닛을 동시에 지난 웨이퍼 집합.
// 모든 스텝이 필수 공정이라 웨이퍼 집합이 같으므로 전체 평균 μ, 표준편차 σ 하나로
// 모든 조합의 envelope μ ± z·σ/√n 을 공통으로 쓴다.

export const MISSING = 0xffff; // 결측(해당 스텝 이력 없음)
import { anova, welch, normSf, normInv, bhQ, meanOf, varOf } from './stats.mjs';

export const Z95 = 1.959964; // 양측 95%
export const Z998 = 3.090232; // 양측 99.8%
export const LIFT_ALPHA = 0.001; // 부모 대비 리프트 검정 유의수준(단측)
export const FWER_ALPHA = 0.05; // 깊이별 다중비교 보정 유의수준

const comboKey = (s, items) => `${s}|` + items.map(([q, u]) => `${q}:${u}`).join('|');

// 크기 k인 조합 생성
function* kSubsets(arr, k, start = 0, acc = []) {
  if (acc.length === k) {
    yield acc.slice();
    return;
  }
  for (let i = start; i <= arr.length - (k - acc.length); i++) {
    acc.push(arr[i]);
    yield* kSubsets(arr, k, i + 1, acc);
    acc.pop();
  }
}

export function analyze(data, { minN = 20, maxDepth = 3, fullDepth = 2 } = {}) {
  const { N, Y, steps, assign } = data;

  let tot = 0, tss = 0;
  for (let w = 0; w < N; w++) {
    tot += Y[w];
    tss += Y[w] * Y[w];
  }
  const mu = tot / N;
  const sd = Math.sqrt((tss - (tot * tot) / N) / (N - 1));
  const zOf = (g) => (g.sum / g.n - mu) / (sd / Math.sqrt(g.n));

  // 순서 튜플 단위 그룹 집계 (한 번의 웨이퍼 순회로 모든 유닛 조합 셀을 채움)
  const groupCache = new Map();
  function getGroup(s, qs) {
    const ck = `${s}:${qs.join(',')}`;
    let g = groupCache.get(ck);
    if (g) return g;
    const arrs = qs.map((q) => assign[s][q]);
    const dims = qs.map((q) => steps[s].seqs[q].units.length);
    const size = dims.reduce((a, b) => a * b, 1);
    const n = new Int32Array(size), sum = new Float64Array(size), ss = new Float64Array(size);
    outer: for (let w = 0; w < N; w++) {
      let key = 0;
      for (let i = 0; i < arrs.length; i++) {
        const v = arrs[i][w];
        if (v === MISSING) continue outer;
        key = key * dims[i] + v;
      }
      const y = Y[w];
      n[key]++;
      sum[key] += y;
      ss[key] += y * y;
    }
    g = { qs, dims, n, sum, ss };
    groupCache.set(ck, g);
    return g;
  }
  // 가지치기된 튜플도 탐색 공간 크기에는 포함해야 하므로, 캐시 없이 n ≥ minN 셀 수만 센다
  function countCells(s, qs) {
    const arrs = qs.map((q) => assign[s][q]);
    const dims = qs.map((q) => steps[s].seqs[q].units.length);
    const n = new Int32Array(dims.reduce((a, b) => a * b, 1));
    outer: for (let w = 0; w < N; w++) {
      let key = 0;
      for (let i = 0; i < arrs.length; i++) {
        const v = arrs[i][w];
        if (v === MISSING) continue outer;
        key = key * dims[i] + v;
      }
      n[key]++;
    }
    let c = 0;
    for (let i = 0; i < n.length; i++) if (n[i] >= minN) c++;
    return c;
  }
  const decode = (g, key) => {
    const units = new Array(g.dims.length);
    for (let i = g.dims.length - 1; i >= 0; i--) {
      units[i] = key % g.dims[i];
      key = Math.floor(key / g.dims[i]);
    }
    return g.qs.map((q, i) => [q, units[i]]);
  };
  function statsOf(s, items) {
    const g = getGroup(s, items.map((it) => it[0]));
    let key = 0;
    items.forEach(([, u], i) => (key = key * g.dims[i] + u));
    return { n: g.n[key], sum: g.sum[key], ss: g.ss[key] };
  }

  // 1) 순서별 유닛 유의차
  let stepN = [];
  const seqInfo = steps.map((step, s) => {
    stepN.push(0);
    return step.seqs.map((seq, q) => {
      const g = getGroup(s, [q]);
      const units = seq.units.map((name, u) => {
        const st = { n: g.n[u], sum: g.sum[u], ss: g.ss[u] };
        return { name, n: st.n, mean: st.n ? meanOf(st) : NaN, sd: Math.sqrt(varOf(st)) };
      });
      if (q === 0) stepN[s] = units.reduce((a, u) => a + u.n, 0);
      const testable = seq.units.length >= 2;
      const groups = seq.units.map((_, u) => ({ n: g.n[u], sum: g.sum[u], ss: g.ss[u] }));
      return { name: seq.name, units, testable, anova: testable ? anova(groups) : null };
    });
  });

  // 2) 조합 생성 (Apriori: 부모가 95% 상한을 넘은 경우에만 한 단계 확장)
  const combos = [];
  const byKey = new Map();
  const flagged = new Set(); // z > Z95 인 조합 키
  const flaggedTuples = []; // depth별: `${s}|q1,q2` 집합
  const add = (s, items, g) => {
    const c = {
      id: combos.length,
      key: comboKey(s, items),
      step: s,
      k: items.length,
      items,
      n: g.n,
      sum: g.sum,
      ss: g.ss,
      mean: g.sum / g.n,
    };
    c.z = zOf(c);
    combos.push(c);
    byKey.set(c.key, c);
    if (c.z > Z95) {
      flagged.add(c.key);
      flaggedTuples[c.k].add(`${s}|${items.map((i) => i[0]).join(',')}`);
    }
    return c;
  };

  const multi = steps.map((step) => step.seqs.map((sq, q) => q).filter((q) => step.seqs[q].units.length >= 2));

  flaggedTuples[1] = new Set();
  steps.forEach((step, s) => {
    for (const q of multi[s]) {
      const g = getGroup(s, [q]);
      for (let u = 0; u < g.n.length; u++) {
        if (g.n[u] >= minN) add(s, [[q, u]], { n: g.n[u], sum: g.sum[u], ss: g.ss[u] });
      }
    }
  });

  // 탐색 공간 크기(다중비교 보정용): 가지치기와 무관하게 n ≥ minN 인 모든 셀 수
  const searchSpace = [0, 0, 0, 0];
  searchSpace[1] = combos.length;

  for (let k = 2; k <= maxDepth; k++) {
    flaggedTuples[k] = new Set();
    steps.forEach((step, s) => {
      if (multi[s].length < k) return;
      for (const qs of kSubsets(multi[s], k)) {
        // k ≤ fullDepth 는 전수 평가(순수 교호작용은 주효과에 거의 드러나지 않음),
        // 그보다 깊으면 부모 튜플 중 하나라도 이탈 조합이 있어야 확장
        const gated = k > fullDepth;
        let any = !gated;
        for (let drop = 0; drop < k && !any; drop++) {
          const pq = qs.filter((_, i) => i !== drop);
          if (flaggedTuples[k - 1].has(`${s}|${pq.join(',')}`)) any = true;
        }
        if (!any) {
          searchSpace[k] += countCells(s, qs);
          continue;
        }
        const g = getGroup(s, qs);
        for (let key = 0; key < g.n.length; key++) if (g.n[key] >= minN) searchSpace[k]++;
        for (let key = 0; key < g.n.length; key++) {
          if (g.n[key] < minN) continue;
          const items = decode(g, key);
          let parentFlag = !gated;
          for (let drop = 0; drop < k && !parentFlag; drop++) {
            if (flagged.has(comboKey(s, items.filter((_, i) => i !== drop)))) parentFlag = true;
          }
          if (parentFlag) add(s, items, { n: g.n[key], sum: g.sum[key], ss: g.ss[key] });
        }
      }
    });
  }

  // 3) 조합별 부가 지표
  const unitMean = (s, q, u) => seqInfo[s][q].units[u].mean;
  for (const c of combos) {
    c.p = normSf(c.z);
    c.children = [];
    // 교호작용 잔차 (k=1은 주효과 = 평균 − μ)
    c.resid = c.k === 1 ? c.mean - mu : c.mean - (mu + c.items.reduce((a, [q, u]) => a + (unitMean(c.step, q, u) - mu), 0));
    // 부모 대비 리프트: 조합 vs (부모 − 조합) Welch t, 단측
    c.parents = [];
    if (c.k >= 2) {
      let liftP = 0, liftMin = Infinity;
      for (let drop = 0; drop < c.k; drop++) {
        const pItems = c.items.filter((_, i) => i !== drop);
        const P = statsOf(c.step, pItems);
        const rest = { n: P.n - c.n, sum: P.sum - c.sum, ss: P.ss - c.ss };
        const w = welch(c, rest);
        const restMean = rest.n ? rest.sum / rest.n : NaN;
        c.parents.push({ key: comboKey(c.step, pItems), items: pItems, n: P.n, mean: P.sum / P.n, restN: rest.n, restMean, t: w.t, p: w.p });
        liftP = Math.max(liftP, w.p);
        liftMin = Math.min(liftMin, c.mean - restMean);
      }
      c.liftP = liftP;
      c.lift = liftMin;
    }
  }
  for (const c of combos) {
    for (const pr of c.parents) {
      const P = byKey.get(pr.key);
      if (P) P.children.push(c.id);
    }
  }
  const qv = bhQ(combos.map((c) => c.p));
  combos.forEach((c, i) => (c.q = qv[i]));

  // 4) 경험적 베이즈 수축: k=1(선택 편향 없는 전수 집합)에서 조합 간 분산 τ² 추정
  const d1 = combos.filter((c) => c.k === 1);
  const vbar = d1.reduce((a, c) => a + (sd * sd) / c.n, 0) / d1.length;
  const vm = d1.reduce((a, c) => a + (c.mean - mu) ** 2, 0) / d1.length;
  const tau2 = Math.max(vm - vbar, 1e-12);
  // 대부분 유닛이 정상이면 τ²≈0 → κ가 무한대로 발산해 모든 점이 μ로 붙으므로 상한 300 적용
  const kappaRaw = (sd * sd) / tau2;
  const kappa = Math.min(Math.max(kappaRaw, 5), 300);
  for (const c of combos) c.shrunk = (c.n * c.mean + kappa * mu) / (c.n + kappa);

  const depthCount = [0, 0, 0, 0];
  for (const c of combos) depthCount[c.k]++;

  const result = {
    mu, sd, N, minN, maxDepth, fullDepth, kappa, kappaRaw, tau2,
    steps, seqInfo, stepN, combos, byKey, depthCount, searchSpace,
    rawOver: combos.filter((c) => c.z > Z998).length,
    comboKey,
  };
  return result;
}

// 깊이별 envelope z 임계값
export function thresholds(res, method, permZ) {
  const z = [0];
  for (let k = 1; k <= res.maxDepth; k++) {
    if (method === 'raw') z[k] = Z998;
    else if (method === 'perm' && permZ && permZ[k]) z[k] = permZ[k];
    else z[k] = res.searchSpace[k] ? normInv(1 - FWER_ALPHA / res.searchSpace[k]) : Z998;
  }
  return z;
}

// 상태 판정: normal / warn / bad / inherited(상속) / explained(하위 기인)
export function classify(res, zk) {
  const { combos, mu, sd } = res;
  for (const c of combos) {
    c.over = c.z > zk[c.k];
    c.explainedBy = null;
    if (!c.over) c.status = c.z > Z95 ? 'warn' : 'normal';
    else if (c.k === 1) c.status = 'bad';
    else c.status = c.liftP < LIFT_ALPHA ? 'bad' : 'inherited';
  }
  // 이탈의 원인이 하위(더 깊은) 조합에 있으면: 그 조합을 뺀 나머지가 envelope 안이면 "하위 기인"
  for (let k = res.maxDepth - 1; k >= 1; k--) {
    for (const c of combos) {
      if (c.k !== k || c.status !== 'bad') continue;
      for (const id of c.children) {
        const ch = combos[id];
        if (ch.status !== 'bad' && ch.status !== 'explained') continue;
        const rn = c.n - ch.n;
        if (rn < 2) continue;
        const rz = ((c.sum - ch.sum) / rn - mu) / (sd / Math.sqrt(rn));
        if (rz <= zk[k]) {
          c.status = 'explained';
          c.explainedBy = ch.id;
          break;
        }
      }
    }
  }
  const count = (st) => combos.filter((c) => c.status === st).length;
  return {
    over: combos.filter((c) => c.over).length,
    bad: count('bad'),
    inherited: count('inherited'),
    explained: count('explained'),
    warn: count('warn'),
  };
}

// 확정 불량 조합을 공정 순서대로 이은 PATH
export function defectPath(res) {
  return res.combos.filter((c) => c.status === 'bad').sort((a, b) => a.step - b.step || b.z - a.z);
}

// 순열 검정용 조합 멤버(웨이퍼 인덱스) 펼치기
export function buildMembers(data, combos) {
  // 같은 (스텝, 순서 튜플)의 조합끼리 묶어 웨이퍼를 한 번만 순회
  const lists = combos.map(() => []);
  const byTuple = new Map();
  combos.forEach((c, i) => {
    const tk = `${c.step}|${c.items.map((it) => it[0]).join(',')}`;
    if (!byTuple.has(tk)) byTuple.set(tk, { step: c.step, qs: c.items.map((it) => it[0]), cells: new Map() });
    const dims = c.items.map(([q]) => data.steps[c.step].seqs[q].units.length);
    let key = 0;
    c.items.forEach(([, u], j) => (key = key * dims[j] + u));
    byTuple.get(tk).cells.set(key, i);
  });
  for (const { step, qs, cells } of byTuple.values()) {
    const arrs = qs.map((q) => data.assign[step][q]);
    const dims = qs.map((q) => data.steps[step].seqs[q].units.length);
    outer: for (let w = 0; w < data.N; w++) {
      let key = 0;
      for (let i = 0; i < arrs.length; i++) {
        const v = arrs[i][w];
        if (v === MISSING) continue outer;
        key = key * dims[i] + v;
      }
      const ci = cells.get(key);
      if (ci !== undefined) lists[ci].push(w);
    }
  }
  const offsets = new Int32Array(combos.length + 1);
  lists.forEach((l, i) => (offsets[i + 1] = offsets[i] + l.length));
  const members = new Int32Array(offsets[combos.length]);
  lists.forEach((l, i) => members.set(l, offsets[i]));
  const depth = Uint8Array.from(combos.map((c) => c.k));
  return { members, offsets, depth };
}

// 주입한 정답과 대조
export function truthCheck(data, res) {
  return data.effects.map((e) => {
    const items = e.items.slice().sort((a, b) => a[0] - b[0]);
    const key = res.comboKey(e.step, items);
    const c = res.byKey.get(key);
    return { effect: e, combo: c || null, status: c ? c.status : 'missing' };
  });
}

// 표시용 라벨
export function comboLabel(steps, c) {
  const st = steps[c.step];
  return c.items.map(([q, u]) => `${st.seqs[q].name}:${st.seqs[q].units[u]}`).join(' × ');
}
