// Mock 공정 데이터 생성
// - 100개 필수 스텝, 스텝마다 순서 수는 상한 없는 기하분포, 순서마다 유닛 수는 1~14
// - 웨이퍼 5,000장(200랏 × 25매), 웨이퍼당 Y 하나
// - 소수의 진짜 불량(교호작용 2건, 단일 유닛 1건, 3순서 교호작용 1건)을 주입

import { makeRng } from './rng.js';

export const MISSING = 0xffff;

const PROC = ['PHO', 'ETC', 'CVD', 'PVD', 'CMP', 'IMP', 'DIF', 'CLN', 'MET', 'RTP'];
const pad = (n, w = 2) => String(n).padStart(w, '0');

export const DEFAULTS = {
  nSteps: 100,
  nLots: 200,
  waferPerLot: 25,
  mu: 2.0, // 기본 불량률(%)
  sigma: 0.5,
  missingRate: 0.015, // 스텝별 이력 결측(재작업·스크랩)
  seqGeomP: 0.3, // 순서 수 = 1 + Geom(p) → 평균 약 3.3, 긴 꼬리
  nDecoy: 3, // 순서·유닛이 매우 많은 스텝(소표본 조합 대량 생성)
  effects: { pair: 0.25, single: 0.15, triple: 0.45 },
};

function sampleUnitCount(r) {
  const x = r.u();
  if (x < 0.3) return 1;
  if (x < 0.7) return r.int(2, 4);
  if (x < 0.9) return r.int(5, 9);
  return r.int(10, 14);
}

function buildSeq(r, proc, q, nUnits) {
  const base = r.int(1, 60);
  const units = Array.from({ length: nUnits }, (_, j) => `${proc}${pad(base + j)}`);
  // 유닛별 배정 비율: 거의 균등, 0.7~1.3배로 흔듦
  const cum = [];
  let acc = 0;
  for (let j = 0; j < nUnits; j++) {
    acc += 0.7 + 0.6 * r.u();
    cum.push(acc);
  }
  return { name: `O${q + 1}`, units, cum };
}

export function generate(seed = 20260928, options = {}) {
  const cfg = { ...DEFAULTS, ...options, effects: { ...DEFAULTS.effects, ...(options.effects || {}) } };
  const r = makeRng(seed);
  const N = cfg.nLots * cfg.waferPerLot;

  // 특수 스텝 배정: 함정(decoy) + 주입 스텝 4개
  const order = r.shuffle(Array.from({ length: cfg.nSteps }, (_, i) => i));
  const decoy = new Set(order.slice(0, cfg.nDecoy));
  const [pairA, pairB, single, triple] = order.slice(cfg.nDecoy, cfg.nDecoy + 4);

  // 스텝 구조
  const steps = [];
  const plan = {}; // 주입 스텝의 순서 인덱스
  for (let s = 0; s < cfg.nSteps; s++) {
    const proc = r.pick(PROC);
    let nSeq = 1 + r.geometric(cfg.seqGeomP);
    let counts;
    if (decoy.has(s)) {
      nSeq = r.int(12, 18);
      counts = Array.from({ length: nSeq }, () => (r.u() < 0.5 ? r.int(10, 14) : sampleUnitCount(r)));
    } else {
      if (s === pairA || s === pairB || s === single) nSeq = Math.max(nSeq, 2);
      if (s === triple) nSeq = Math.max(nSeq, 3);
      counts = Array.from({ length: nSeq }, () => sampleUnitCount(r));
    }

    // 주입 스텝은 탐지 가능한 구조로 보정
    const seqIdx = r.shuffle(Array.from({ length: nSeq }, (_, i) => i));
    if (s === pairA || s === pairB) {
      counts[seqIdx[0]] = r.int(3, 5);
      counts[seqIdx[1]] = r.int(3, 5);
      plan[s] = seqIdx.slice(0, 2);
    } else if (s === single) {
      counts[seqIdx[0]] = r.int(3, 5);
      counts[seqIdx[1]] = Math.max(2, Math.min(counts[seqIdx[1]], 4));
      plan[s] = seqIdx.slice(0, 1);
    } else if (s === triple) {
      counts[seqIdx[0]] = r.int(3, 4);
      counts[seqIdx[1]] = r.int(3, 4);
      counts[seqIdx[2]] = r.int(2, 3);
      plan[s] = seqIdx.slice(0, 3);
    }

    const seqs = counts.map((c, q) => buildSeq(r, proc, q, c));
    steps.push({ index: s, name: `STEP${pad(s + 1, 3)}`, proc, seqs, decoy: decoy.has(s) });
  }

  // 웨이퍼별 유닛 배정: assign[s][q][w] = 유닛 인덱스 (결측은 MISSING)
  const assign = steps.map((step) => {
    const arrs = step.seqs.map(() => new Uint16Array(N));
    for (let w = 0; w < N; w++) {
      const miss = r.u() < cfg.missingRate;
      for (let q = 0; q < step.seqs.length; q++) {
        arrs[q][w] = miss ? MISSING : r.weighted(step.seqs[q].cum);
      }
    }
    return arrs;
  });

  // 주입 효과
  const effects = [];
  const mk = (type, s, delta) => {
    const items = plan[s].map((q) => [q, r.int(0, steps[s].seqs[q].units.length - 1)]);
    effects.push({ type, step: s, items, delta });
  };
  mk('pair', pairA, cfg.effects.pair);
  mk('pair', pairB, cfg.effects.pair);
  mk('single', single, cfg.effects.single);
  mk('triple', triple, cfg.effects.triple);

  // Y 생성
  const Y = new Float64Array(N);
  for (let w = 0; w < N; w++) {
    let y = cfg.mu + cfg.sigma * r.normal();
    for (const e of effects) {
      const a = assign[e.step];
      if (e.items.every(([q, u]) => a[q][w] === u)) y += e.delta;
    }
    Y[w] = Math.max(0, y);
  }

  const waferId = (w) => `L${pad(Math.floor(w / cfg.waferPerLot) + 1, 4)}-W${pad((w % cfg.waferPerLot) + 1)}`;

  return { seed, cfg, N, Y, steps, assign, effects, waferId };
}
