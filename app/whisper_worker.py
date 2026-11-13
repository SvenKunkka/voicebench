"""One local model per worker, no reference text is ever sent to ASR."""
import json
import sys
from contextlib import redirect_stdout
from pathlib import Path

import torch
import whisper

torch.set_num_threads(4)
model_path = Path.home()/'.cache/whisper/small.pt'
with redirect_stdout(sys.stderr):
    model = whisper.load_model(str(model_path), device='cpu')

for line in sys.stdin:
    try:
        request = json.loads(line)
        language = request['language'] if request['language'] != 'auto' else None
        with redirect_stdout(sys.stderr):
            result = model.transcribe(request['path'], language=language, task='transcribe',
                                      fp16=False, temperature=0, beam_size=5,
                                      condition_on_previous_text=False, word_timestamps=True,
                                      verbose=None)
        # Use Whisper's alignment output directly. Chinese timing units may be a
        # character, a word or a short phrase; never invent evenly spaced letters.
        segments = []
        words = []
        for segment in result['segments']:
            segment_words = [{'text': word['word'], 'start': word['start'], 'end': word['end'],
                              'probability': word.get('probability')}
                             for word in segment.get('words', [])]
            segments.append({'start': segment['start'], 'end': segment['end'], 'text': segment['text'],
                             'avg_logprob': segment.get('avg_logprob'),
                             'no_speech_prob': segment.get('no_speech_prob'), 'words': segment_words})
            words.extend(segment_words)
        output = {'text': result['text'], 'language': result['language'], 'segments': segments,
            'words': words, 'engine': 'OpenAI Whisper small',
            'version': whisper.__version__, 'device': 'cpu',
            'settings': {'temperature': 0, 'beam_size': 5, 'condition_on_previous_text': False,
                         'word_timestamps': True, 'initial_prompt': None,
                         'reference_provided_to_model': False},
            'timing_note': 'Whisper 字词或词组级估计时间，未均分为逐字时间；边界与模型置信值均需结合回听解释。'}
        print(json.dumps({'ok': True, 'result': output}, ensure_ascii=False), flush=True)
    except Exception as error:
        print(json.dumps({'ok': False, 'error': str(error)}, ensure_ascii=False), flush=True)
