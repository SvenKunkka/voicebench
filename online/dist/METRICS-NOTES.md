# 浏览器测量与文字对照说明

本文件说明 `dist/audio-metrics.mjs`、`dist/text-metrics.mjs` 和 `dist/timeline.mjs`。这三项在用户浏览器内计算，不调用付费 API，不把录音或正确原稿发送给第三方。其他模块下载模型、缓存及发布行为由主应用负责。原本的本机 VoiceBench 源码和录音数据没有被这次移植修改。

## 模块接口

```js
await inspectAudio(file /* Blob/File */, channel = 'first')
// {audio, samples: Float32Array /* 16 kHz mono */, original: Blob, matched: Blob}

normalize(text)
compareText(reference, hypothesis, keywords = [])
// 同本机 result.text 字段；增加 available；无原稿时评分字段为 null。

buildTimeline(samples, sampleRate, transcription, audioMetrics, mos)
// words/events/quality_windows/energy_envelope/uncertain_words/global_issues/
// limitations/heuristics/summary 等，与本机时间轴兼容。
```

`original` 是保持原电平的 **16 kHz、单声道、PCM16 分析试听副本**，不是上传原文件的逐字节副本。`matched` 是固定增益的试听副本；原上传 Blob 不会被覆盖。传入正确原稿仅用于识别后的对照，不能作为语音识别提示词。

## 音频指标

- 标准 little-endian RIFF/WAVE 原生读取 PCM8/16/24/32 和 IEEE float32/64，支持普通格式块及 WAVEFORMATEXTENSIBLE 的 PCM/float 子格式。采样峰、RMS、连续接近满刻度及声道选择均在源采样率计算。原生解码后 `native_rate_preserved: true`，`source_sample_rate` 是文件声明采样率。
- 其他浏览器支持的格式使用 Web Audio `decodeAudioData`。浏览器可能在解码时重采样，因此 `source_sample_rate: null`、`native_rate_preserved: false`，并显式提醒：采样峰/疑似削波检查描述解码后数据，不能证明压缩前原采样率、原始失真或设备性能。不支持的格式明确报错，不猜测。
- 单份文件限制为 100 MiB、10 分钟、8 声道、192 kHz、解码后合计 60,000,000 个采样值。空文件、不完整 WAV 帧及 NaN/Infinity 采样明确失败。
- 近满刻度阈值是 `abs(sample) >= 0.999`；连续至少 3 个采样列为疑似削波，仍需回听。统计不是模拟电路失真的完整检测器。事件展示最多 100 组，百分比仍按全部采样计算。
- 先选择第一/第二声道或平均混合，再生成 16 kHz 分析样本。浏览器使用 OfflineAudioContext 带限重采样；无该接口的测试/兼容环境用窗函数 sinc FIR（1024 相位量化）。不是简单抽点或线性插值。混合可能发生反相抵消，会给出提示。
- 低能量比例使用 16 kHz 分析副本的 20 ms RMS 帧，绝对阈值 −50 dBFS；连续至少 0.5 秒列出区间。这不是 VAD、静噪测量、掉字率或听懂率。
- 频谱使用 1024 点周期 Hann 窗、50% 重叠和单边 PSD 平均，再汇成 80–7900 Hz 的 64 个对数频带。它描述录音文件，不代表麦克风频率响应。波形显示至多 400 个峰值桶。
- 试听匹配固定增益目标为 −23 dBFS RMS，峰值留到 0.95；峰值约束可能使 RMS 达不到目标。它不是 LUFS 等响、动态压缩或降噪。原生浮点样本大于满刻度时，PCM16 副本需要限幅，界面会提示；原采样测量仍使用未限幅数据。

## LUFS、真峰值及 LRA

`audio-metrics.mjs` 调用主应用的 `loudness.mjs`，向它传入所选的原采样率单声道 Float32 数据。该模块使用自托管 `ebur128-wasm` **3.0.0**（Rust ebur128，Apache-2.0），计算 BS.1770/R128 整体响度及插值真峰值。WASM 未就绪/加载失败时两项为 null 并附原因；绝不把采样峰当真峰值。

LRA 当前 **未计算，始终为 null**。显示“未测”优于用峰均比或其它量冒充。

专项测试真实加载同一 WASM，与 FFmpeg `loudnorm` 的输入统计比较：48 kHz、10 秒、440 Hz、幅度 0.1 的 PCM16 正弦，WASM − FFmpeg 为 **+0.0569 LU、+0.0077 dBTP**。这是一个合成基准的验证，不是所有频率/时长/格式/浏览器的完整认证，也不等于声学声压校准。主任务另外保留真实浏览器的语音基准测量记录。

来源：

