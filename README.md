# 공정 조합 퍼널 (웹)

설비 이력(`raw.csv`)에서 bad를 끌어올린 설비 · 챔버 경로(조합)를 찾아, funnel 차트와 혐의 대상 순위표로 보여 주는 웹 화면입니다. 사내 서버에 띄우고 브라우저로 접속해 씁니다(기본 포트 3004, 로그인 없음).

판정 계산은 `main` 브랜치의 `notebooks/real_data_funnel.ipynb`(커밋 `699e381`)와 같은 결과를 냅니다. 같은 raw.csv와 같은 설정이면 조합, z, 기준선, 판정, 혐의 대상 순위가 모두 같습니다.

## 구성

| 경로 | 내용 |
|---|---|
| `combi/` | 계산 엔진: CSV 읽기 · Value 치우침과 part 맞춤 · 조합 판정 · 혐의 대상 순위 · 화면에 보낼 값 |
| `web/app.py` | 웹 서버: 파일 올리기 · 실행(백그라운드) · 결과 · 상세 API |
| `web/static/` | 화면 (HTML · CSS · JS, 외부 라이브러리나 인터넷 연결 없이 동작) |
| `requirements.txt` | 설치할 패키지 (버전 고정) |
| `demo_raw.csv` | 시험용 가상 데이터 |

## 실행 가이드 (RHEL 9 · Python 3.12)

### 1. 코드 받기

git이 있으면:

```bash
git clone -b funnel-web --single-branch https://github.com/mikebbang/edu_claude.git funnel-web
```

서버가 GitHub에 접속할 수 없으면(폐쇄망) PC에서 아래 ZIP을 받아 서버로 옮긴 뒤 풉니다.

```bash
unzip edu_claude-funnel-web.zip && mv edu_claude-funnel-web funnel-web
```

ZIP 주소: `https://github.com/mikebbang/edu_claude/archive/refs/heads/funnel-web.zip`

### 2. 가상환경(venv) 만들고 패키지 설치

```bash
cd funnel-web
python3.12 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt
```

- `python3.12`가 없다는 오류가 나면 `python3 --version`으로 3.12인지 확인하고 `python3 -m venv .venv`를 씁니다.
- 사내 PyPI 미러를 쓰는 서버라면 평소 pip 설정 그대로 설치됩니다.

### 3. 서버 실행

```bash
python -m web
```

`Uvicorn running on http://0.0.0.0:3004`가 나오면 브라우저에서 `http://<서버 주소>:3004`로 접속합니다. 끄려면 `Ctrl+C`를 누릅니다.

### 4. 터미널을 닫아도 계속 띄우기

```bash
nohup .venv/bin/python -m web > web.log 2>&1 &
```

- 끌 때: `pkill -f "python -m web"`
- 로그 보기: `tail -f web.log`

서버가 다시 켜질 때 자동으로 띄우려면 systemd 서비스로 등록합니다(관리자 권한 필요). `/etc/systemd/system/combi-web.service`:

```ini
[Unit]
Description=공정 조합 퍼널 웹
After=network.target

[Service]
User=<실행할 계정>
WorkingDirectory=/<설치 경로>/funnel-web
ExecStart=/<설치 경로>/funnel-web/.venv/bin/python -m web
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now combi-web
```

### 5. 다른 PC에서 접속이 안 되면 (방화벽)

```bash
sudo firewall-cmd --permanent --add-port=3004/tcp
sudo firewall-cmd --reload
```

## 쓰는 법

1. **raw.csv 올리기**를 누르고 파일을 고릅니다. 한 번 올린 파일은 옆 목록에 남아서 설정만 바꿔 다시 돌릴 수 있습니다.
2. `MIN_N`(조합에 필요한 최소 웨이퍼 수), `MAX_DEPTH`(조합에 묶을 최대 Order 수, "제한 없음" 가능)를 정합니다. 평소 바꾸지 않는 설정은 **고급 설정**에 있습니다.
3. **Run**을 누르면 진행 막대가 나옵니다. 판정은 한 번에 하나씩 차례로 돌고, 같은 파일 · 같은 설정은 다시 계산하지 않습니다.
4. **Funnel**(모든 STEP의 조합)과 **Ranking**(혐의 대상 순위표)이 나옵니다.
   - 순위표 행에 마우스를 올리면 funnel에서 그 점이 강조되고, 클릭하면 아래 상세가 그 순위로 바뀝니다. ↑ · ↓ 키로도 움직이고, 열 이름을 누르면 정렬됩니다.
   - funnel의 번호 붙은 빨간 점을 눌러도 그 순위를 고릅니다.
   - 세로축은 **종합 / y_value 평균 / bad 비율** 중에서 고릅니다. 버튼에 마우스를 올리면 각각의 뜻이 그림과 함께 나옵니다. 점 색은 어느 축에서나 판정 기준입니다.
