"""One local ASGI process, two listeners, one analysis worker and job store."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import socket
import sys
import uuid

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

HOST = '127.0.0.1'
APP_ID = 'voicebench'
VERSION = '1.3.0'
DEFAULT_PORTS = (8771, 8767)
STATE_PATH = ROOT/'data/server.json'


class PortConflict(RuntimeError):
    pass


def close_sockets(listeners):
    for listener in listeners:
        try:
            listener.close()
        except OSError:
            pass


def valid_port(value):
    try:
        port = int(value)
    except (TypeError, ValueError):
        raise argparse.ArgumentTypeError('端口必须是 1～65535 的整数。')
    if not 1 <= port <= 65535:
        raise argparse.ArgumentTypeError('端口必须在 1～65535 之间。')
    return port


def bind_sockets(ports, socket_factory=None):
    """Reserve all requested listeners or close every socket; never steal a port."""
    factory = socket_factory or socket.socket
    listeners = []
    current_port = None
    try:
        checked = tuple(valid_port(port) for port in ports)
        if not checked or len(set(checked)) != len(checked):
            raise ValueError('至少需要一个端口，且端口不能重复。')
        for current_port in checked:
            listener = factory(socket.AF_INET, socket.SOCK_STREAM)
            listeners.append(listener)
            if os.name == 'nt' and hasattr(socket, 'SO_EXCLUSIVEADDRUSE'):
                listener.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            else:
                # REUSEADDR supports an orderly restart after TIME_WAIT. REUSEPORT
                # is intentionally never enabled: an active listener stays owned.
                listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            listener.bind((HOST, current_port))
        for current_port, listener in zip(checked, listeners):
            listener.listen(2048)
            listener.setblocking(False)
        return listeners
    except OSError as error:
        close_sockets(listeners)
        raise PortConflict(f'{HOST}:{current_port} 无法绑定：{error}。为保留录音库地址，不会自动换端口或停止现有服务。请确认端口占用后再启动。') from error
    except BaseException:
        close_sockets(listeners)
        raise


def server_info(ports):
    ports = list(ports)
    primary = ports[0]
    return {'schema_version': 1, 'app_id': APP_ID, 'version': VERSION,
            'instance_id': uuid.uuid4().hex, 'pid': os.getpid(), 'host': HOST,
            'ports': ports, 'primary_port': primary, 'port': primary,
            'primary_origin': f'http://{HOST}:{primary}',
            'aliases': [f'http://{HOST}:{port}' for port in ports[1:]],
            'mode': 'recorder-workspace' if tuple(ports) == DEFAULT_PORTS else 'single-port-dev'}


def write_state(state, status, path=STATE_PATH, error=None):
    state['status'] = status
    state['updated_at'] = datetime.now(timezone.utc).isoformat()
    state.setdefault('started_at', state['updated_at'])
    if error is not None:
        state['error'] = str(error)
    else:
        state.pop('error', None)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding='utf-8')
    temporary.replace(path)


def run_server(ports=DEFAULT_PORTS, *, state_path=STATE_PATH, socket_factory=None, uvicorn_module=None, application=None):
    # Binding comes before importing the app or starting its lifespan. A conflict
    # cannot start a second analysis worker or overwrite a running server's state.
    ports = tuple(valid_port(port) for port in ports)
    listeners = bind_sockets(ports, socket_factory)
    state = server_info(ports)
    try:
        if uvicorn_module is None:
            import uvicorn as uvicorn_module
        if application is None:
            from app.server import app as application
        application.state.local_server = state
        write_state(state, 'starting', state_path)

        class WorkspaceServer(uvicorn_module.Server):
            async def startup(self, sockets=None):
                await super().startup(sockets=sockets)
                if self.started:
                    write_state(state, 'ready', state_path)

        config = uvicorn_module.Config(application, host=HOST, port=ports[0], workers=1,
                                        reload=False, proxy_headers=False)
        server = WorkspaceServer(config)
        print('收音工作台：'+state['primary_origin'], flush=True)
        if state['aliases']:
            print('旧地址别名：'+', '.join(state['aliases'])+'（同一个进程与分析队列）', flush=True)
        else:
            print('自定义单端口开发模式；浏览器录音库按当前来源地址独立保存。', flush=True)
        server.run(sockets=listeners)
        if not server.started:
            write_state(state, 'failed', state_path, '服务未完成启动。')
            return 1
        write_state(state, 'stopped', state_path)
        return 0
    except BaseException as error:
        if state_path.exists() or state.get('status'):
            write_state(state, 'failed', state_path, error)
        raise
    finally:
        close_sockets(listeners)


def main(argv=None):
    parser = argparse.ArgumentParser(description='单进程本地收音工作台：默认保留8771录音库来源，并兼容8767旧地址。')
    parser.add_argument('--port', type=valid_port, help='显式选择单端口开发模式；默认同时监听8771和8767，不自动换端口。')
    args = parser.parse_args(argv)
    ports = (args.port,) if args.port is not None else DEFAULT_PORTS
    try:
        return run_server(ports)
    except (OSError, RuntimeError, ImportError) as error:
        print(f'启动未完成：{error}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
