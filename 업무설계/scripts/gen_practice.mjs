// 실습용 가상 입력 자료 생성: 불량 wafer 측정값(txt), 설비 진행 이력(csv), FDC 요약(csv)
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makeRng } from '../../js/rng.js';

const OUT = process.argv[2] || fileURLToPath(new URL('../data', import.meta.url));
mkdirSync(OUT, { recursive: true });
const r = makeRng(20260928);
const pad = (n, w = 2) => String(n).padStart(w, '0');

const N_LOT = 40, WPL = 25, N = N_LOT * WPL;
const PROC = ['CLEAN', 'DIFF', 'PHOTO', 'ETCH', 'IMPLANT', 'CLEAN', 'ETCH', 'CVD', 'CMP', 'PHOTO',
  'ETCH', 'IMPLANT', 'DIFF', 'CLEAN', 'CVD', 'CMP', 'PHOTO', 'ETCH', 'PVD', 'CLEAN'];
const PREFIX = { CLEAN: 'CLN', DIFF: 'DIF', PHOTO: 'PHO', ETCH: 'ETC', IMPLANT: 'IMP', CVD: 'CVD', CMP: 'CMP', PVD: 'PVD' };
const PARAMS = {
  CLEAN: [['Chem_Temp', 65, 0.4, 1], ['Megasonic_Power', 300, 4, 0], ['Rinse_Resistivity', 17.8, 0.1, 2]],
  DIFF: [['Furnace_Temp', 1000, 0.8, 1], ['O2_Flow', 5000, 25, 0], ['Process_Time', 3600, 10, 0]],
  PHOTO: [['Dose', 32, 0.25, 2], ['Focus_Offset', 0, 8, 1], ['Stage_Temp', 23, 0.02, 3]],
  ETCH: [['RF_Reflected', 12, 1.5, 1], ['Chamber_Pressure', 30, 0.3, 2], ['Endpoint_Time', 45, 1.5, 1]],
  IMPLANT: [['Beam_Current', 5, 0.08, 3], ['Vacuum', 2.0, 0.1, 2], ['Dose_Uniformity', 0.8, 0.08, 3]],
  CVD: [['Chamber_Pressure', 2.0, 0.03, 3], ['Heater_Temp', 400, 0.8, 1], ['Dep_Time', 120, 1.2, 1]],
  CMP: [['Down_Force', 3.0, 0.04, 3], ['Platen_Speed', 93, 0.6, 1], ['Slurry_Flow', 200, 2, 1]],
  PVD: [['DC_Power', 20, 0.15, 2], ['Ar_Flow', 50, 0.6, 1], ['Chamber_Pressure', 3.0, 0.05, 3]],
};

function unitCount() {
  const x = r.u();
  if (x < 0.3) return 1;
  if (x < 0.7) return r.int(2, 4);
  if (x < 0.9) return r.int(5, 8);
  return r.int(9, 12);
}

// 스텝 구조 (오더 수는 스텝마다 랜덤, 상한 없음)
const PAIR_STEP = 6, SINGLE_STEP = 14; // S07_ETCH, S15_CVD
const steps = PROC.map((proc, s) => {
  let nOrd = 1 + r.geometric(0.3);
  if (s === 11) nOrd = 11; // 오더가 많은 스텝 하나
  if (s === PAIR_STEP) nOrd = 5;
  if (s === SINGLE_STEP) nOrd = 3;
  const counts = Array.from({ length: nOrd }, () => unitCount());
  if (s === PAIR_STEP) { counts[1] = 4; counts[3] = 5; }
  if (s === SINGLE_STEP) { counts[2] = 4; counts[0] = Math.max(2, counts[0]); }
  let next = r.int(1, 20); // 스텝 안에서 유닛 이름이 겹치지 않게 번호를 이어서 부여
  const orders = counts.map((c, o) => {
    const base = next;
    next += c + r.int(1, 6);
    const units = Array.from({ length: c }, (_, j) => `${PREFIX[proc]}${pad(base + j)}`);
    const cum = []; let acc = 0;
    for (let j = 0; j < c; j++) { acc += 0.7 + 0.6 * r.u(); cum.push(acc); }
    // 유닛별 FDC 매칭 오프셋
    const off = units.map(() => PARAMS[proc].map(([, , sd]) => r.normal() * sd * 0.4));
    return { name: `O${o + 1}`, units, cum, off };
  });
  return { name: `S${pad(s + 1)}_${proc}`, proc, orders };
});

