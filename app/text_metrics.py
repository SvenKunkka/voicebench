"""Reference-independent transcription, followed by deterministic text scoring."""
import re
import unicodedata

from opencc import OpenCC
from rapidfuzz.distance import Levenshtein

_simplifier = OpenCC('t2s')


def normalize(text: str) -> str:
    text = _simplifier.convert(unicodedata.normalize('NFKC', text)).casefold()
    return ''.join(c for c in text if unicodedata.category(c)[0] in ('L', 'N'))


def compare_text(reference: str, hypothesis: str, keywords: list[str]) -> dict:
    ref, hyp = normalize(reference), normalize(hypothesis)
    if not ref:
        raise ValueError('原稿没有可评分的文字。')
    alignment = []
    correct_positions = {}
    counts = {'substitutions': 0, 'deletions': 0, 'insertions': 0, 'correct': 0}
    for op in Levenshtein.opcodes(ref, hyp):
        tag, a, b, c, d = op
        alignment.append({'type': tag, 'reference': ref[a:b], 'recognized': hyp[c:d]})
        if tag == 'equal':
            counts['correct'] += b-a
            correct_positions.update({a+i: c+i for i in range(b-a)})
        elif tag == 'replace':
            counts['substitutions'] += min(b-a, d-c)
            counts['deletions'] += max(0, (b-a)-(d-c))
            counts['insertions'] += max(0, (d-c)-(b-a))
        elif tag == 'delete':
            counts['deletions'] += b-a
        elif tag == 'insert':
            counts['insertions'] += d-c
    errors = counts['substitutions']+counts['deletions']+counts['insertions']
    keyword_results = []
    seen = set()
    for word in keywords:
        key = normalize(word)
        if not key or key in seen:
            continue
        seen.add(key)
        positions = [m.start() for m in re.finditer(re.escape(key), ref)]
        correct = 0
        for start in positions:
            mapped = [correct_positions.get(i) for i in range(start, start+len(key))]
            if None not in mapped and mapped == list(range(mapped[0], mapped[0]+len(key))):
                correct += 1
        keyword_results.append({'term': word, 'occurrences': len(positions), 'correct': correct,
                                'excluded': not positions})
    total = sum(k['occurrences'] for k in keyword_results)
    right = sum(k['correct'] for k in keyword_results)
    return {**counts, 'reference_characters': len(ref), 'recognized_characters': len(hyp),
            'cer': errors/len(ref), 'content_score': max(0, 100*(1-errors/len(ref))),
            'alignment': alignment, 'normalized_reference': ref, 'normalized_hypothesis': hyp,
            'keyword_accuracy': right/total if total else None, 'keywords': keyword_results}
