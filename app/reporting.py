import csv
import html
import io
import math
import statistics
from collections import defaultdict

from .text_metrics import normalize

METHOD = {
    'version': '1.3.1',
    'text': 'NFKC、简体化、忽略大小写、空格及标点；保留字母与数字。不将十五与15自动视为等价。中文按字，英文也按字符评分。',
    'content_score': '有正确原稿时，内容保真分 = max(0, 100 × (1 − CER))。这是自动转写衍生分，不是人类听懂百分比；CER 可超过 100%。未提供原稿时不计分，不将转写当作原稿。',
    'keywords': '按原稿中关键词每次出现的位置与转写对齐核对；不在原稿中的关键词不计分。',
    'grouping': '音质按场景名称分组，可比较不同文案或无原稿的录音，但标注内容及条件限制。字错率只在同一场景、同一非空归一化原稿内比较。同设备重复录音先求均值。',
    'decision': '音质组以 DNSMOS 整体预测均值相差至少 0.1 提示录音质量倾向，不直接判定硬件。原稿组中 CER 至少低 1 个百分点且 DNSMOS 整体至少高 0.1，才提示两项证据方向一致；这些是工程提示阈值，不是统计显著性或产品合格线。',
    'limits': '自动识别和模型预测不能替代人工盲听；无干净参考不计算 STOI、PESQ 或真实声学 SNR。低能量时段不是掉字或静音故障的证明。',
    'timeline': '逐词时间为模型估计。低置信度仅表示模型疑点，不证明对应字词或设备发生故障。声学片段与文字的时间重叠不能证明因果。DNSMOS 9.01 秒窗口只能描述该窗口的质量预测，不能归因到某一个字。',
    'refresh': '更新分析复用本机保留的原始音频；旧结果一直保留到对应录音的新分析成功。更新失败时保留旧结果并标记为上次结果。',
}


def _values(rows, section, key, require_mos=False):
    values = []
    for row in rows:
        part = row.get('result', {}).get(section) or {}
        value = part.get(key)
        if require_mos and not part.get('available'):
            continue
        if isinstance(value, (int, float)) and math.isfinite(value):
            values.append(value)
    return values


def _mean(values):
    return statistics.mean(values) if values else None


def _range(values):
    return (min(values), max(values)) if values else (None, None)


def _device_summary(device, rows):
    cers = _values(rows, 'text', 'cer')
    mos = _values(rows, 'mos', 'overall', True)
    signals = _values(rows, 'mos', 'signal', True)
    backgrounds = _values(rows, 'mos', 'background', True)
    peaks = _values(rows, 'audio', 'true_peak_dbtp')
    cer_min, cer_max = _range(cers)
    mos_min, mos_max = _range(mos)
    return {'device': device, 'n': len(rows), 'cer_n': len(cers), 'cer_mean': _mean(cers),
            'cer_min': cer_min, 'cer_max': cer_max,
            'cer_sd': statistics.stdev(cers) if len(cers) > 1 else None,
            'mos_mean': _mean(mos), 'mos_min': mos_min, 'mos_max': mos_max, 'mos_n': len(mos),
            'signal_mean': _mean(signals), 'background_mean': _mean(backgrounds),
            'signal_min': min(signals) if signals else None, 'signal_max': max(signals) if signals else None,
            'background_min': min(backgrounds) if backgrounds else None, 'background_max': max(backgrounds) if backgrounds else None,
            'lufs_mean': _mean(_values(rows, 'audio', 'integrated_lufs')),
            'rms_mean': _mean(_values(rows, 'audio', 'rms_dbfs')),
            'true_peak_max': max(peaks) if peaks else None,
            'clipping_percent_mean': _mean(_values(rows, 'audio', 'near_full_scale_percent')),
            'keyword_mean': _mean(_values(rows, 'text', 'keyword_accuracy')),
            'content_score': _mean(_values(rows, 'text', 'content_score')),
            'recording_ids': [r['id'] for r in rows]}


def _summaries(recordings):
    devices = defaultdict(list)
    for row in recordings:
        devices[row['device']].append(row)
    return [_device_summary(device, rows) for device, rows in devices.items()]


def _repeat_caveats(summaries):
    caveats = []
    if any(s['n'] < 3 for s in summaries):
        caveats.append('至少一台设备不足 3 次重复；当前是初步比较。')
    if len({s['n'] for s in summaries}) > 1:
        caveats.append('各设备重复次数不一致，均值的不确定程度不同。')
    return caveats