5. **상세**(고른 순위 하나)
   - **Order × Unit**: 그 STEP의 Order와 Unit을 칸으로 보여 줍니다(색 = bad 비율). 선택된 칸을 누르면 그 Order가 빠지고, 다른 Order의 Unit을 누르면 추가되고, 같은 Order의 다른 Unit을 누르면 바뀝니다. 위쪽 칩의 ×로도 뺄 수 있고 **원래 경로로**를 누르면 순위 경로로 돌아갑니다. 원래 경로에서 바뀌면 "탐색 중 (판정 아님)"이 붙습니다.
   - **웨이퍼 산점도**: 가로 = 고른 Order 중 마지막 Order의 tkin_time, 세로 = y_value. **선택 경로 강조**(빨강 vs 회색)와 **조합별 색**(고른 Order들의 Unit 조합마다 색, 많으면 웨이퍼가 많은 순 6개 + 기타) 중에서 고릅니다.
   - **같은 Order 다른 경로 비교**: 점 하나 = 같은 Order들을 지난 경로 하나, 가로 = 웨이퍼 수. 세로축은 funnel과 같은 세 가지에서 고르고, 띠 밖이면 웨이퍼 수를 감안해도 튀는 경로입니다.
   - **이 경로 vs 나머지**: bad 비율 막대와 y_value 상자그림 · 웨이퍼 점.
   - **시간에 따른 bad 추이**: 이 경로와 나머지의 이동 bad 비율.

## 설정 (환경 변수)

| 이름 | 기본값 | 뜻 |
|---|---|---|
| `COMBI_PORT` | `3004` | 포트 |
| `COMBI_HOST` | `0.0.0.0` | 받을 주소 (`127.0.0.1`이면 서버 안에서만 접속) |
| `COMBI_DATA_DIR` | `./data` | 올린 파일을 두는 곳 |
| `COMBI_KEEP_RESULTS` | `3` | 상세 화면용 데이터를 메모리에 남겨 둘 실행 수 |

예: `COMBI_PORT=3005 python -m web`

## 알아 둘 점

- **시간 · 메모리**: 479MB 가상 데이터(웨이퍼 1,130장, Order 3,784개)에서 판정 약 22초, 실행 중 최대 메모리 약 2.5GB였습니다. 300MB raw.csv면 비슷하거나 조금 적게 듭니다. 실행이 끝나면 상세에 필요한 것만 남기고 메모리를 비웁니다.
- **결과 보관**: 결과는 메모리에만 있어 서버를 다시 켜면 사라집니다. 같은 파일을 골라 Run을 다시 누르면 됩니다.
- **올린 파일**: `data/uploads/`에 남습니다. 필요 없으면 지워도 됩니다. `data/`와 `raw.csv`는 git에 올라가지 않습니다(`.gitignore`).
- **데이터 형식**: 노트북과 같습니다. 컬럼 `analysis_date, job_id, root_lot_id, lot_id, wafer_id, tkin_time, line_id, part_id, step_seq, step_desc, eqp_id, chamber_id, ppid, y_value, good_bad, step_ord`가 있어야 합니다.
- **판정 방식**: `main` 브랜치 노트북의 부록 C와 같습니다(5%를 Order 1개 · 2개 · 3개 · 4개 이상 묶음으로 나눈 Bonferroni 기준선, 퍼짐 보정, part별 맞춤, 중복 조합 · 넘을 수 없는 조합 빼기).

## 시험해 보기

`demo_raw.csv`를 올리고 Run을 누르면 1초 안에 혐의 대상 2개가 나옵니다. 1위는 `ex102000`의 `O1:ETC101-A → O3:ETC301-A`입니다.

## 문제 해결

- **3004 포트가 이미 쓰인다는 오류**: `COMBI_PORT=3005 python -m web`처럼 다른 포트로 띄우거나, 떠 있는 서버를 `pkill -f "python -m web"`로 끕니다.
- **화면이 안 바뀜**: 브라우저에서 `Ctrl+F5`로 새로 고칩니다.
- **실행 중 오류**: 화면에 원인이 나옵니다. 컬럼 이름이나 y_value(숫자인지)를 확인하세요. 자세한 내용은 `web.log`에 있습니다.
- **브라우저**: Chrome · Edge 111 이상에서 쓰세요. 개발 중에는 Chromium 기반 브라우저로 확인했습니다.
