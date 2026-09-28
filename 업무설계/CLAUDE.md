# 불량 조합 · FDC 분석 Agent 팀

## WHY
- 붙여넣은 lot·wafer·value·good/bad로 스텝 안의 order·unit 불량 조합을 찾고, FDC 유의차로 원인 가설을 정리해 보고한다.

## WHAT
- 입력: `data/` (불량wafer_측정값.txt, 설비진행이력.csv, FDC요약.csv)
- 코드: `node scripts/run_analysis.mjs` (Task 2~4) → `output/analysis.json`, `output/fdc/조합ID.json`
- Sub Agent: `fdc-interpreter` (조합별 FDC 해석) · `report-writer` (보고서 작성) · `report-reviewer` (보고서 검토)
- 결과물: `output/report.html` (기준 샘플 `reference/example.html`) · 설계 문서 `업무설계서.md`, `workflow.md`

## HOW
- 코드 실행 → `analysis.json`의 `router` 확인 → `fdc`면 불량 조합마다 `fdc-interpreter`를 병렬 실행 → `report-writer` → `report-reviewer`
- `report_only`(불량 조합 0건)면 해석을 건너뛰고 `report-writer`로 간다.
- 검토 FAIL: 가설·수치 불일치는 해당 조합의 `fdc-interpreter`, 구성·표현 문제는 `report-writer`가 수정한다. 수정은 최대 1회, 재검토도 FAIL이면 사람에게 넘긴다.
- 원인 확정과 조치 결정은 사람이 한다.
- 공통 규칙: @.claude/rules/report-rule.md