def aggregate(job: dict) -> dict:
    groups = defaultdict(list)
    quality_groups = defaultdict(list)
    for row in job['recordings']:
        if row.get('status') == 'done':
            quality_groups[row['scene']].append(row)
            reference = normalize(row.get('reference') or '')
            text = row.get('result', {}).get('text') or {}
            if reference and text.get('cer') is not None:
                groups[(row['scene'], reference)].append(row)
    comparisons = []
    completed = sum(r.get('status') == 'done' for r in job['recordings'])
    incomplete = completed != len(job['recordings'])
    for (scene, reference), recordings in groups.items():
        summaries = _summaries(recordings)
        summaries.sort(key=lambda s: s['cer_mean'])
        decision = '只有一台设备，暂无同组对照。'
        if len(summaries) > 1:
            best = summaries[0]
            other = summaries[1:]
            complete_mos = all(s['mos_n'] == s['n'] for s in summaries)
            clear_cer = all(s['cer_mean']-best['cer_mean'] >= .01-1e-9 for s in other)
            clear_mos = complete_mos and all(best['mos_mean']-s['mos_mean'] >= .1-1e-9 for s in other)
            if clear_cer and clear_mos:
                decision = f'本组 {best["device"]} 的内容识别和整体质量预测均更优，建议优先盲听验证。'
            elif clear_cer:
                decision = f'本组 {best["device"]} 的识别字错率更低；音质证据未同时领先，不能确定全面更好。'
            else:
                decision = '识别差异不足 1 个百分点，或各项指标各有优劣，暂不判定优胜。'
            if not job.get('conditions_confirmed'):
                decision = '测试条件未确认一致：仅比较这些录音的指标，不能据此判定硬件优劣。'
            elif incomplete:
                decision = '本批仍有失败或未完成录音：以下为部分结果，暂不判定优胜。'
        caveats = _repeat_caveats(summaries)
        comparisons.append({'scene': scene, 'reference_preview': reference[:70], 'reference_hash': __import__('hashlib').sha256(reference.encode()).hexdigest()[:12],
                            'devices': summaries, 'decision': decision, 'caveats': caveats})
    quality_comparisons = []
    for scene, recordings in quality_groups.items():
        summaries = _summaries(recordings)
        summaries.sort(key=lambda s: (s['mos_mean'] is None, -(s['mos_mean'] or 0)))
        references = [normalize(r.get('reference') or '') for r in recordings]
        provided = [r for r in references if r]
        same_reference = len(provided) == len(references) and len(set(provided)) == 1
        if not provided:
            reference_status = 'no_reference'
        elif len(provided) < len(references):
            reference_status = 'mixed_references'
        elif same_reference:
            reference_status = 'same_reference'
        else:
            reference_status = 'different_references'
        if not same_reference:
            # Keep text metrics in their reference-matched groups, never pool unlike scripts.
            for device in summaries:
                for key in ('cer_mean', 'cer_min', 'cer_max', 'cer_sd', 'keyword_mean', 'content_score'):
                    device[key] = None
                device['cer_n'] = 0
        caveats = _repeat_caveats(summaries)
        if reference_status == 'no_reference':
            caveats.append('未提供正确原稿，文案是否一致未校验；不计算字错率，模型分数也可能受讲话内容影响。')
        elif reference_status == 'mixed_references':
            caveats.append('部分录音未提供原稿，内容一致性未校验；字错率仅对有原稿录音单独计算。')
        elif not same_reference:
            caveats.append('本组文案不同；可比较这些录音的音质预测，不应据此直接判定硬件优劣。')
        if not job.get('conditions_confirmed'):
            caveats.append('声源、距离和环境条件未经确认一致，差异不能直接归因于硬件。')
        complete_mos = all(s['mos_n'] == s['n'] for s in summaries)
        decision = '只有一台设备，暂无同场景音质对照。'
        leading_device = None
        if len(summaries) > 1:
            if not complete_mos:
                decision = '部分录音没有有效质量预测；保留已测指标，暂不比较优劣。'
            elif incomplete:
                decision = '本批仍有失败或未完成录音，当前为部分音质结果，暂不比较优劣。'
            else:
                best = summaries[0]
                if all(best['mos_mean']-s['mos_mean'] >= .1-1e-9 for s in summaries[1:]):
                    leading_device = best['device']
                    decision = f'本组 {best["device"]} 的整体质量预测较高，模型倾向这份录音；这不是硬件优胜或人工听懂率结论。'
                else:
                    decision = '整体质量预测差异不足 0.1，暂不提示明确音质倾向。'
        quality_comparisons.append({'scene': scene, 'devices': summaries, 'decision': decision,
                                    'caveats': caveats, 'reference_status': reference_status,
                                    'same_reference': same_reference, 'leading_device': leading_device,
                                    'conditions_confirmed': bool(job.get('conditions_confirmed'))})
    return {'groups': comparisons, 'quality_groups': quality_comparisons, 'completed': completed,
            'failed': sum(r.get('status') == 'failed' for r in job['recordings']),
            'note': '音质按场景比较；字错率只比较相同非空原稿。不同文案或未经控制的录音不生成硬件总排名。'}


