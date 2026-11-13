# Third-party notices

The root MIT license covers original VoiceBench code and documentation. It does
not replace third-party licenses. No upstream endorsement is implied.

## Vibe Recorder

- Upstream: <https://github.com/SvenKunkka/vibe-recorder>.
- Copyright: **Copyright (c) 2026 SvenKunkka**.
- Pinned source revision: `edf13089a6df745b23613e52d9c6c929114cba41`.
- License: **MIT**.
- Retained license and copyright notice:
  [app/static/recorder/LICENSE](app/static/recorder/LICENSE).

The recorder in `app/static/recorder/` is copied and adapted from that source.
VoiceBench adaptations provide a mountable recorder module, scoped DOM and CSS,
same-page callbacks for current or selected library `Blob` objects, integration
with the analysis workspace, and navigation/state guards. The existing
`vibe-personal-recordings` IndexedDB name and recording data layout are retained.
The retained MIT text continues to apply to the upstream material; VoiceBench's
root license does not remove its copyright notice.

Only source was integrated. User recordings, IndexedDB contents and browser
profiles are not included in this repository. Serving two ports does not transfer
browser storage between their separate origins or between profiles.

## Microsoft DNS-Challenge / DNSMOS P.835

- Upstream: <https://github.com/microsoft/DNS-Challenge>
- Attribution: Microsoft and DNS-Challenge contributors.
- Pinned revision: `785ab12275d5cf9341c5e946b0eee9f8825ece3b`.
- License: **Creative Commons Attribution 4.0 International (CC BY 4.0)**.
- Full license: [models/DNS-Challenge-LICENSE.txt](models/DNS-Challenge-LICENSE.txt).
- Source URLs, sizes and SHA-256 checksums: [models/manifest.json](models/manifest.json).

The following material retains that upstream license:

1. `models/sig_bak_ovr.onnx`: the non-personalized DNSMOS P.835 model, unchanged.
2. `models/dnsmos_upstream.py`: the original upstream scoring script, unchanged,
   retained for provenance and not used as the application entry point.
3. The `DNSMOS` class in `app/audio_metrics.py`: an adaptation of the upstream
   inference routine, including 9.01-second framing and polynomial calibration.

Adaptation by VoiceBench contributors: decoding/resampling happen outside the
scorer; ONNX runs locally on CPU; model integrity is checked; per-window scores
are retained; P.808 inference is omitted; digital silence is unavailable. The
original model and calibration are not retrained.

Reference: C. K. A. Reddy, V. Gopal and R. Cutler, *DNSMOS P.835: A Non-Intrusive
Perceptual Objective Speech Quality Metric to Evaluate Noise Suppressors*,
<https://arxiv.org/abs/2110.01763>.

## OpenAI Whisper

Whisper is an optional external dependency maintained by OpenAI:
<https://github.com/openai/whisper>. Code and model weights use the MIT license:
<https://github.com/openai/whisper/blob/main/LICENSE>. They are not vendored in
this repository. The setup helper downloads official `small.pt` weights to the
user's local cache only when requested and checks the upstream SHA-256 checksum.

## Other runtime dependencies

Dependencies installed by users retain their licenses, including FastAPI,
Uvicorn, NumPy, SciPy, ONNX Runtime, RapidFuzz, OpenCC, PyTorch and python-multipart.
FFmpeg / ffprobe are external executables; their license depends on the build
configuration. This repository does not redistribute those executables, Python
wheels or local virtual environments.

## Browser online edition

The independently deployable browser edition is included under `online/`. Its additional self-hosted Transformers.js, quantized Whisper model, ONNX WASM, OpenCC data and ebur128-WASM attributions and license boundaries are recorded in [online/THIRD_PARTY_NOTICES.md](online/THIRD_PARTY_NOTICES.md). The original local-edition notices above continue to apply to their files.
