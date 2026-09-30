# 공정 조합 퍼널

한 스텝 안에서 오더별 유닛 조합을 거친 웨이퍼의 평균 불량률을 funnel plot으로 보고, 우연이나 다른 유닛 탓으로 설명되는 조합을 걸러 진짜 불량 조합만 남기는 분석 화면입니다. 데이터는 mock입니다.

## 실행

ES modules를 쓰므로 로컬 서버로 엽니다.

```bash
python -m http.server 8765
# http://localhost:8765
```

## 구성

| 파일 | 역할 |
|---|---|
| `js/mock.js` | 스텝 100개, 웨이퍼 5,000장, 오더·유닛 구조와 Y 생성 (불량 4건 주입) |
| `js/analysis.js` | 오더별 유닛 ANOVA, 스텝 내 조합 생성, 깊이별 다중비교 envelope, 리프트·하위 기인 판정 |
| `js/stats.js` | 정규/F/t 분포, ANOVA, Welch t, BH-FDR |
| `js/permWorker.js` | 순열(max-T) envelope 계산 Web Worker |
| `js/app.js` | Funnel 차트, 불량 조합 목록, 상단 설정 |
| `js/detail.js` | 선택한 조합의 스텝 상세 차트 (흐름도, 분포, 무작위 비교, 유닛 신뢰구간, 히트맵, 시간 추이) |
| `notebooks/funnel_check.ipynb` | 위 로직과 차트를 Python 3.12로 옮긴 점검 노트북 (JS 대조, 여러 시드, 약점 실험, good/bad 분석 방식 비교) |
| `notebooks/js_reference.mjs` | 노트북 대조용으로 같은 시드의 JS 분석 결과를 JSON으로 출력 |
| `notebooks/real_data_funnel.ipynb` | 실제 설비 이력 CSV(`raw.csv`)에 같은 판정을 적용해 대표 불량 대상 랭킹과 차트를 보는 노트북 |
| `notebooks/fonts/` | 노트북 차트용 한글 글꼴(나눔고딕, SIL Open Font License 1.1 · `OFL.txt`) |
| `demo_raw.csv` | 실제 데이터 노트북용 가상 demo 데이터. demo로 실행하려면 `raw.csv`로 복사 |

## 노트북으로 점검

웹과 같은 로직을 Python 3.12로 옮긴 노트북입니다. 난수까지 같게 옮겨서 같은 시드면 웹과 같은 데이터와 판정이 나오고, 7절에서 JS 결과와 직접 대조합니다(Node.js 필요). 실행 결과가 저장되어 있어 열기만 해도 차트를 볼 수 있습니다.

```bash
python3.12 -m venv .venv
.venv/bin/pip install -r notebooks/requirements.txt
```

VS Code나 Jupyter에서 `notebooks/funnel_check.ipynb`를 열고 커널로 `.venv`(Python 3.12)를 고릅니다. 0절의 설정(시드, 최소 웨이퍼 수, 기준 등)만 바꿔서 다시 실행하면 됩니다.

## 실제 데이터 분석

`notebooks/real_data_funnel.ipynb`는 저장소 최상위(`unit_combi` 폴더)의 `raw.csv` 하나만 읽어 같은 판정을 돌립니다. 실제 데이터를 `raw.csv`라는 이름으로 두고 위에서부터 실행하면 됩니다. 결과는 한 장 funnel → 혐의 대상 표(초과 bad · 확실도) → 1위 자세히 → 경계선 비교 순서로 나오고, 데이터 점검 · 계산값 · 판정 방식 설명은 노트북 맨 아래 부록에 있습니다.

- 저장소에는 가상 demo 데이터 `demo_raw.csv`(STEP 20개, 웨이퍼 1,000장 중 good_bad N 30장, 불량 2개, `step_seq`는 `ex100100_1`처럼 STEP 번호 + `_Order 번호`)만 있습니다. demo로 확인하려면 `raw.csv`로 복사해서 실행합니다.
- `raw.csv`는 저장소에 없고 `.gitignore`로도 빠지므로, 새 버전을 ZIP으로 받아 덮어 풀어도 실제 데이터가 바뀌지 않고 커밋될 일도 없습니다.