def number(value, decimals=2, suffix=''):
    return '未测得' if value is None else f'{value:.{decimals}f}{suffix}'


def timeline_time(value):
    if not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
        return '未定位'
    # Round before splitting, avoiding displays such as 0:60.00.
    centiseconds = round(value*100)
    minutes, remainder = divmod(centiseconds, 6000)
    return f'{minutes}:{remainder/100:05.2f}'


def _evidence_text(value):
    if isinstance(value, (list, tuple)):
        return '；'.join(str(item) for item in value)
    if isinstance(value, dict):
        return __import__('json').dumps(value, ensure_ascii=False)
    return '' if value is None else str(value)


def _word_character_position(word):
    start, end = word.get('char_start'), word.get('char_end')
    if not isinstance(start, int) or not isinstance(end, int):
        return '—'
    return str(start) if start == end else f'{start}～{end}'


def _timeline_html(result):
    esc = lambda value: html.escape(str(value))
    timeline = result.get('timeline')
    parts = ['<h3>带时间的独立转写与模型疑点</h3>',
             '<p>词级与转写片段时间均为模型估计，不是精确采样定位。低置信度仅为模型疑点，不代表对应字词或硬件存在故障。</p>']
    if not timeline:
        parts.append('<p>这份历史结果尚无词级时间线。可使用“更新分析”复用原始录音，补充词级时间与疑似异常定位。</p>')
        segments = result.get('transcription', {}).get('segments') or []
        if segments:
            parts.append('<table><thead><tr><th>模型估计时间</th><th>独立转写片段</th></tr></thead><tbody>')
            for segment in segments:
                parts.append(f'<tr><td>{timeline_time(segment.get("start"))}—{timeline_time(segment.get("end"))}</td><td>{esc(segment.get("text", ""))}</td></tr>')
            parts.append('</tbody></table>')
        return ''.join(parts)
    if not timeline.get('available', True):
        parts.append('<p>本次没有可用的词级定位；请结合完整独立转写、全局提示与原录音回听。</p>')
    words = timeline.get('words') or []
    events = timeline.get('events') or []
    event_map = {str(event.get('id')): event for event in events}
    if words:
        parts.append('<h4>完整词级时间表</h4><table><thead><tr><th>转写字序（不计标点空格）</th><th>模型估计时间</th><th>识别词组</th><th>模型概率</th><th>复核提示</th></tr></thead><tbody>')
        for word in words:
            labels = [event_map[str(event_id)].get('label', event_map[str(event_id)].get('type', '模型疑点'))
                      for event_id in word.get('event_ids', []) if str(event_id) in event_map]
            if word.get('uncertain'):
                labels.append('模型不确定，建议回听；不是故障判断')
            probability = word.get('probability')
            parts.append(f'<tr><td>{esc(_word_character_position(word))}</td><td>{timeline_time(word.get("start"))}—{timeline_time(word.get("end"))}</td><td>{esc(word.get("text", ""))}</td><td>{number(probability, 4)}</td><td>{esc("；".join(labels) or "未标记模型疑点")}</td></tr>')
        parts.append('</tbody></table>')
    else:
        parts.append('<p>未生成词级时间表；不能据此推断音频没有人声。</p>')
    parts.append('<h4>局部疑似异常时间表</h4>')
    if not events:
        parts.append('<p>本次未标出局部疑似异常。这只表示现有检测规则未触发，不证明录音没有问题。</p>')
    else:
        parts.append('<table><thead><tr><th>模型估计时间</th><th>疑点类型</th><th>检测依据</th><th>重叠转写上下文</th><th>定位范围 / 分数影响</th></tr></thead><tbody>')
        for event in events:
            precision = _evidence_text(event.get('precision'))
            impact = event.get('score_impact')
            impact_text = '未计算单字分数影响，不作因果归因' if impact is None else _evidence_text(impact)
            parts.append(f'<tr><td>{timeline_time(event.get("start"))}—{timeline_time(event.get("end"))}</td><td>{esc(event.get("label") or event.get("type") or "模型疑点")}</td><td>{esc(_evidence_text(event.get("evidence")))}</td><td>{esc(_evidence_text(event.get("word_context")))}</td><td>{esc(precision)}<br>{esc(impact_text)}</td></tr>')
        parts.append('</tbody></table>')
    windows = timeline.get('quality_windows') or []
    if windows:
        parts.append('<h4>局部质量预测窗口</h4><p>DNSMOS 使用 9.01 秒窗口。窗口预测覆盖一段声音，不能据此把质量下降归因于某一个字；循环补齐窗口不代表新的真实音频。</p>')
        parts.append('<table><thead><tr><th>窗口时间</th><th>人声预测</th><th>背景预测</th><th>整体预测</th><th>输入范围</th></tr></thead><tbody>')
        for window in windows:
            parts.append(f'<tr><td>{timeline_time(window.get("start"))}—{timeline_time(window.get("end"))}</td><td>{number(window.get("signal"))}</td><td>{number(window.get("background"))}</td><td>{number(window.get("overall"))}</td><td>{"含循环补齐输入" if window.get("repeated_input") else "原始时间范围"}</td></tr>')
        parts.append('</tbody></table>')
    issues = timeline.get('global_issues') or []
    if issues:
        parts.append('<h4>全局提示（不定位到单字）</h4>')
        for issue in issues:
            parts.append(f'<p><strong>{esc(issue.get("label") or issue.get("type") or "全局模型疑点")}</strong>：{esc(_evidence_text(issue.get("evidence")))}</p>')
    limitations = timeline.get('limitations') or []
    parts.append('<h4>定位边界</h4><p>时间重叠只用于帮助回听，不证明疑似异常导致该词识别错误。未提供正确原稿时不能判定漏字或实际说错。</p>')
    parts.extend('<p>'+esc(_evidence_text(item))+'</p>' for item in limitations)
    if timeline.get('timestamp_source'):
        parts.append('<p>时间来源：'+esc(_evidence_text(timeline['timestamp_source']))+'</p>')
    return ''.join(parts)


