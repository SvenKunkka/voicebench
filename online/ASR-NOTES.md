# 浏览器语音识别与字词时间 / Browser ASR and timing

本模块在 Web Worker 内运行 Whisper tiny q8。录音以 16 kHz 单声道 Float32Array 传入，不调用远程识别 API，也不把录音、原稿或转写结果上传。模型与运行时均随本站静态资源提供；浏览器首次仍需下载这些资源，随后可复用浏览器模型缓存。清除浏览器数据、缓存被回收或使用其他浏览器时，需要重新下载。

This module runs Whisper tiny q8 inside a Web Worker. Audio is passed as a 16 kHz mono Float32Array. No remote transcription API is called, and no audio, reference transcript, or recognition result is uploaded. All model/runtime assets are hosted with the site. The first use requires asset downloads; browser model cache is reused when available.

## 固定组件 / Pinned components

| 项目 / Item | 固定值 / Pinned value |
|---|---|
| Transformers.js | 3.8.1 |
| ONNX WASM runtime bundled by Transformers.js | 1.22.0-dev.20250409-89f8206ba4 |
| Model | Xenova/whisper-tiny, multilingual, q8 |
| Model revision | `5332fcc35e32a33b86612b9a57a89be7906102b1` |
| Model weight bytes | 40,852,675 bytes, approximately 39 MiB |
| Estimated initial ASR transfer | Approximately 64 MiB including tokenizers, runtime, and weights; HTTP compression/cache may change actual transfer |
| Execution | WASM, one thread, no GPU requirement, Worker |
| Generation | Greedy (`do_sample=false`), `max_new_tokens=448` per chunk, language zh/en/auto |
| Chunking | 30 seconds, 5-second stride |
| Requested timestamps | `return_timestamps:'word'` |

浏览器版本使用 tiny；桌面工具使用 small，识别能力、解码设置与结果均不同。不可把两个版本的识别字错率直接混在一起作为设备排名。浏览器版首次中文合成语音实测也出现错字，因此自动转写仍需人工核对。

The browser tiny model differs from desktop Whisper small in model capability and decoding. Do not mix CER measurements across these engines to rank devices. Actual Chinese testing produced recognition errors even on a clean synthetic fixture; the transcript requires review.

## API

```js
import {transcribe, resetASR, ASR_INFO} from './asr.mjs';
const result = await transcribe(samples16kMono, 'zh', message => updateProgress(message));
// result: {text, segments, words, engine, version, settings, timing_note}
```

Each word entry is `{text,start,end,probability:null}`. A Chinese entry can be a character, word, or phrase. The exported times are actual model alignment outputs, bounded by physical audio duration. Zero-duration outputs are retained rather than expanded artificially. No equal subdivision of text is used. The browser pipeline does not supply word confidence, so probability remains null.

Only model chunks with finite, ordered timestamps are included in localization. `settings.missing_timing_chunks` records omitted chunks. If word alignment is unsupported, the pipeline retries with actual segment timestamps and returns `words:[]`, `settings.timing_level:'segment'`. If no valid timing exists, timing level is `unavailable`; no timestamps are manufactured.

语言参数仅支持 `zh`、`en`、`auto`。调用方负责正确解码、选择声道及重采样为16 kHz；本模块不猜测输入采样率。每份最多10分钟，这只是输入保护，不代表所有手机或电脑都能流畅处理长录音。长录音、英语与自动语言检测尚未做端到端性能验证。

The caller must decode/select the channel/resample to 16 kHz. Supported language inputs are zh/en/auto. The 10-minute input limit is a guard, not a performance guarantee. Long recordings, English, and automatic language detection have not received end-to-end performance validation.

## 自托管与完整性 / Self-hosting and integrity

- `dist/vendor/transformers/`: pinned ESM bundle, matching WASM module/binary, and licenses. This runtime is independent from the DNSMOS runtime.
- `dist/models/whisper/manifest.json`: source URLs, byte counts, SHA-256 values, fixed revision, and the ordered list of file parts.
- The decoder ONNX file exceeds a 25 MiB single-asset limit. It is split into 20 MiB and approximately 9.3 MiB parts. The original full-file SHA-256 matches upstream LFS metadata.
- `env.customCache` maps the model's virtual same-origin URLs to local manifest parts. Every part and the assembled file are SHA-256 checked before inference. No request to Hugging Face or a runtime CDN is required at execution time.
- CacheStorage is an optimization. If persistent cache is unavailable/full, the current inference can continue from downloaded assets. Download failure/checksum failure surfaces an error; a new attempt creates a fresh Worker and can reuse valid cache entries.
- Model cache contains public model data, never user recordings or transcripts. The separate recording library is managed by the parent application.

## 真实验证 / Actual validation

The browser checks used a 12.6-second synthetic Mandarin recording, not a hardware measurement or private user recording. Local audio fixtures and browser proof files are intentionally excluded from the public source.

1. Actual Chrome/WASM transcription via the initially pinned CDN: 46 actual word/phrase units, approximately 22.40 seconds including first model/runtime downloads. Local proof was retained outside the public source.
2. Actual Chrome/WASM with all external origins blocked, local model cache cleared: 46 actual units, approximately 2.16 seconds on the development Mac. All 16 observed network requests were same-origin GETs; no external request or upload occurred. Local proof was retained outside the public source.
3. This local static-server timing is an observed development result, not a promised speed on public hosting or user devices. Only model cache was explicitly cleared; this was not a fresh OS/browser installation.
4. Unit checks cover timestamp preservation, segment-only fallback, invalid timestamp omission, physical-duration bounds, input validation, request/progress forwarding, retry Worker replacement, and integrity/size of all vendored files.

```sh
node --test tests/asr-*.test.mjs
```

The development browser proof used the Playwright CLI, a local static server and a separate browser context. These local proof scripts and fixtures are not included in the public source or the published product UI.

## 来源与许可 / Sources and licenses

- [Transformers.js 3.8.1 ASR pipeline API](https://huggingface.co/docs/transformers.js/v3.8.1/api/pipelines): word/segment timestamps, languages, chunking. Apache-2.0; license retained at `dist/vendor/transformers/TRANSFORMERS-LICENSE.txt`.
- [Xenova/whisper-tiny model card](https://huggingface.co/Xenova/whisper-tiny): ONNX conversion of OpenAI Whisper tiny; model repository metadata identifies Apache-2.0. Full Apache license retained with model assets.
- [Pinned model files](https://huggingface.co/Xenova/whisper-tiny/tree/5332fcc35e32a33b86612b9a57a89be7906102b1): q8 ONNX weights and tokenizer/configuration source.
- [OpenAI Whisper](https://github.com/openai/whisper): original code/model weights released under MIT; original v20250625 license retained at `dist/models/whisper/OPENAI-WHISPER-LICENSE.txt`.
- [ONNX Runtime license](https://github.com/microsoft/onnxruntime/blob/v1.22.0/LICENSE): MIT license retained at `dist/vendor/transformers/ONNXRUNTIME-LICENSE.txt`.

The manifest records redistribution origins and hashes. Retain license files and this attribution when redistributing the static model/runtime bundle.
