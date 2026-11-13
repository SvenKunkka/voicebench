import asyncio
import argparse
import json
from types import SimpleNamespace

import pytest

import launch
from scripts import serve


class FakeSocket:
    def __init__(self, fail_bind=False, fail_listen=False):
        self.fail_bind = fail_bind
        self.fail_listen = fail_listen
        self.closed = False
        self.listening = False
        self.options = []

    def setsockopt(self, *option):
        self.options.append(option)

    def bind(self, address):
        self.address = address
        if self.fail_bind:
            raise OSError('test port already occupied')

    def listen(self, backlog):
        if self.fail_listen:
            raise OSError('test listen failed')
        self.listening = True

    def setblocking(self, blocking):
        self.blocking = blocking

    def close(self):
        self.closed = True


def socket_factory(sockets):
    pending = iter(sockets)
    return lambda *args: next(pending)


def test_bind_is_all_or_nothing_and_does_not_start_listening_early():
    sockets = [FakeSocket(), FakeSocket(fail_bind=True)]
    with pytest.raises(serve.PortConflict, match='49122'):
        serve.bind_sockets((49121, 49122), socket_factory(sockets))
    assert all(item.closed for item in sockets)
    assert not any(item.listening for item in sockets)
    assert sockets[0].address == ('127.0.0.1', 49121)
    if hasattr(serve.socket, 'SO_REUSEPORT'):
        assert not any(option[1] == serve.socket.SO_REUSEPORT for item in sockets for option in item.options)


def test_listen_failure_closes_both_bound_sockets():
    sockets = [FakeSocket(fail_listen=True), FakeSocket()]
    with pytest.raises(serve.PortConflict, match='49121'):
        serve.bind_sockets((49121, 49122), socket_factory(sockets))
    assert all(item.closed for item in sockets)


def test_successful_bind_keeps_only_loopback_listeners():
    sockets = [FakeSocket(), FakeSocket()]
    assert serve.bind_sockets((49121, 49122), socket_factory(sockets)) == sockets
    assert all(item.listening and item.blocking is False and not item.closed for item in sockets)
    assert [item.address for item in sockets] == [('127.0.0.1', 49121), ('127.0.0.1', 49122)]


def test_duplicate_ports_are_rejected_before_socket_creation():
    with pytest.raises(ValueError, match='不能重复'):
        serve.bind_sockets((49121, 49121), lambda *args: pytest.fail('should not create a socket'))


@pytest.mark.parametrize('port', ['abc', 0, -1, 65536])
def test_port_parser_rejects_invalid_values(port):
    with pytest.raises(argparse.ArgumentTypeError):
        serve.valid_port(port)


def test_conflict_does_not_start_app_or_replace_old_state(tmp_path):
    state_path = tmp_path/'server.json'
    state_path.write_text('{"instance_id":"existing-server"}')
    sockets = [FakeSocket(), FakeSocket(fail_bind=True)]
    with pytest.raises(serve.PortConflict):
        serve.run_server((49121, 49122), state_path=state_path, socket_factory=socket_factory(sockets),
                         uvicorn_module=SimpleNamespace(Config=lambda *a, **k: pytest.fail('must not start app')),
                         application=SimpleNamespace(state=SimpleNamespace()))
    assert json.loads(state_path.read_text()) == {'instance_id': 'existing-server'}


def test_one_server_and_startup_serve_both_sockets(tmp_path):
    calls = {'configs': [], 'servers': 0, 'startups': 0, 'runs': 0}
    state_path = tmp_path/'server.json'
    application = SimpleNamespace(state=SimpleNamespace())
    sockets = [FakeSocket(), FakeSocket()]

    def config(app, **settings):
        calls['configs'].append((app, settings))
        return SimpleNamespace(app=app, **settings)

    class Server:
        def __init__(self, config):
            calls['servers'] += 1
            self.config = config
            self.started = False

        async def startup(self, sockets=None):
            calls['startups'] += 1
            assert sockets == socket_list
            self.started = True

        def run(self, sockets=None):
            calls['runs'] += 1
            assert json.loads(state_path.read_text())['status'] == 'starting'
            asyncio.run(self.startup(sockets=sockets))
            state = json.loads(state_path.read_text())
            assert state['status'] == 'ready'
            assert state['ports'] == [49121, 49122]
            assert state['instance_id'] == application.state.local_server['instance_id']

    socket_list = sockets
    module = SimpleNamespace(Config=config, Server=Server)
    assert serve.run_server((49121, 49122), state_path=state_path, socket_factory=socket_factory(sockets),
                            uvicorn_module=module, application=application) == 0
    assert calls['servers'] == calls['startups'] == calls['runs'] == 1
    assert len(calls['configs']) == 1 and calls['configs'][0][0] is application
    assert calls['configs'][0][1]['workers'] == 1
    assert calls['configs'][0][1]['reload'] is False
    assert all(item.closed for item in sockets)
    assert json.loads(state_path.read_text())['status'] == 'stopped'


