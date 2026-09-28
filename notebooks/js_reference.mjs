// 노트북(funnel_check.ipynb) 대조용: main의 JS 분석을 같은 시드로 실행해 결과를 JSON으로 출력한다.
// 실행: node notebooks/js_reference.mjs [seed] [minN] [nPerm]

import { generate } from '../js/mock.js';
import { analyze, thresholds, classify, buildMembers, FWER_ALPHA } from '../js/analysis.js';

const [seed = 20260928, minN = 20, nPerm = 0] = process.argv.slice(2).map(Number);
const data = generate(seed);
const res = analyze(data, { minN });

// permWorker.js는 Web Worker 코드라 self를 흉내 내서 같은 코드를 그대로 실행한다
async function permZ() {
  const { members, offsets, depth } = buildMembers(data, res.combos);
  let z = null;
  const shim = { postMessage: (m) => { if (m.type === 'done') z = m.z; } };
  Object.defineProperty(globalThis, 'self', { value: shim, configurable: true, writable: true });
  await import('../js/permWorker.js');
  self.onmessage({
    data: { Y: Float64Array.from(data.Y), members, offsets, depth, nPerm, alpha: FWER_ALPHA, seed: seed ^ 0x9e3779b9, maxDepth: res.maxDepth },
  });
  return z;
}
const pz = nPerm > 0 ? await permZ() : null;

const envs = {};
for (const env of ['bonf', 'raw', ...(pz ? ['perm'] : [])]) {
  const zk = thresholds(res, env, pz);
  const summary = classify(res, zk);
  envs[env] = { zk, summary, status: res.combos.map((c) => c.status) };
}

process.stdout.write(JSON.stringify({
  seed, minN, nPerm,
  Y: Array.from(data.Y),
  mu: res.mu, sd: res.sd, kappa: res.kappa, kappaRaw: res.kappaRaw,
  searchSpace: res.searchSpace, depthCount: res.depthCount, rawOver: res.rawOver,
  permZ: pz, envs,
  combos: res.combos.map((c) => [c.key, c.n, c.z, c.liftP ?? null, c.q, c.shrunk, c.resid]),
}));
