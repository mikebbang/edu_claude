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

`notebooks/real_data_funnel.ipynb`는 저장소 최상위(`unit_combi` 폴더)의 `raw.csv` 하나만 읽어 같은 판정을 돌립니다. 실제 데이터를 `raw.csv`라는 이름으로 두고 위에서부터 실행하면 됩니다.

- 저장소에는 가상 demo 데이터 `demo_raw.csv`(스텝 20개, 웨이퍼 1,000장, 불량 2개, `step_seq`는 `ex100100_1`처럼 스텝 번호 + `_오더`)만 있습니다. demo로 확인하려면 `raw.csv`로 복사해서 실행합니다.
- `raw.csv`는 저장소에 없고 `.gitignore`로도 빠지므로, 새 버전을 ZIP으로 받아 덮어 풀어도 실제 데이터가 바뀌지 않고 커밋될 일도 없습니다.

- 필요한 컬럼: `analysis_date, job_id, root_lot_id, lot_id, wafer_id, tkin_time, line_id, part_id, step_seq, step_desc, eqp_id, chamber_id, ppid, y_value, good_bad, step_ord`
- 웨이퍼 = `root_lot_id` + `wafer_id`, 유닛 = `eqp_id-chamber_id`
- 스텝 = `step_seq`에서 끝의 `_번호`를 뗀 값, 오더 = 그 번호. 예: `ex100000_1` ~ `ex100000_6` → 스텝 `ex100000` 안의 오더 1~6. 끝 번호가 없는 `step_seq`는 그대로 스텝으로 보고 `step_ord`를 오더로 씁니다. 여러 part를 함께 분석합니다.
- `y_value` 분포 모양(한쪽으로 길게 치우치면 순위 점수로 분석)과 part별 수준 차이를 자동으로 점검하고, 필요하면 보정합니다.
- 판정 기준은 하나입니다. 조합마다 y_value 차이의 z와 bad 비율(`good_bad`) 차이의 z를 각각 **랏 랜덤 효과 모형**으로 구해 결합 z = (z_y + z_bad) ÷ √(2 + 2r)로 합치고, 오더 수별 조합 수로 보정한 기준 z와 비교합니다. 한 랏의 웨이퍼가 챔버끼리 나뉘면 같은 랏 안에서 비교해 랏 차이가 상쇄되고, 랏이 통째로 지난 설비는 랏 단위로만 비교합니다. r은 두 z가 우연히 같이 움직이는 정도라 같은 정보를 두 번 세지 않게 합니다.
- 대표 불량 대상은 **초과 bad 웨이퍼 수**(웨이퍼 × (bad 비율 − 전체 bad 비율)), 즉 고치면 줄어드는 bad 웨이퍼가 많은 순으로 랭킹합니다.
- 조합에 묶을 최대 오더 수는 `MAX_DEPTH`(기본 3)로 바꿉니다. 오더를 많이 묶을수록 계산이 늘고 기준 z도 올라갑니다.
- 웨이퍼가 거의 같은 대표 대상(예: 하위 스텝 여러 개를 같은 챔버에서 진행)은 데이터로 구분할 수 없어 랭킹에서 한 줄로 묶습니다.
- 한글 글꼴은 `notebooks/fonts`의 나눔고딕을 자동으로 씁니다. 노트북을 다른 곳으로 옮길 때는 이 폴더도 노트북 옆에 함께 두세요.

## 판정 기준

1. 조합 크기(오더 수)별 탐색 공간 크기로 Bonferroni 보정한 envelope를 넘어야 합니다.
2. 오더 하나를 뺀 경로의 나머지 웨이퍼와 비교해도(Welch t) 같은 보정 기준 z를 넘어야 합니다 (아니면 상속). 기준을 넘은 조합은 평균이 높게 뽑힌 쪽이라, 예전 규칙인 고정 유의수준(p < 0.001)으로는 진짜 불량의 효과를 물려받은 조합이 자주 통과했습니다.
3. 더 작은 불량 조합의 웨이퍼를 빼도 여전히 높아야 합니다 (아니면 하위 기인).

## 한계

웹 화면과 `funnel_check.ipynb`의 mock은 웨이퍼끼리 독립이고 유닛이 웨이퍼마다 배정된다고 가정합니다. 실제 데이터처럼 랏 단위 배정이나 랏 간 편차가 있으면 오탐이 크게 늘어나므로, 실제 데이터 노트북은 랏 랜덤 효과 모형으로 판정합니다.
