"""python -m web 으로 서버를 띄운다 (기본 0.0.0.0:3002)"""
import copy
import os

import uvicorn
from uvicorn.config import LOGGING_CONFIG

# 접속 기록(access log) 앞에 날짜 · 시간만 붙인다. 나머지 설정은 Uvicorn 기본 그대로
# 예: 2026-10-07 07:55:31 | INFO: 10.222.56.228:61884 - "GET /api/runs HTTP/1.1" 200 OK
LOG_CONFIG = copy.deepcopy(LOGGING_CONFIG)
LOG_CONFIG['formatters']['access'].update(fmt='%(asctime)s | %(levelname)s: %(client_addr)s - "%(request_line)s" %(status_code)s',
                                          datefmt='%Y-%m-%d %H:%M:%S')


def main():
    uvicorn.run('web.app:app', host=os.environ.get('COMBI_HOST', '0.0.0.0'), port=int(os.environ.get('COMBI_PORT', '3002')),
                workers=1, log_level=os.environ.get('COMBI_LOG_LEVEL', 'info'), log_config=LOG_CONFIG)


if __name__ == '__main__':
    main()
