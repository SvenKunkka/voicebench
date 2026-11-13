"""Double-click launcher. Uses only local Python and the project's environment."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.request
import webbrowser

ROOT = Path(__file__).resolve().parent


def running(port):
    try:
        with urllib.request.urlopen(f'http://127.0.0.1:{port}/api/health', timeout=.7) as response:
            return json.load(response).get('name') == '收音对比台'
    except Exception:
        return False


def main():
    for port in range(8767,8778):
        if running(port):
            webbrowser.open(f'http://127.0.0.1:{port}')
            print(f'收音对比台已打开：http://127.0.0.1:{port}')
            return
    python = ROOT/'.venv/bin/python'
    if not python.exists():
        print('本地运行环境不存在，请按 README.md 的安装说明恢复环境。')
        input('按回车关闭。');sys.exit(1)
    import socket
    port = None
    for candidate in range(8767,8778):
        with socket.socket() as sock:
            try:
                sock.bind(('127.0.0.1',candidate));port=candidate;break
            except OSError:
                continue
    if port is None:
        raise RuntimeError('本地端口均被占用，请稍后重试。')
    (ROOT/'data').mkdir(exist_ok=True)
    with open(ROOT/'data/server.log','ab') as log:
        process = subprocess.Popen([str(python),'-m','uvicorn','app.server:app','--host','127.0.0.1','--port',str(port)],
                                   cwd=ROOT,stdout=log,stderr=log,start_new_session=True)
    (ROOT/'data/server.json').write_text(json.dumps({'pid':process.pid,'port':port}))
    for _ in range(100):
        if running(port):
            webbrowser.open(f'http://127.0.0.1:{port}')
            print(f'收音对比台已打开：http://127.0.0.1:{port}')
            return
        if process.poll() is not None:
            break
        time.sleep(.2)
    raise RuntimeError('启动未完成，请查看 data/server.log。')


if __name__ == '__main__':
    main()