- [ebur128-wasm 3.0.0](https://www.npmjs.com/package/ebur128-wasm/v/3.0.0)
- [Rust ebur128](https://github.com/sdroege/ebur128)
- [FFmpeg 音频滤镜文档](https://ffmpeg.org/ffmpeg-filters.html)
- [Web Audio decodeAudioData](https://developer.mozilla.org/en-US/docs/Web/API/BaseAudioContext/decodeAudioData)

## 文字与关键词评分

- NFKC 全半角兼容规范化，OpenCC t2s 繁转简，Unicode 大小写折叠，仅保留 Unicode 字母与数字。数字“十五”不会自动当成“15”，专名也不凭上下文修正。
- 为避免网络依赖，模块嵌入与本机 `opencc-python-reimplemented 0.1.7` 相同的 TSPhrases/TSCharacters 字典，使用最长词组优先、字表转换只作用于未匹配字的逻辑；多候选映射取第一项。字序和编辑距离按 Unicode code point，不按 UTF-16 码元。
- 精确 Levenshtein 最小编辑距离；CER = (替换 + 删除 + 插入)/原稿计分字数，可超过 100%。换算内容分 = max(0,100×(1−CER))，不是人工听懂率。
- 计算保存一个 Uint8 编辑方向矩阵和两行 Uint16 距离，上限每边 **5000 个计分字符**，最多约 25 MB 方向矩阵，不使用 20000² 的全分值矩阵。超出上限明确要求分段，不偷偷近似。
- 多种同样最短路径存在时，本实现优先替换、再删除、再插入；最小 CER 保持精确。等价路径的逐字对齐或重复词的归属可能与 RapidFuzz 的 tie-break 不同，不能据此声称某个歧义字必然被录坏。
- 关键词必须出现在原稿内，并沿当前最短编辑对齐映射到连续正确位置；不因同词出现在别处而给分。原稿中非重叠出现次数与本机规则相同。未出现在原稿的词列为 excluded。
- 没有原稿（空值/空白）时 `available:false`，CER、内容分、关键词正确率和编辑数为 null；转写不充当正确原稿。非空但仅标点的原稿报错。

字典及许可来源：

- [OpenCC Python — Yichen Huang 及贡献者](https://github.com/yichen0831/opencc-python)，包版本 0.1.7，Apache License 2.0。
- [OpenCC — BYVoid 及贡献者](https://github.com/BYVoid/OpenCC)，Apache License 2.0。
- `text-metrics.mjs` 保留 Apache-2.0 许可证全文及嵌入数据改编说明。表是随模块分发的数据，不要求在用户浏览器访问 Python 或 CDN。

## 时间轴解释

- 仅使用 ASR 实际提供的 `words[].start/end` 或 `segments[].words`，保留多字词组的共同区间，不均分出假单字时间。字序从 1 开始计 Unicode 字母/数字，标点和空格不计。
- 事件的 `word_indices` 是 `words[].index` 的 0-based 索引；`score_impact` 始终 null，`audio_faults_confirmed` 始终空数组。候选有时间和证据，不宣称已证实故障或每字扣多少分。
- 能量帧为 40 ms；词内电平候选需相对局部基线/两侧 200 ms 中位值至少下降 12 dB、持续 80–600 ms、下降/恢复各至少 6 dB，并且有一个实际 ASR 词组跨过整个区间。普通词间停顿不作为该类故障候选。
- 短峰候选需超过局部峰值中位数 20 dB、整段第 95 百分位至少 6 dB，且不超过 120 ms；仍可能是正常重音/爆破音，需回听。
- ASR probability <0.45 只放在 `uncertain_words`，不会归为收音故障。
- 质量窗口仅映射输入 DNSMOS 的实际 **9.01 秒**窗口。短录音重复补齐只给真实全段粗参考；至少 3 个不同真实窗口且分差 ≥0.3 才允许相对低质量提示。不是逐秒或逐字 MOS，更不能因果分摊总分。
- 整段低于 −30 LUFS 只是全局回听提示，不是设备合格线；没有 LUFS 时不伪造该项。无异常候选不等于音质合格。

DNSMOS 相关来源归属：Microsoft DNS-Challenge / DNSMOS P.835，模型与相关代码按其 **Creative Commons Attribution 4.0 (CC BY 4.0)** 归属要求保留，来源 [Microsoft DNS-Challenge](https://github.com/microsoft/DNS-Challenge/tree/master/DNSMOS)。本时间轴模块只接收主应用 `mos.mjs` 的分数，不包含其 ONNX 权重，也不重新训练模型。上游质量预测、ASR 和本工具工程启发式均不能代替人工盲听或固定条件硬件验证。

## 已执行专项检查

```sh
node tests/metrics-text.mjs
node tests/metrics-audio.mjs
node tests/metrics-timeline.mjs
```

覆盖原采样格式、电平/削波/声道/静音、试听 WAV、抗混叠、Web Audio 来源说明、异常/边界、WASM 对 FFmpeg，中文/Unicode/CER/位置关键词与独立最小距离 oracle，正常停顿/真实词内突降/削波映射/短 MOS/时间边界及 JSON 有限数值。测试使用合成或只读已有测试材料，没有访问或修改用户正式浏览器录音库。