// 주입 불량
const pairA = { order: 1, unit: 2 }; // S07 O2 3번째 유닛
const pairB = { order: 3, unit: 1 }; // S07 O4 2번째 유닛
const single = { order: 2, unit: 3 }; // S15 O3 4번째 유닛
const DRIFT_FROM = Date.parse('2026-09-08T00:00:00+09:00');

const START = Date.parse('2026-08-20T06:00:00+09:00');
const H = 3600e3, M = 60e3;
const fmtT = (t) => {
  const d = new Date(t + 9 * H);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
};

const hist = ['lot,wafer,step,order,unit,track_in'];
const fdc = ['lot,wafer,step,unit,parameter,mean,max,track_in'];
const meas = ['lot\twafer\tvalue'];
const truthUnits = {};

for (let l = 0; l < N_LOT; l++) {
  const lot = `L${pad(l + 1, 4)}`;
  const lotStart = START + l * 18 * H + r.int(0, 120) * M;
  for (let w = 0; w < WPL; w++) {
    const wf = pad(w + 1);
    let y = 2.0 + 0.45 * r.normal();
    const path = {};
    steps.forEach((st, s) => {
      st.orders.forEach((od, o) => {
        const u = r.weighted(od.cum);
        path[`${s}:${o}`] = u;
        const t = lotStart + s * 7 * H + o * 25 * M + w * 2 * M;
        hist.push(`${lot},${wf},${st.name},${od.name},${od.units[u]},${fmtT(t)}`);
        PARAMS[st.proc].forEach(([pn, base, sd, dec], pi) => {
          let mean = base + od.off[u][pi] + r.normal() * sd;
          let mx = mean + sd * (1 + Math.abs(r.normal()) * 1.5);
          // S07: O2 특정 유닛을 거친 뒤 O4 특정 유닛에서 식각 종료 시간이 길어짐
          if (s === PAIR_STEP && o === pairB.order && u === pairB.unit && path[`${s}:${pairA.order}`] === pairA.unit) {
            if (pn === 'Endpoint_Time') { mean += 6; mx += 7; }
            if (pn === 'RF_Reflected') { mean += 3; mx += 8; }
          }
          // S15: 특정 CVD 유닛의 챔버 압력이 9/8 이후 상승
          if (s === SINGLE_STEP && o === single.order && u === single.unit && t >= DRIFT_FROM && pn === 'Chamber_Pressure') {
            mean += 0.12; mx += 0.15;
          }
          fdc.push(`${lot},${wf},${st.name},${od.units[u]},${pn},${mean.toFixed(dec)},${mx.toFixed(dec)},${fmtT(t)}`);
        });
      });
    });
    if (path[`${PAIR_STEP}:${pairA.order}`] === pairA.unit && path[`${PAIR_STEP}:${pairB.order}`] === pairB.unit) y += 0.9;
    const tSingle = lotStart + SINGLE_STEP * 7 * H + single.order * 25 * M + w * 2 * M;
    if (path[`${SINGLE_STEP}:${single.order}`] === single.unit && tSingle >= DRIFT_FROM) y += 0.5;
    meas.push(`${lot}\t${wf}\t${Math.max(0, y).toFixed(2)}`);
  }
}

writeFileSync(`${OUT}/불량wafer_측정값.txt`, meas.join('\n') + '\n');
writeFileSync(`${OUT}/설비진행이력.csv`, hist.join('\n') + '\n');
writeFileSync(`${OUT}/FDC요약.csv`, fdc.join('\n') + '\n');

const s7 = steps[PAIR_STEP], s15 = steps[SINGLE_STEP];
console.log('orders per step', steps.map((s) => s.orders.length).join(','));
console.log('pair:', s7.name, s7.orders[pairA.order].name, s7.orders[pairA.order].units[pairA.unit], '×', s7.orders[pairB.order].name, s7.orders[pairB.order].units[pairB.unit]);
console.log('single:', s15.name, s15.orders[single.order].name, s15.orders[single.order].units[single.unit], 'from 2026-09-08');
console.log('rows', meas.length - 1, hist.length - 1, fdc.length - 1);
