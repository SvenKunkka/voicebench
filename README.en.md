# VoiceBench

[中文说明](README.md) · [Changelog](CHANGELOG.md) · [License](LICENSE)

A local browser tool for comparing speech recordings from microphones, devices
or firmware variants. Import recordings, optionally attach verified transcripts,
and get quality predictions, level measurements, word/group timestamps and
exportable comparison reports. No hosted speech API or API key is required.

**Version 1.2.0. macOS is the primary tested environment.** Python/FFmpeg-based
backend code can run elsewhere, but this release does not claim complete Linux
or Windows desktop validation. The included double-click launcher targets macOS.

## Features

- Batch import up to 20 recordings, with device/scenario labels and repeated trials.
- Independent local Whisper small transcription, never prompted with the reference.
- Optional reference-based character error rate (CER) and position-aligned keywords.
- DNSMOS P.835 speech, background and overall quality predictions.
- Original-level LUFS, true peak and conservative clipping/energy checks.
- Clickable word/group timestamps, transcript character positions and review candidates.
- Separate uncertain transcription from acoustic candidates.
- Side-by-side audition with optional fixed-gain RMS matching.
- Persistent local history and reanalysis that retains the previous successful result.
- Standalone HTML, score CSV, localization CSV and complete JSON exports.

## Install and run

Requirements: Python 3.12, `ffmpeg` and `ffprobe`, and a modern browser. On macOS
with Homebrew:

```sh
brew install python@3.12 ffmpeg
git clone https://github.com/SvenKunkka/voicebench.git
cd voicebench
python3.12 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt -r requirements-asr.txt
.venv/bin/python scripts/setup_models.py
.venv/bin/python launch.py
```

The setup helper's first run needs network access to download official Whisper
`small.pt` weights (approximately 484 MB) to `~/.cache/whisper/`. Existing valid
weights are reused. The much smaller DNSMOS model is included with its upstream
license and a SHA-256 manifest. Recording analysis itself runs locally.

After setup, macOS users can double-click `启动收音对比台.command`.
Alternatively run the server directly:

```sh
.venv/bin/python -m uvicorn app.server:app --host 127.0.0.1 --port 8767
```

Open <http://127.0.0.1:8767>. The app is designed for a trusted local machine;
it is not a multi-user internet service. Do not expose this unauthenticated
local app to a public network.

An existing Whisper installation can be reused through
`VOICEBENCH_WHISPER_PYTHON=/path/to/python`. No activation is required when
Whisper is installed in the application's own Python environment.

## Compare recordings

1. Import audio: up to 100 MB and 10 minutes per recording, 500 MB per batch.
2. Set device and scenario labels. Use the same device label for repeated trials.
3. Leave reference text empty to compare quality only. Add shared/per-file verified
   text when content scoring is needed. Different scripts are not pooled for CER.
4. Optionally specify keywords, such as numbers, names, model IDs and negations.
5. Confirm controlled recording conditions only if they were actually consistent.
6. Compare quality, inspect transcripts and click timestamped words or candidates
   to replay the original-level analysis copy.
7. Export reports. Localization CSV includes word/group times, transcript character
   positions, candidate evidence and precision limits.

## What the measurements mean

| Measurement | Interpretation |
|---|---|
| CER | Substitutions + deletions + insertions divided by reference characters; may exceed 100%. English is also evaluated by character. |
| Content score | `max(0, 100 * (1 - CER))`; an ASR-derived score, not human comprehension percentage. |
| Keyword accuracy | Checks each keyword occurrence at its aligned reference position. |
| DNSMOS | Predicted speech/background/overall quality, not a listening-test MOS or calibrated acoustic SNR. |
| LUFS / true peak | Measured with FFmpeg on the selected original-rate channel. |
| Clipping candidates | Consecutive samples near full scale; not a complete distortion detector. |
| Word/group times | Whisper alignment estimates, not exact phoneme boundaries. Multi-character groups are not split into invented timings. |
| Local candidates | Conservative signal heuristics for review; natural pauses, pronunciation and alignment errors can look similar. |

Without a verified reference, CER/content/keyword scores stay unavailable. The
independent transcript is never used as its own ground truth. Text normalization
uses NFKC, simplified Chinese and case folding, ignoring punctuation/whitespace;
it does not silently equate written numbers such as `15` and `十五`.

Quality comparisons group by scenario, with explicit limits for different or
unknown scripts. CER comparisons additionally require matching non-empty
normalized references. Repeated recordings are averaged per device. Model
differences are engineering hints, not statistical significance or hardware
pass/fail criteria. Use controlled playback, multiple speakers/devices/repeats
and blinded listening before making product claims.

DNSMOS uses overlapping 9.01-second windows with a one-second stride. Short audio
is repeated according to the upstream method and marked as such. The tool does
not invent per-word MOS values or claim how much a particular character lowered
the overall score. Low ASR probability is a transcription review cue, not proof
of poor microphone capture. No STOI/PESQ is computed without a clean reference;
no human intelligibility rate is fabricated.

Playback uses a selected-channel, 16 kHz mono analysis copy. Optional fixed-gain
matching targets -23 dBFS RMS subject to sample-peak headroom; it is not LUFS
matching or denoising. Waveforms scale to each recording's own peak.

## Privacy and storage

Recordings, references, results and caches stay under local `data/`. Initial
dependency/model installation needs a network connection; analysis does not
upload recordings to a service. Exports can contain private transcripts, so
review them before sharing. `data/`, `reports/`, recordings, caches, local evidence
and browser artifacts are excluded from Git. No personal sample recordings or
reports are included in this repository.

## Development

```sh
.venv/bin/python -m pip install -r requirements-dev.txt
.venv/bin/python -m pytest tests -q
node --check app/static/app.js
```

Tests generate their own audio fixtures and do not require downloading Whisper
weights. FFmpeg/ffprobe are required for audio measurement tests. PyTorch and
Whisper are only needed for actual local transcription.

## License and acknowledgements

Original VoiceBench code is [MIT licensed](LICENSE). DNSMOS assets, the retained
upstream script and the adapted `DNSMOS` class retain **CC BY 4.0**. See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), the full upstream license and
`models/manifest.json`. The MIT license does not relicense third-party material.
