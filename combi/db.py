"""DB에서 job_id 한 건의 설비 이력을 읽어 raw.csv로 저장한다 (예전에 노트북에서 raw.csv를 만들던 방식 그대로).
접속 정보는 코드에 두지 않고 환경 변수 COMBI_DB_URL에서 읽는다 (서버의 .env 파일 · git에 올리지 않음)"""
import os
import re
from pathlib import Path

DB_COLUMNS = ['analysis_date', 'job_id', 'root_lot_id', 'lot_id', 'wafer_id', 'tkin_time', 'line_id', 'part_id',
              'step_seq', 'step_desc', 'eqp_id', 'chamber_id', 'ppid', 'y_value', 'good_bad']
DEFAULT_TABLE = 'occas.tmp_fab_ept_table_tg'


class NoData(ValueError):
    """DB에 그 job_id의 데이터가 없음 (화면에서 raw.csv를 올리라고 안내한다)"""


def db_url():
    return os.environ.get('COMBI_DB_URL', '').strip()


def check_job_id(job_id):
    """job_id는 숫자만 받는다 (SQL에 그대로 들어가므로 다른 글자는 막는다)"""
    s = str(job_id).strip()
    if not re.fullmatch(r'\d{1,18}', s):
        raise ValueError('job_id는 숫자만 넣으세요 (예: 2281935)')
    return s


def mask(text):
    """오류 문구에 접속 주소의 비밀번호가 섞여 나오지 않게 가린다"""
    text = re.sub(r'(://[^:/@\s]+:)[^@\s]+@', r'\1***@', str(text))
    m = re.match(r'[^:]+://[^:/@]+:([^@]+)@', db_url())
    return text.replace(m.group(1), '***') if m else text


def fetch_job(job_id, dest, progress=None):
    """job_id의 이력을 DB에서 읽어 dest(raw.csv)로 저장하고 줄 수를 돌려준다"""
    import connectorx as cx                             # DB를 쓸 때만 필요
    say = progress or (lambda stage, text='': None)
    job_id = check_job_id(job_id)
    url = db_url()
    if not url:
        raise RuntimeError('DB 접속 정보(COMBI_DB_URL)가 없습니다. 서버의 .env 파일에 넣고 서버를 다시 켜 주세요.')
    table = os.environ.get('COMBI_DB_TABLE', DEFAULT_TABLE).strip()
    if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_.]*', table):
        raise ValueError(f'COMBI_DB_TABLE 이름을 확인하세요: {table}')
    say('fetch', f'DB에서 job_id {job_id} 데이터를 가져오는 중')
    try:
        df = cx.read_sql(url, f"select {', '.join(DB_COLUMNS)} from {table} where job_id = {job_id}", return_type='polars').to_pandas()
    except Exception as e:                          # 접속 실패 · 권한 · 표 이름 등. 비밀번호는 가린다
        raise RuntimeError(f'DB에서 job_id {job_id}를 가져오지 못했습니다 ({mask(e)}). 잠시 뒤 다시 하거나 raw.csv를 올려 분석하세요.') from None
    if df.empty:
        raise NoData(f'DB에 job_id {job_id} 데이터가 없습니다. raw.csv를 올려서 분석하세요.')
    say('fetch', f'raw.csv로 저장하는 중 ({len(df):,}줄)')
    df['step_ord'] = df['step_seq'].str.extract(r'_(\d+)$')[0].astype('Int64')
    dest = Path(dest)
    tmp = dest.with_name(dest.name + '.tmp')
    df.to_csv(tmp, index=False)
    os.replace(tmp, dest)
    return len(df)
