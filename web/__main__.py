"""python -m web 으로 서버를 띄운다 (기본 0.0.0.0:3004)"""
import os

import uvicorn


def main():
    uvicorn.run('web.app:app', host=os.environ.get('COMBI_HOST', '0.0.0.0'), port=int(os.environ.get('COMBI_PORT', '3004')),
                workers=1, log_level=os.environ.get('COMBI_LOG_LEVEL', 'info'))


if __name__ == '__main__':
    main()
