"""Open the existing workspace or start one local process without changing origin."""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
import urllib.request
import webbrowser

from scripts.serve import APP_ID, DEFAULT_PORTS, HOST, ROOT, valid_port


def read_health(port):
    try:
        with urllib.request.urlopen(f'http://{HOST}:{port}/api/health', timeout=.7) as response:
            result = json.load(response)
            return result if isinstance(result, dict) else None
    except (OSError, ValueError, TypeError):
        return None


def is_voicebench(health):
    if not isinstance(health, dict):
        return False
    if health.get('app_id') == APP_ID:
        return True
    # Recognize the legacy tool for an explicit upgrade message, never as a
    # ready merged workspace or as permission to terminate its process.
    capabilities = health.get('capabilities')
    return (health.get('name') == '收音对比台' and isinstance(health.get('version'), str)
            and isinstance(capabilities, dict) and capabilities.get('local_only') is True
            and isinstance(health.get('method'), dict))


def matching_workspace(healths, ports):
    instance = None
    pid = None
    for port in ports:
        health = healths.get(port)
        if not isinstance(health, dict) or health.get('app_id') != APP_ID:
            return False
        info = health.get('server')
        if not isinstance(info, dict) or info.get('host') != HOST or info.get('ports') != list(ports):
            return False
        if info.get('primary_port') != ports[0] or info.get('status') != 'ready':
            return False
        expected_mode = 'recorder-workspace' if tuple(ports) == DEFAULT_PORTS else 'single-port-dev'
        if info.get('mode') != expected_mode or info.get('primary_origin') != f'http://{HOST}:{ports[0]}':
            return False
        candidate = health.get('instance_id')
        if not isinstance(candidate, str) or not candidate or info.get('instance_id') != candidate:
            return False
        if instance is not None and candidate != instance:
            return False
        process = health.get('pid')
        if not isinstance(process, int) or process <= 0 or info.get('pid') != process:
            return False
        if pid is not None and process != pid:
            return False
        instance = candidate
        pid = process
    return True


def port_occupied(port):
    try:
        with socket.create_connection((HOST, port), timeout=.3):
            return True
    except OSError:
        return False


def project_python():
    for path in (ROOT/'.venv/bin/python', ROOT/'.venv/Scripts/python.exe'):
        if path.is_file():
            return str(path)
    try:
        if importlib.util.find_spec('uvicorn') and importlib.util.find_spec('fastapi'):
            return sys.executable
    except (ImportError, ValueError):
        pass
    return None


def open_workspace(port, no_browser):
    url = f'http://{HOST}:{port}'
    if not no_browser:
        webbrowser.open(url)
    print(f'收音工作台已就绪：{url}')


def main(argv=None):
    parser = argparse.ArgumentParser(description='打开本地收音工作台，默认固定8771主入口与8767旧地址。')
    parser.add_argument('--port', type=valid_port, help='显式选择单端口开发模式；不同来源地址的浏览器录音库互相独立。')
    parser.add_argument('--no-browser', action='store_true', help='启动或检查服务，但不打开浏览器。')
    args = parser.parse_args(argv)
    ports = (args.port,) if args.port is not None else DEFAULT_PORTS
    healths = {port: read_health(port) for port in ports}
    if matching_workspace(healths, ports):
        open_workspace(ports[0], args.no_browser)
        return 0
    existing = [port for port, health in healths.items() if is_voicebench(health)]
    if existing:
        print('检测到已有收音对比服务：'+', '.join(str(port) for port in existing)+'。')
        reason = ('8771主入口与8767别名尚未由同一个新版服务提供，或当前服务仍在启动。'
                  if args.port is None else '该端口的服务尚未以指定的单端口开发模式就绪。')
        print(reason+'为保留录音库来源，不会另起服务、换端口或关闭现有进程。请确认旧服务状态后使用 scripts/serve.py 统一启动。')
        return 1
    occupied = [port for port in ports if port_occupied(port)]
    if occupied:
        print('以下固定端口正被其他服务占用：'+', '.join(str(port) for port in occupied)+'。为保留录音库来源，本工具不会自动改用其他地址或停止现有服务。')
        return 1
    python = project_python()
    if python is None:
        print('本地运行环境不存在，请按 README.md 的安装说明准备环境。')
        return 1
    data = ROOT/'data'
    data.mkdir(exist_ok=True)
    command = [python, str(ROOT/'scripts/serve.py')]
    if args.port is not None:
        command += ['--port', str(args.port)]
    try:
        with (data/'server.log').open('ab') as log:
            process = subprocess.Popen(command, cwd=ROOT, stdout=log, stderr=log,
                                       start_new_session=os.name != 'nt')
    except OSError as error:
        print(f'无法启动本地服务：{error}。请检查运行环境；未切换端口。')
        return 1
    for _ in range(100):
        current = {port: read_health(port) for port in ports}
        if matching_workspace(current, ports):
            open_workspace(ports[0], args.no_browser)
            return 0
        if process.poll() is not None:
            break
        time.sleep(.2)
    print('启动尚未确认。请查看 data/server.log 与 data/server.json；不会自动换端口或关闭进程。')
    return 1


if __name__ == '__main__':
    raise SystemExit(main())