def export_html(job):
    esc = lambda x: html.escape(str(x))
    summary = aggregate(job)
    body = [f'<h1>{esc(job["title"])}</h1><p>收音对比报告 · {esc(job["created_at"])} · 方法 {METHOD["version"]}</p>',
            f'<p>{summary["completed"]} 份完成，{summary["failed"]} 份失败；共 {len(job["recordings"])} 份。</p>',
            '<p><strong>范围：</strong>自动识别与模型预测结果；未经人工盲听，不等同于人的听懂率。条件一致确认：'+('是' if job.get('conditions_confirmed') else '否')+'。</p>']
    for group in summary['quality_groups']:
        body += [f'<h2>音质对比：{esc(group["scene"])}</h2>', f'<p>{esc(group["decision"])}</p>',
                 '<table><thead><tr><th>设备</th><th>次数</th><th>人声预测↑</th><th>背景预测↑</th><th>整体预测↑</th><th>整体范围</th><th>响度 LUFS</th><th>RMS dBFS</th></tr></thead><tbody>']
        for d in group['devices']:
            body.append(f'<tr><td>{esc(d["device"])}</td><td>{d["n"]}</td><td>{number(d["signal_mean"])}</td><td>{number(d["background_mean"])}</td><td>{number(d["mos_mean"])}</td><td>{number(d["mos_min"])}～{number(d["mos_max"])}</td><td>{number(d["lufs_mean"], 1)}</td><td>{number(d["rms_mean"], 1)}</td></tr>')
        body += ['</tbody></table>']+[f'<p>{esc(c)}</p>' for c in group['caveats']]
    for group in summary['groups']:
        body += [f'<h2>内容识别：{esc(group["scene"])} <small>原稿 {group["reference_hash"]}</small></h2>', f'<p>{esc(group["decision"])}</p>',
                 '<table><thead><tr><th>设备</th><th>次数</th><th>CER 均值↓</th><th>CER 范围</th><th>关键词正确率↑</th><th>DNSMOS 整体↑</th></tr></thead><tbody>']
        for d in group['devices']:
            body.append(f'<tr><td>{esc(d["device"])}</td><td>{d["n"]}</td><td>{d["cer_mean"]*100:.2f}%</td><td>{d["cer_min"]*100:.2f}%～{d["cer_max"]*100:.2f}%</td><td>{number(d["keyword_mean"]*100 if d["keyword_mean"] is not None else None, 1, "%")}</td><td>{number(d["mos_mean"])}</td></tr>')
        body += ['</tbody></table>']+[f'<p>{esc(c)}</p>' for c in group['caveats']]
    for row in job['recordings']:
        body.append(f'<h2>{esc(row["device"])} / {esc(row["filename"])}</h2><p>场景：{esc(row["scene"])}；状态：{esc(row["status"])}</p>')
        if row.get('status') != 'done' and not row.get('result'):
            body.append(f'<p>{esc(row.get("error", "未完成"))}</p>')
            continue
        if row.get('status') != 'done' or row.get('result_stale'):
            body.append('<p><strong>当前显示上次成功结果。</strong>更新分析尚未成功；以下不是本轮新分析结果。'+esc(row.get('error') or '')+'</p>')
        result = row['result']; audio, text, mos = result['audio'], result.get('text') or {}, result['mos']
        if text.get('cer') is not None:
            body.append(f'<p>内容保真分 {number(text.get("content_score"), 1)}/100；CER {number(text["cer"]*100, 2, "%")}；替换 {text["substitutions"]}／漏字 {text["deletions"]}／多字 {text["insertions"]}。</p>')
        else:
            body.append('<p>未提供正确原稿：内容保真分、CER、关键词正确率均为未测。以下转写仅供内容辨认，未用作标准答案。</p>')
        body.append(f'<p>DNSMOS 人声 {number(mos.get("signal"))}，背景 {number(mos.get("background"))}，整体 {number(mos.get("overall"))}；响度 {number(audio.get("integrated_lufs"), 1, " LUFS")}；真峰值 {number(audio.get("true_peak_dbtp"), 1, " dBTP")}；接近满刻度采样 {audio["near_full_scale_percent"]:.4f}%。</p>')
        body.append('<h3>原稿</h3><p class="text">'+esc(row.get('reference') or '未提供原稿')+'</p><h3>独立转写</h3><p class="text">'+esc(result['transcription']['text'])+'</p>')
        if text.get('cer') is not None:
            body.append('<h3>逐字对照</h3><p class="diff">')
            for diff in text.get('alignment', []):
                if diff['type'] == 'equal':
                    body.append(esc(diff['reference']))
                else:
                    body.append('<del>'+esc(diff['reference'])+'</del><ins>'+esc(diff['recognized'])+'</ins>')
            body.append('</p>')
        body.append('<p>'+esc('；'.join(result.get('warnings', [])))+'</p>')
        if text.get('keywords'):
            body.append('<p>关键词：'+esc('；'.join(f'{k["term"]}：'+('原稿无此词，不计分' if k['excluded'] else f'{k["correct"]}/{k["occurrences"]}') for k in text['keywords']))+'</p>')
        body.append(_timeline_html(result))
        body.append('<details><summary>可追溯信息</summary><pre>'+esc(__import__('json').dumps(result.get('provenance', {}), ensure_ascii=False, indent=2))+'</pre></details>')
    body.append('<h2>评分方法与边界</h2>')
    body += [f'<p><strong>{esc(k)}</strong>：{esc(v)}</p>' for k, v in METHOD.items()]
    body.append('<p>DNSMOS：Microsoft DNS-Challenge，CC BY 4.0，采用非个性化 P.835 模型及上游校准系数。模型来源与校验值随结果保存。Whisper：OpenAI，MIT。</p>')
    return '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+esc(job['title'])+'</title><style>body{font:16px/1.7 system-ui,sans-serif;color:#17344a;max-width:1100px;margin:48px auto;padding:0 24px}h1{font-size:32px}h2{margin-top:36px}small{font-size:12px;color:#627681}table{border-collapse:collapse;width:100%;font-size:14px}th,td{padding:12px;text-align:left;border-bottom:1px solid #dce4e8}th{background:#edf4f6}p.text{white-space:pre-wrap}del{background:#ffe0dc;color:#912e21}ins{background:#d6eee7;color:#14604e;text-decoration:none}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}@media print{body{margin:0;font-size:12px}h2{break-after:avoid}tr{break-inside:avoid}}</style><body>'+''.join(body)+'</body></html>'


def export_csv(job):
    buffer = io.StringIO(newline='')
    writer = csv.writer(buffer)
    writer.writerow(['设备','场景','文件','状态','内容保真分','CER百分比','关键词正确率百分比','DNSMOS人声','DNSMOS背景','DNSMOS整体','响度LUFS','真峰值dBTP','疑似削波采样百分比','原稿','转写','错误','原稿状态'])
    def safe(value):
        if isinstance(value, str) and value.lstrip().startswith(('=', '+', '-', '@', '\t', '\r')):
            return "'"+value
        return value
    for row in job['recordings']:
        r = row.get('result') or {}; t = r.get('text') or {}; m = r.get('mos') or {}; a = r.get('audio') or {}
        writer.writerow([safe(v) for v in [row['device'], row['scene'], row['filename'], row['status'], t.get('content_score') if t.get('content_score') is not None else '未测',
                        t['cer']*100 if t.get('cer') is not None else '未测', t['keyword_accuracy']*100 if t.get('keyword_accuracy') is not None else '未测',
                        m.get('signal'), m.get('background'), m.get('overall'), a.get('integrated_lufs'), a.get('true_peak_dbtp'),
                        a.get('near_full_scale_percent'), row.get('reference') or '', r.get('transcription', {}).get('text'), row.get('error'),
                        '已提供原稿' if (row.get('reference') or '').strip() else '未提供原稿']])
    return '\ufeff'+buffer.getvalue()


def export_timeline_csv(job):
    """Machine-readable localization evidence; no inferred word-level causal score."""
    buffer = io.StringIO(newline='')
    writer = csv.writer(buffer)
    writer.writerow(['recording', 'device', 'start', 'end', 'type', 'evidence', 'context', 'precision', 'score_impact'])
    def write(row, start, end, kind, evidence, context='', precision='', impact=None):
        if row.get('result_stale') or row.get('status') != 'done':
            precision = '上次成功结果；'+_evidence_text(precision)
        values = [row.get('filename', row['id']), row['device'], start, end, kind,
                  _evidence_text(evidence), _evidence_text(context), _evidence_text(precision),
                  '未计算单字分数影响' if impact is None else _evidence_text(impact)]
        writer.writerow(["'"+value if isinstance(value, str) and value.lstrip().startswith(('=', '+', '-', '@', '\t', '\r')) else value
                         for value in values])
    for row in job['recordings']:
        result = row.get('result') or {}
        timeline = result.get('timeline')
        if not timeline:
            write(row, '', '', '历史结果无词级时间线', '可使用更新分析补充；原结果保留。')
            continue
        for word in timeline.get('words') or []:
            write(row, word.get('start'), word.get('end'), '模型不确定词组' if word.get('uncertain') else '模型估计词组',
                  {'probability': word.get('probability'), 'event_ids': word.get('event_ids') or [],
                   'char_start': word.get('char_start'), 'char_end': word.get('char_end')},
                  word.get('text', ''), '模型时间估计，非精确采样定位')
        for event in timeline.get('events') or []:
            write(row, event.get('start'), event.get('end'), event.get('label') or event.get('type') or '模型疑点',
                  event.get('evidence'), event.get('word_context'), event.get('precision'), event.get('score_impact'))
        if not timeline.get('events'):
            write(row, '', '', '未标出局部疑似异常', '现有规则未触发，不证明录音没有问题。')
        for window in timeline.get('quality_windows') or []:
            write(row, window.get('start'), window.get('end'), '9.01秒质量预测窗口',
                  {key: window.get(key) for key in ('signal', 'background', 'overall', 'repeated_input')},
                  precision='窗口质量不能归因单字')
        for issue in timeline.get('global_issues') or []:
            write(row, '', '', issue.get('label') or issue.get('type') or '全局模型疑点', issue.get('evidence'), precision='全局，非单字定位')
    return '\ufeff'+buffer.getvalue()
