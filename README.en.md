# VoiceBench

[中文说明](README.md) · [Changelog](CHANGELOG.md) · [License](LICENSE)

A local browser workspace for recording, storing and comparing speech from
microphones, devices or firmware variants. Record and replay takes, send them
directly from the local library to analysis, or import external files. Add
verified reference text when needed and get quality predictions, level
measurements, word/group timestamps and exportable comparison reports.
No hosted speech API or API key is required.

**Version 1.3.1. macOS is the primary tested environment.** Python/FFmpeg-based
backend code can run elsewhere, but this release does not claim complete Linux
or Windows desktop validation. The included double-click launcher targets macOS.

## Features

- Integrated Vibe Recorder and browser recording library on the default `#record` tab.
- Same-page `Blob` handoff from the current take or up to 20 selected library takes to `#compare`.
- Microphone selector with a default-input option, device-list refresh and actual input labels.
- Exact-device capture when a specific microphone is chosen; switching is locked during capture and saving.
- Verified library saves with an independent read after the IndexedDB write commits.
- Navigation guards while recording, saving or retaining an unsaved only copy.
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
.venv/bin/python scripts/serve.py
```

Open the primary entry at <http://127.0.0.1:8771>. Both the launcher and the
foreground server use fixed ports **8771 and 8767**, served by one process and
one analysis worker. Port 8767 remains an alias for the old analysis address.
The launcher does not switch to another port or stop an existing process when
an older service or a port conflict is detected; it reports the conflict so the
existing service can be checked before switching.

An explicit `scripts/serve.py --port PORT` is available for single-port development.
A different origin has its own browser library; it does not migrate old takes.
The app is designed for a trusted local machine;
it is not a multi-user internet service. Do not expose this unauthenticated
local app to a public network.

An existing Whisper installation can be reused through
`VOICEBENCH_WHISPER_PYTHON=/path/to/python`. No activation is required when
Whisper is installed in the application's own Python environment.

## Record and use the library

The default workspace is **Recording and library** (`#record`). **Capture analysis
and comparison** (`#compare`) is another tab on the same page; existing report
links continue to use `#test=JOB_ID`.

1. Grant microphone permission, then choose an input from the recording-device
   list (录音设备). Keep the browser-default option (浏览器默认) or select a
   particular microphone; choosing an entry immediately attempts to connect it.
   Complete device names are usually available only after permission is granted.
   Use Refresh devices (刷新设备) after connecting a new device, then select it.
2. Record and stop. The WAV is written to the browser library; saving is only
   reported after the transaction commits and an independent read verifies the
   stored take and WAV header.
3. Replay or download a take, then start the next recording. Switching away is
   blocked during recording, saving, or while an only copy remains unsaved. The
   browser also provides a page-leaving prompt. Keep the page open during capture
   and wait for a successful save before closing it.
4. Send the current take or selected historical takes to analysis. Local `Blob`
   objects are passed within the same page, without a download-and-reimport step.
   The library originals are preserved; selection is limited to 20 takes.

For a specific microphone, the tool requests a new stream with that exact device
ID and releases the old connection. Device selection is kept only in page memory.
Check the track name displayed as the actual recording input; the enumerated list
or a dropdown choice alone is not proof of a successful switch. Unavailable
devices, denied permission and connection failures are reported for correction
and reconnection, without silently falling back to another microphone. When
using browser-default input, reconnect after changing the system or browser
default. Device selection and refresh are disabled while connecting, recording,
or stopping and saving, to prevent switching through this page during a take.
Refreshing the device list does not replace existing library recordings or an
unsaved WAV.

Recording supports at most **30 minutes** per take, but analysis accepts only
**10 minutes and 100 MB per recording**, up to 20 recordings and 500 MB per batch.
Oversized library takes are rejected when adding them to analysis; split them first.

### Existing libraries and origin isolation

The IndexedDB database name remains `vibe-personal-recordings`. Port **8771** is
the primary entry to retain the previous Vibe Recorder origin. Existing takes
remain accessible only through the **same browser profile and the same origin**
that stored them.

`http://127.0.0.1:8771` and `http://127.0.0.1:8767`, `localhost` and `127.0.0.1`,
different browsers and different profiles have separate libraries. Sharing one
server process does not merge that browser storage or automatically migrate data.
The recorder workspace at the old 8767 address shows a reminder linking to 8771.
If historical takes are missing, check the original browser, profile and address
before recording elsewhere. Clearing site data or using private browsing can
also make a library unavailable. Downloaded WAV files can be retained separately.

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

Recorded library audio and metadata stay in the current browser origin's IndexedDB.
Submitting a take for analysis creates a separate local copy, with references,
results and caches under `data/`. These stores do not automatically migrate or
replace each other, and neither is published with the source. Initial
dependency/model installation needs a network connection; capture and analysis
do not upload recordings to an online service. Exports can contain private transcripts, so
review them before sharing. `data/`, `reports/`, recordings, caches, local evidence
and browser artifacts are excluded from Git. No personal sample recordings or
reports are included in this repository.

## Development

```sh
.venv/bin/python -m pip install -r requirements-dev.txt
.venv/bin/python -m pytest tests -q
node --check app/static/app.js
node tests/recorder/integration.mjs
node tests/recorder/pcm.mjs
node tests/recorder/devices.mjs
```

Tests generate their own audio fixtures and do not require downloading Whisper
weights. FFmpeg/ffprobe are required for audio measurement tests. PyTorch and
Whisper are only needed for actual local transcription. The Node.js recorder
tests cover state guards and same-page `Blob` handoff, plus PCM/WAV sample,
silence and missing-input behavior in simulated browser/audio environments.
They do not establish real microphone operation, permission behavior, long-session
reliability or hardware performance. CI runs Python tests, browser script syntax
checks and both JavaScript suites.

## License and acknowledgements

Original VoiceBench code is [MIT licensed](LICENSE). DNSMOS assets, the retained
upstream script and the adapted `DNSMOS` class retain **CC BY 4.0**. See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), the full upstream license and
`models/manifest.json`. The MIT license does not relicense third-party material.

The integrated recorder is adapted from
[SvenKunkka/vibe-recorder](https://github.com/SvenKunkka/vibe-recorder), pinned to
`edf13089a6df745b23613e52d9c6c929114cba41`. Its original MIT attribution is retained
in [app/static/recorder/LICENSE](app/static/recorder/LICENSE). Only source code was
integrated; no user recordings or browser profile data were copied.