- 필요한 컬럼: `analysis_date, job_id, root_lot_id, lot_id, wafer_id, tkin_time, line_id, part_id, step_seq, step_desc, eqp_id, chamber_id, ppid, y_value, good_bad, step_ord` (`raw.csv` 하나에 job 하나. `analysis_date, job_id, lot_id, ppid`는 읽지 않음)
- `y_value`는 모든 웨이퍼에 있어야 합니다. `good_bad`는 `G` · `B` · `N`이고, N인 웨이퍼는 계산에서 빼고 차트(4절 Value 분포의 빈 원, 부록 A)에만 표시합니다.
- 웨이퍼 = `root_lot_id` + `wafer_id`, 유닛 = `eqp_id-chamber_id`, Value = `y_value`
- STEP = `step_seq`에서 끝의 `_번호`를 뗀 값, Order = 그 번호. 예: `ex100000_1` ~ `ex100000_6` → STEP `ex100000` 안의 Order 1~6. 끝 번호가 없는 `step_seq`는 그대로 STEP으로 보고 `step_ord`를 Order로 씁니다. 여러 part를 함께 분석합니다.
- Value 분포 모양(한쪽으로 길게 치우치면 순위 점수로 분석)과 part별 수준 차이를 자동으로 점검하고, 필요하면 보정합니다.
- 판정 기준은 하나입니다. 웨이퍼(`root_lot_id` + `wafer_id`) 한 장을 하나의 표본으로 보고, 조합마다 나머지 웨이퍼와 비교한 Value 차이의 z와 bad 비율(`good_bad`) 차이의 z를 구해 결합 z = (z_Value + z_bad) ÷ √(2 + 2r)로 합친 뒤, Order 수별 조합 수로 보정한 기준 z와 비교합니다. r은 두 z가 우연히 같이 움직이는 정도라 같은 정보를 두 번 세지 않게 합니다. bad 비율 z는 정확한 이항 꼬리확률로 맞춥니다.
- 전체 평균에는 조합의 웨이퍼도 들어 있어서, 그대로 비교하면 큰 조합일수록 차이가 작게 나옵니다. 그래서 z를 √(1 − 조합 웨이퍼 수 ÷ 전체 웨이퍼 수)로 나눕니다(예: 전체 1,130장 중 400장인 조합은 1.24배). funnel 기준선도 같은 비율로 좁아집니다.
- 대표 불량 대상은 **초과 bad 웨이퍼 수**(웨이퍼 × (bad 비율 − 전체 bad 비율)), 즉 고치면 줄어드는 bad 웨이퍼가 많은 순으로 랭킹합니다.
- 조합에 묶을 최대 Order 수는 `MAX_DEPTH`(기본 3)로 바꿉니다. Order를 많이 묶을수록 계산이 늘고 기준 z도 올라갑니다.
- 6절은 같은 조합에 경계선 두 가지를 따로 그려 비교합니다. 둘 다 μ ± 배수 × σ/√N이고 배수를 정하는 M만 다릅니다: 지금 판정의 Bonferroni(M = 같은 Order 수의 전체 조합 수)와 √(2 ln M_N)(M_N = 같은 웨이퍼 수 N에 찍힌 점 수). 비교를 위해 두 차트 모두 Value z만 씁니다.
- 웨이퍼가 거의 같은 혐의 대상(예: 하위 스텝 여러 개를 같은 챔버에서 진행)은 데이터로 구분할 수 없어 랭킹에서 한 줄로 묶습니다.
- 한글 글꼴은 `notebooks/fonts`의 나눔고딕을 자동으로 씁니다. 노트북을 다른 곳으로 옮길 때는 이 폴더도 노트북 옆에 함께 두세요.

## 판정 기준

1. 조합 크기(오더 수)별 탐색 공간 크기로 Bonferroni 보정한 envelope를 넘어야 합니다.
2. 오더 하나를 뺀 경로의 나머지 웨이퍼와 비교해도(Welch t) 같은 보정 기준 z를 넘어야 합니다 (아니면 상속). 기준을 넘은 조합은 평균이 높게 뽑힌 쪽이라, 예전 규칙인 고정 유의수준(p < 0.001)으로는 진짜 불량의 효과를 물려받은 조합이 자주 통과했습니다.
3. 더 작은 불량 조합의 웨이퍼를 빼도 여전히 높아야 합니다 (아니면 하위 기인).

## 한계

웹 화면, `funnel_check.ipynb`, 실제 데이터 노트북 모두 웨이퍼를 서로 독립인 표본으로 봅니다. 같은 랏 웨이퍼가 한 설비를 통째로 지나고 랏마다 값 수준이 크게 다르면, 랏 몇 개의 우연이 설비 차이처럼 보여 기준선 밖 조합이 늘 수 있습니다. 혐의 대상의 웨이퍼가 소수의 랏에 몰려 있지 않은지(CSV의 `랏 수`) 함께 확인하세요.
