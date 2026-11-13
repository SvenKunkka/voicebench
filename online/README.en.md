# VoiceBench Online

[中文说明](README.md) · [Third-party notices](THIRD_PARTY_NOTICES.md) · [ASR and timing notes](ASR-NOTES.md)

`online-1.0.0` is an independent HTTPS browser workspace for recording, a local
recording library, microphone selection, transcription, quality prediction and
report export. Processing runs in the current browser, without a Python server,
FFmpeg installation, desktop app or hosted speech API key.

**Live site: [Open VoiceBench Online](https://voicebench-online.yujianxi0.chatgpt.site).**
The public deployment was verified in a fresh browser context without account
sign-in, including transcription, DNSMOS, loudness, saved-result reload and report
download. The original local VoiceBench edition and its data remain separate.

## Workflow

1. Open the HTTPS page in a modern browser. Grant microphone permission, keep
   browser-default input or choose a specific recording device. Refresh the list
   after connecting hardware and check the **actual input** track label.
2. Record, stop and wait for the library to confirm a successful save. Send the
   current take or selected history to analysis within the same page, without a
   download-and-reimport step; importing existing audio is also supported.
3. Label devices, scenarios and conditions. Verified reference text and keywords
   are optional. Different references are not pooled into one CER ranking.
4. On first analysis, allow public model/runtime assets to download and follow
   the progress. Wait for transcription, DNSMOS, audio metrics and localization.
5. Export standalone HTML, score CSV, localization CSV or complete JSON. Reports
   include independent transcription, reference text, evidence, precision limits
   and model provenance. HTML does not embed recordings; preserve WAVs separately.

Specific selections request an exact device ID; the default option does not pin
one. Selection is kept in page memory. Failure or unavailable hardware is
reported without silently choosing another microphone. Selection is disabled
while connecting, recording, stopping or saving. Refreshing devices does not
replace library originals or an unsaved WAV.

Capture supports at most 30 minutes per take. Analysis accepts up to 10 minutes
and 100 MB per recording, 20 recordings and 500 MB per batch. Split oversized
inputs first. These guards are not a promise that long recordings run smoothly
on every phone or computer; start with a 15–60 second sample.

## Differences from the local application

| Item | Browser edition | Original local edition |
| --- | --- | --- |
| ASR | Multilingual `Xenova/whisper-tiny`, q8, browser WASM | OpenAI Whisper small, local Python/CPU |
| Execution | Current page and its Workers | Local background service |
| Closing or reloading the page | Interrupts capture and unfinished analysis | Previously submitted analysis can continue in the service |
| Data | This origin and browser profile's local storage | Local directories and the original browser-library origin |
| Decoding | Browser codecs and WebAudio capabilities | FFmpeg-supported formats |

**Do not mix CER, content scores or rankings from these different ASR engines.**
Tiny is smaller and does not offer identical recognition behavior to small.
Recognition errors can occur on clean speech. An independent transcript is never
its own verified ground truth.

## Models, downloads and cache

ASR is pinned to `Xenova/whisper-tiny` revision
`5332fcc35e32a33b86612b9a57a89be7906102b1`, with Transformers.js 3.8.1 and a WASM
Worker. Quantized weights are approximately 39 MiB; the initial ASR bundle is
approximately 64 MiB including tokenizer/configuration and runtime assets.
Compression and caching affect actual transfer. DNSMOS and loudness analysis
have additional model/WASM assets.

Model/runtime files are served with the site. The ASR manifest records origins,
sizes and SHA-256 values; model parts and assembled files are checked before
inference. Valid public model cache is reused when available. Clearing site data,
cache eviction, another browser/profile or insufficient quota can require new
downloads. Cache availability does not guarantee fully offline cold starts.

Audio is passed to ASR as 16 kHz mono samples, not to a remote speech API.
Downloading and inference are separate stages. Keep the page open during work:
closing, reloading or browser termination interrupts unfinished tasks and does
not create a server-side background queue. On reopening, rely only on data the
browser has already saved successfully.

## Measurements and localization limits

- CER compares normalized characters and may exceed 100%. Content score is
  `max(0,100*(1-CER))`, not a human comprehension percentage. Without a verified
  reference, CER/content/keyword scores stay unavailable rather than zero.
- Quality groups use matching scenarios; reference-based comparisons also require
  identical non-empty normalized text. Repeats are averaged per device with
  ranges. Different scripts, uncontrolled conditions and small samples do not
  establish hardware superiority.
- DNSMOS P.835 predicts speech/background/overall quality using 9.01-second
  windows and a one-second stride. Short inputs repeat according to upstream
  framing and are marked. Window scores cannot be causally assigned to a word.
- Word/group times preserve real model alignment. No equal character subdivision
  is invented. If word alignment is unavailable, only usable segment times are
  retained. Missing word confidence remains unavailable.
- Signal candidates are prompts for listening, not proof of a capture fault;
  absence of a candidate is not proof of flawless audio. Reference errors,
  pronunciation, proper names and model limitations can affect recognition.
- Loudness and true peak use browser `ebur128-wasm`. Unavailable metrics remain
  unavailable; LRA is not implemented. A file spectrum is not calibrated
  microphone response. No acoustic SNR or human intelligibility is fabricated.

WAV is the primary validated decoding path. Other formats depend on built-in
browser codecs. WebAudio may resample, mix channels or reject formats. Inspect
the source/analysis sample-rate and channel notes; decoded browser output is not
claimed as bit-identical original sampling. Re-export unsupported inputs as
standard PCM WAV and retry.

## Data, origins and persistence

Microphone takes, imported files, references and results are processed and stored
in the current browser. Hosting provides page/public model assets, not an audio
analysis upload service. Exported reports may contain private transcripts;
review them before sharing.

Browser data is isolated by **origin and profile**. This HTTPS site, the old
`127.0.0.1:8771` recorder, the `8767` analysis address, another domain or another
browser/profile do not automatically share recordings. Retaining the
`vibe-personal-recordings` database name does not migrate data across origins.
Users can explicitly export a WAV at the original local address and import it
here; the page cannot read local `data/jobs/` directly.

Clearing site data, private browsing, storage eviction or reinstalling a browser
can make local data unavailable. A successful save confirms a browser write and
verification, not a cloud backup. Export important recordings and reports. Keep
navigation protection active for a recording or unsaved only copy; closing the
page is not an automatic-save workflow.

## Development and verification

`dist/` contains deployable static pages, modules, public models and license
resources; `tests/` is development material, not a user library. Serve ES modules,
WASM and model files through a web server and use HTTPS for public deployment.
Opening HTML through `file://` is not a supported microphone/Worker setup.

```sh
node --test tests/*.mjs
node --check dist/reporting.mjs
```

Reporting tests cover scenario/reference groups, repeat statistics, missing
values, job-state guards, SHA-256 reference identifiers, export completeness and
HTML/CSV injection defenses. [ASR-NOTES.md](ASR-NOTES.md) describes separate model
and resource verification. Synthetic speech, simulated devices and a development
machine's timings do not establish physical hardware performance or guarantee
phone, long-recording or public-hosting performance.

## Attribution

The Vibe Recorder adaptation retains MIT; DNSMOS assets and adapted inference
retain CC BY 4.0. Xenova's conversion model card declares Apache-2.0; the OpenAI
Whisper base project retains MIT. Transformers.js is Apache-2.0, ONNX Runtime is
MIT and `ebur128-wasm` is Apache-2.0. Original third-party licenses remain
applicable; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Browser analysis uses a single-tab writer lock; other tabs can read results. Close the original analysis tab and reload another tab to transfer ownership. References are limited to 5,000 characters per recording.

## Running and hosting independently

Run `python3 -m http.server 8080 --bind 127.0.0.1 --directory dist` in this directory and open `http://127.0.0.1:8080`. For production, deploy the complete `dist/` directory to a static HTTPS host with ES modules, Workers and WASM support. There is no build step, backend or API key. Include all model parts and licenses; uploading only HTML is insufficient. Each asset is below 25 MiB.

Development checks use Node.js 24 or newer and FFmpeg for audio comparisons; end users need neither. `node --test tests/*.mjs` runs 30 checks. Hosting account identity, recordings, test audio and browser data are excluded from the public source.
