"""Check local dependencies and fetch public model weights, never user audio.

Run with the project's Python after installing requirements. Existing verified
weights are reused without a network request. --check-only never downloads.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

WHISPER_VERSION = '20250625'
SMALL_SHA256 = '9ecf779972d90ba49c06d968637d720dd632c55bbf19d441fb42bf17a411e794'
SMALL_URL = f'https://openaipublic.azureedge.net/main/whisper/models/{SMALL_SHA256}/small.pt'


def _executable(candidate: str) -> str | None:
    expanded = os.path.expandvars(os.path.expanduser(candidate))
    path = Path(expanded)
    try:
        if path.is_file() and os.access(path, os.X_OK):
            return str(path)
        return shutil.which(expanded)
    except (OSError, ValueError):
        return None


def _python_shebang(command: str) -> str | None:
    """Ignore binary launchers and shell wrappers; do not execute arbitrary CLIs."""
    try:
        with Path(command).resolve(strict=True).open('rb') as source:
            first = source.readline(512).decode('utf-8').strip()
        if not first.startswith('#!'):
            return None
        parts = shlex.split(first[2:].strip())
        if not parts:
            return None
        interpreter = parts[0]
        if Path(interpreter).name == 'env':
            args = parts[1:]
            if args and args[0] == '-S':
                args = args[1:]
            # Do not reinterpret shell expressions, env assignments or env options.
            if not args or args[0].startswith('-') or '=' in args[0]:
                return None
            interpreter = args[0]
        if not re.fullmatch(r'python(?:\d+(?:\.\d+)*)?(?:\.exe)?', Path(interpreter).name, re.I):
            return None
        return _executable(interpreter)
    except (OSError, UnicodeError, ValueError):
        return None


def discover_whisper_python() -> str | None:
    """Explicit override, this interpreter's package, then a Python Whisper CLI."""
    override = os.environ.get('VOICEBENCH_WHISPER_PYTHON')
    if override:
        # An invalid explicit override stays unavailable instead of silently using
        # another model environment chosen for a different experiment.
        return _executable(override)
    try:
        if importlib.util.find_spec('whisper') is not None:
            return sys.executable
    except (ImportError, ValueError, AttributeError):
        pass
    command = shutil.which('whisper')
    return _python_shebang(command) if command else None


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(1024*1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def ensure_weight(url: str, destination: Path, expected: str, *, check_only: bool = False) -> bool:
    """Return True on download. Verify before replacing any existing cache file."""
    if destination.is_file() and sha256_file(destination) == expected:
        print(f'OK cached model: {destination.name}')
        return False
    if check_only:
        raise RuntimeError(f'Missing or invalid model: {destination}. Run setup without --check-only to fetch public weights.')
    if not url.startswith('https://'):
        raise RuntimeError('Model downloads require an HTTPS source.')
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(prefix=destination.name+'.', suffix='.part', dir=destination.parent, delete=False) as output:
            temporary = Path(output.name)
            request = urllib.request.Request(url, headers={'User-Agent': 'VoiceBench-model-setup/1.2'})
            print(f'Downloading public model: {destination.name}')
            with urllib.request.urlopen(request, timeout=60) as response:
                for chunk in iter(lambda: response.read(1024*1024), b''):
                    output.write(chunk)
        if sha256_file(temporary) != expected:
            raise RuntimeError(f'SHA-256 verification failed for {destination.name}; existing cache was preserved.')
        temporary.replace(destination)
        temporary = None
        print(f'OK verified model: {destination.name}')
        return True
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def check_dependencies() -> str:
    if sys.version_info < (3, 10):
        raise RuntimeError('Python 3.10 or newer is required; Python 3.12 is recommended for the pinned dependencies.')
    print(f'Python: {sys.version.split()[0]} ({sys.executable})')
    for executable in ('ffmpeg', 'ffprobe'):
        if not shutil.which(executable):
            raise RuntimeError(f'{executable} was not found on PATH. Install FFmpeg and run setup again.')
    python = discover_whisper_python()
    if python is None:
        raise RuntimeError('Whisper is not installed. Run this environment’s Python with -m pip install -r requirements-asr.txt.')
    try:
        check = subprocess.run([python, '-c', 'import whisper; print(whisper.__version__)'],
                               capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise RuntimeError('The selected Whisper Python could not be started. Check VOICEBENCH_WHISPER_PYTHON.') from error
    if check.returncode:
        raise RuntimeError('The selected Python cannot import Whisper. Install requirements-asr.txt in that environment.')
    installed = check.stdout.strip().splitlines()[-1] if check.stdout.strip() else 'unknown'
    print(f'Whisper: {installed} ({python})')
    if installed != WHISPER_VERSION:
        print(f'Note: fresh installs use openai-whisper=={WHISPER_VERSION}; this existing environment uses {installed}.')
    return python


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description='Check VoiceBench and prepare verified public model weights. No audio is read or uploaded.')
    parser.add_argument('--check-only', action='store_true', help='Check local dependencies and cached model hashes; never download.')
    args = parser.parse_args(argv)
    print('VoiceBench model setup. First preparation may download public weights; no recordings are read or uploaded.')
    try:
        check_dependencies()
        manifest = json.loads((ROOT/'models/manifest.json').read_text(encoding='utf-8'))
        for name in ('sig_bak_ovr.onnx', 'DNS-Challenge-LICENSE.txt'):
            item = manifest['files'][name]
            ensure_weight(item['url'], ROOT/'models'/name, item['sha256'], check_only=args.check_only)
        ensure_weight(SMALL_URL, Path.home()/'.cache/whisper/small.pt', SMALL_SHA256, check_only=args.check_only)
    except (OSError, RuntimeError, ValueError, KeyError) as error:
        print(f'Setup incomplete: {error}', file=sys.stderr)
        return 1
    print('Ready. Start the local tool with this project’s Python and launch.py.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