def health(ports=serve.DEFAULT_PORTS, instance='same-process', pid=123):
    info = serve.server_info(ports)
    info.update(instance_id=instance, pid=pid, status='ready')
    return {'app_id': 'voicebench', 'name': '收音对比台', 'version': '1.3.0',
            'instance_id': instance, 'pid': pid, 'server': info}


def test_same_instance_is_required_on_both_default_addresses():
    values = {port: health() for port in serve.DEFAULT_PORTS}
    assert launch.matching_workspace(values, serve.DEFAULT_PORTS)
    values[8767] = health(instance='another-process')
    assert not launch.matching_workspace(values, serve.DEFAULT_PORTS)
    values[8767] = health(pid=456)
    assert not launch.matching_workspace(values, serve.DEFAULT_PORTS)
    values[8767] = health()
    values[8771]['server']['status'] = 'starting'
    assert not launch.matching_workspace(values, serve.DEFAULT_PORTS)


def test_ready_launcher_opens_main_origin_without_new_process(monkeypatch):
    monkeypatch.setattr(launch, 'read_health', lambda port: health())
    monkeypatch.setattr(launch.subprocess, 'Popen', lambda *a, **k: pytest.fail('must reuse the one server'))
    opened = []
    monkeypatch.setattr(launch.webbrowser, 'open', opened.append)
    assert launch.main([]) == 0
    assert opened == ['http://127.0.0.1:8771']


def test_legacy_or_incomplete_alias_is_not_silently_opened(monkeypatch, capsys):
    monkeypatch.setattr(launch, 'read_health', lambda port: health((8767,)) if port == 8767 else None)
    monkeypatch.setattr(launch.subprocess, 'Popen', lambda *a, **k: pytest.fail('must not start another worker'))
    monkeypatch.setattr(launch.webbrowser, 'open', lambda *a: pytest.fail('must not open another origin'))
    assert launch.main([]) == 1
    assert '8771主入口与8767别名尚未' in capsys.readouterr().out


def test_other_local_app_is_not_treated_as_voicebench(monkeypatch, capsys):
    monkeypatch.setattr(launch, 'read_health', lambda port: {'name': 'other local app'})
    monkeypatch.setattr(launch, 'port_occupied', lambda port: True)
    monkeypatch.setattr(launch.subprocess, 'Popen', lambda *a, **k: pytest.fail('must not displace local app'))
    assert launch.main(['--no-browser']) == 1
    assert '其他服务占用' in capsys.readouterr().out
    assert not launch.is_voicebench({'name': '收音对比台'})
    assert not launch.is_voicebench({'name': '收音对比台', 'capabilities': 'invalid'})


def test_launcher_starts_exactly_one_dual_port_process(monkeypatch, tmp_path):
    launched = []
    opened = []
    monkeypatch.setattr(launch, 'ROOT', tmp_path)
    monkeypatch.setattr(launch, 'project_python', lambda: '/fake/python')
    monkeypatch.setattr(launch, 'port_occupied', lambda port: False)
    monkeypatch.setattr(launch, 'read_health', lambda port: health() if launched else None)
    monkeypatch.setattr(launch.webbrowser, 'open', opened.append)
    def start(command, **options):
        launched.append((command, options))
        return SimpleNamespace(poll=lambda: None)
    monkeypatch.setattr(launch.subprocess, 'Popen', start)
    assert launch.main([]) == 0
    assert len(launched) == 1
    assert launched[0][0] == ['/fake/python', str(tmp_path/'scripts/serve.py')]
    assert '--port' not in launched[0][0]
    assert opened == ['http://127.0.0.1:8771']


def test_explicit_custom_port_is_single_port_development(monkeypatch, tmp_path):
    launched = []
    monkeypatch.setattr(launch, 'ROOT', tmp_path)
    monkeypatch.setattr(launch, 'project_python', lambda: '/fake/python')
    monkeypatch.setattr(launch, 'port_occupied', lambda port: False)
    monkeypatch.setattr(launch, 'read_health', lambda port: health((49123,)) if launched else None)
    monkeypatch.setattr(launch.webbrowser, 'open', lambda *a: pytest.fail('no-browser requested'))
    monkeypatch.setattr(launch.subprocess, 'Popen', lambda command, **options: launched.append(command) or SimpleNamespace(poll=lambda: None))
    assert launch.main(['--port', '49123', '--no-browser']) == 0
    assert len(launched) == 1 and launched[0][-2:] == ['--port', '49123']
