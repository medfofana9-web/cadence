# Makes short narration samples so the voice can be chosen before a whole book is converted.
import os, sys, subprocess, numpy as np, soundfile as sf
TEXT = ("Power is never given. It is taken, quietly, by those who understand the rules of the game. "
        "Most people spend their lives reacting to others. They speak too much, they reveal their plans, "
        "and they wonder why nothing goes their way. The wise do the opposite. They listen. They wait. "
        "And when the moment comes, they act without hesitation.")
out = sys.argv[1]; os.makedirs(out, exist_ok=True)
def mp3(name, wav, sr):
    sf.write(f'{out}/{name}.wav', wav, sr)
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', f'{out}/{name}.wav', '-b:a', '128k', f'{out}/{name}.mp3'], check=True)
    os.remove(f'{out}/{name}.wav'); print('made', name, flush=True)

from kokoro import KPipeline
for lang, voices in {'a': ['am_onyx', 'am_fenrir', 'am_michael'], 'b': ['bm_george', 'bm_fable', 'bm_lewis']}.items():
    p = KPipeline(lang_code=lang)
    for v in voices:
        parts = [a for _, _, a in p(TEXT, voice=v, speed=0.92)]
        mp3(f'kokoro-{v}', np.concatenate(parts), 24000)

import torch, torchaudio
from chatterbox.tts import ChatterboxTTS
m = ChatterboxTTS.from_pretrained(device='cpu')
refs = {f[:-4]: f'tools/audiobook/refs/{f}' for f in sorted(os.listdir('tools/audiobook/refs'))} if os.path.isdir('tools/audiobook/refs') else {}
for name, ref in [('default', None), *refs.items()]:
    import re
    chunks = re.split(r'(?<=[.!?])\s+', TEXT); wavs = []
    for c in chunks:
        w = m.generate(c, audio_prompt_path=ref, exaggeration=0.35, cfg_weight=0.4, temperature=0.7)
        wavs += [w.squeeze(0).numpy(), np.zeros(int(m.sr * 0.35), dtype=np.float32)]
    mp3(f'chatterbox-{name}', np.concatenate(wavs), m.sr)
