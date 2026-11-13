# Third-party notices · VoiceBench Online

Original VoiceBench Online code is separate from the materials listed below.
Its license does not replace third-party licenses. No upstream endorsement is
implied. Only source code and public model/runtime assets are distributed; user
recordings, browser databases and private transcripts are not included.

## Vibe Recorder and the VoiceBench recorder adaptation

- Upstream: <https://github.com/SvenKunkka/vibe-recorder>.
- Copyright: **Copyright (c) 2026 SvenKunkka**.
- Pinned Vibe source revision: `edf13089a6df745b23613e52d9c6c929114cba41`.
- License: **MIT**, retained at [dist/static/recorder/LICENSE](static/recorder/LICENSE).

The recorder is adapted through the local VoiceBench project for mountable/scoped
UI, same-page Blob handoff, device selection, recording-library integration and
navigation protection. The `vibe-personal-recordings` IndexedDB name/layout is
retained, without copying any user's database. Moving the application to HTTPS
does not migrate recordings between origins or browser profiles.

## Microsoft DNS-Challenge / DNSMOS P.835

- Upstream: <https://github.com/microsoft/DNS-Challenge>.
- Attribution: Microsoft and DNS-Challenge contributors.
- Pinned revision: `785ab12275d5cf9341c5e946b0eee9f8825ece3b`.
- License: **Creative Commons Attribution 4.0 International (CC BY 4.0)**.
- Full license: [dist/LICENSES/DNS-Challenge-CC-BY-4.txt](LICENSES/DNS-Challenge-CC-BY-4.txt).
- Model/source provenance: [dist/models/dnsmos-manifest.json](models/dnsmos-manifest.json).

`dist/models/sig_bak_ovr.onnx` is the unchanged non-personalized P.835 model.
`dist/mos.mjs` adapts the upstream inference framing and polynomial calibration:
decoding/resampling happens outside the scorer; ONNX runs through browser WASM;
the model hash is verified; per-window predictions are retained; P.808 is omitted;
digital silence is unavailable. The model is not retrained. These upstream
materials and their adapted scoring portions retain CC BY 4.0.

Reference: C. K. A. Reddy, V. Gopal and R. Cutler, *DNSMOS P.835: A Non-Intrusive
Perceptual Objective Speech Quality Metric to Evaluate Noise Suppressors*,
<https://arxiv.org/abs/2110.01763>.

## Browser Whisper tiny conversion and the OpenAI base model

- Conversion/model repository: <https://huggingface.co/Xenova/whisper-tiny>.
- Pinned revision: `5332fcc35e32a33b86612b9a57a89be7906102b1`.
- Selected weights: multilingual q8 encoder and merged decoder ONNX files.
- The pinned conversion model card declares **Apache-2.0**; retain its
  [model card](models/whisper/README.md) and
  [Apache license](models/whisper/LICENSE-APACHE-2.0.txt).
- Original OpenAI Whisper code/model project: <https://github.com/openai/whisper>,
  **MIT**, with the retained [OpenAI license](models/whisper/OPENAI-WHISPER-LICENSE.txt).
- Complete original URLs, sizes, hashes and file-part layout:
  [dist/models/whisper/manifest.json](models/whisper/manifest.json).

The decoder is split into static-host-sized parts. Browser code reassembles it
and verifies parts plus the original full-file checksum; the ONNX model itself
is not retrained or numerically modified. Runtime model caching contains public
assets, not user audio or transcripts. This is a different ASR engine from local
VoiceBench's Whisper small; measurements must not be silently mixed.

## Transformers.js and ONNX Runtime Web

- Transformers.js 3.8.1: <https://github.com/huggingface/transformers.js>,
  **Apache-2.0**, retained at
  [dist/vendor/transformers/TRANSFORMERS-LICENSE.txt](vendor/transformers/TRANSFORMERS-LICENSE.txt).
- ASR runtime bundled with Transformers.js:
  `1.22.0-dev.20250409-89f8206ba4`; DNSMOS uses separate ONNX Runtime Web 1.22.0.
- ONNX Runtime: <https://github.com/microsoft/onnxruntime>, **MIT**;
  [retained license](vendor/transformers/ONNXRUNTIME-LICENSE.txt).

Vendored runtime files retain their upstream copyright/license headers. The
VoiceBench integration configures same-origin model/runtime paths, a manifest
checking cache and single-thread WASM Workers; it does not change runtime/model
licenses. ASR setup and timing details are in [ASR-NOTES.md](ASR-NOTES.md).

## ebur128-wasm loudness and true peak

- Package: `ebur128-wasm` **3.0.0**.
- Upstream: <https://github.com/streamonkey/ebur128_wasm>.
- License: **Apache-2.0**, retained at [dist/vendor/ebur128/LICENSE](vendor/ebur128/LICENSE).
- Files: `dist/vendor/ebur128/ebur128_wasm_bg.js` and
  `dist/vendor/ebur128/ebur128_wasm_bg.wasm`; integration: `dist/loudness.mjs`.

The generated JavaScript glue is modified only to replace its static `.wasm`
import with an explicit instantiated-WASM injection so the static site does not
require a bundler. The remaining generated implementation and WASM binary are
retained. Browser integration provides loudness/true-peak measurements; LRA is
not implemented. The original Apache license remains applicable to the vendored
material and its adapted portions.

## OpenCC text normalization data

`dist/text-metrics.mjs` embeds first-choice traditional-to-simplified dictionary
tables adapted from `opencc-python-reimplemented` 0.1.7 / OpenCC. Attribution:
Yichen Huang and OpenCC contributors; source
<https://github.com/yichen0831/opencc-python>. These data and adapted dictionary
portions retain **Apache-2.0**; the full license and modification notice are
included directly in [dist/text-metrics.mjs](text-metrics.mjs).

## Redistribution

Keep the license files, model manifests, original copyright headers, attribution
and notices of the modifications above with redistributed static bundles.
Public model/runtime downloads are separate from private recording data.
