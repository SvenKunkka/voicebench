import hashlib
import io
from pathlib import Path

import pytest

from scripts import setup_models


def python_file(tmp_path, name='python3'):
    path = tmp_path/name
    path.write_text('#!/bin/sh\n')
    path.chmod(0o755)
    return path


def test_current_virtualenv_without_activation_is_preferred(monkeypatch):
    monkeypatch.delenv('VOICEBENCH_WHISPER_PYTHON', raising=False)
    monkeypatch.setattr(setup_models.importlib.util, 'find_spec', lambda name: object())
    monkeypatch.setattr(setup_models.sys, 'executable', '/some/project/.venv/bin/python')
    monkeypatch.setattr(setup_models.shutil, 'which', lambda _: pytest.fail('PATH should not be needed'))
    assert setup_models.discover_whisper_python() == '/some/project/.venv/bin/python'


def test_explicit_python_override_remains_first(monkeypatch, tmp_path):
    chosen = python_file(tmp_path)
    monkeypatch.setenv('VOICEBENCH_WHISPER_PYTHON', str(chosen))
    monkeypatch.setattr(setup_models.importlib.util, 'find_spec', lambda _: pytest.fail('explicit override should win'))
    assert setup_models.discover_whisper_python() == str(chosen)
    monkeypatch.setenv('VOICEBENCH_WHISPER_PYTHON', str(tmp_path/'missing-python'))
    assert setup_models.discover_whisper_python() is None


@pytest.mark.parametrize('shebang', ['{python}', '/usr/bin/env python3', '/usr/bin/env -S python3 -u'])
def test_external_python_shebang_is_supported(monkeypatch, tmp_path, shebang):
    python = python_file(tmp_path)
    command = tmp_path/'whisper'
    command.write_text('#!'+shebang.format(python=python)+'\nprint("entry point")\n')
    monkeypatch.delenv('VOICEBENCH_WHISPER_PYTHON', raising=False)
    monkeypatch.setattr(setup_models.importlib.util, 'find_spec', lambda _: None)
    monkeypatch.setattr(setup_models.shutil, 'which', lambda name: str(command) if name=='whisper' else str(python) if name=='python3' else None)
    assert setup_models.discover_whisper_python() == str(python)


@pytest.mark.parametrize('content', [b'#!/bin/bash\npython -m whisper\n', b'not a script', b'\x00\xff\xfe', b''])
def test_non_python_and_binary_cli_does_not_look_ready(monkeypatch, tmp_path, content):
    command = tmp_path/'whisper'
    command.write_bytes(content)
    monkeypatch.delenv('VOICEBENCH_WHISPER_PYTHON', raising=False)
    monkeypatch.setattr(setup_models.importlib.util, 'find_spec', lambda _: None)
    monkeypatch.setattr(setup_models.shutil, 'which', lambda name: str(command) if name=='whisper' else None)
    assert setup_models.discover_whisper_python() is None


def test_unreadable_cli_fails_closed(monkeypatch, tmp_path):
    command = tmp_path/'whisper'
    command.write_text('#!/bin/python3\n')
    monkeypatch.delenv('VOICEBENCH_WHISPER_PYTHON', raising=False)
    monkeypatch.setattr(setup_models.importlib.util, 'find_spec', lambda _: None)
    monkeypatch.setattr(setup_models.shutil, 'which', lambda _: str(command))
    original = Path.open
    def denied(path, *args, **kwargs):
        if path == command:
            raise PermissionError('test unreadable script')
        return original(path, *args, **kwargs)
    monkeypatch.setattr(Path, 'open', denied)
    assert setup_models.discover_whisper_python() is None


def test_verified_cache_never_connects(monkeypatch, tmp_path):
    model = tmp_path/'small.pt'
    model.write_bytes(b'verified cached weights')
    digest = hashlib.sha256(model.read_bytes()).hexdigest()
    monkeypatch.setattr(setup_models.urllib.request, 'urlopen', lambda *a, **k: pytest.fail('cache must stay offline'))
    assert setup_models.ensure_weight('https://example.invalid/weights', model, digest) is False
    assert setup_models.ensure_weight('https://example.invalid/weights', model, digest, check_only=True) is False


def test_check_only_missing_cache_never_connects(monkeypatch, tmp_path):
    monkeypatch.setattr(setup_models.urllib.request, 'urlopen', lambda *a, **k: pytest.fail('check-only must stay offline'))
    with pytest.raises(RuntimeError, match='Missing or invalid'):
        setup_models.ensure_weight('https://example.invalid/weights', tmp_path/'small.pt', '0'*64, check_only=True)
    assert not list(tmp_path.iterdir())


def test_failed_checksum_preserves_previous_cache_and_cleans_staging(monkeypatch, tmp_path):
    model = tmp_path/'small.pt'
    model.write_bytes(b'previous cache')
    monkeypatch.setattr(setup_models.urllib.request, 'urlopen', lambda *a, **k: io.BytesIO(b'bad download'))
    with pytest.raises(RuntimeError, match='SHA-256'):
        setup_models.ensure_weight('https://example.invalid/weights', model, hashlib.sha256(b'expected model').hexdigest())
    assert model.read_bytes()==b'previous cache'
    assert list(tmp_path.iterdir())==[model]


def test_verified_download_atomically_replaces_invalid_cache(monkeypatch, tmp_path):
    model = tmp_path/'small.pt'
    model.write_bytes(b'old invalid file')
    expected = b'public model weights'
    monkeypatch.setattr(setup_models.urllib.request, 'urlopen', lambda *a, **k: io.BytesIO(expected))
    assert setup_models.ensure_weight('https://example.invalid/weights', model, hashlib.sha256(expected).hexdigest()) is True
    assert model.read_bytes()==expected
    assert list(tmp_path.iterdir())==[model]


def test_network_failure_preserves_previous_cache(monkeypatch, tmp_path):
    model = tmp_path/'small.pt'
    model.write_bytes(b'previous cache')
    def unavailable(*args, **kwargs):
        raise OSError('network unavailable')
    monkeypatch.setattr(setup_models.urllib.request, 'urlopen', unavailable)
    with pytest.raises(OSError, match='network unavailable'):
        setup_models.ensure_weight('https://example.invalid/weights', model, '0'*64)
    assert model.read_bytes()==b'previous cache'
    assert list(tmp_path.iterdir())==[model]


def test_engine_discovery_uses_the_portable_helper(monkeypatch):
    from app import engine
    monkeypatch.setattr(engine, 'discover_whisper_python', lambda: '/portable/.venv/bin/python')
    assert engine.whisper_python()=='/portable/.venv/bin/python'
