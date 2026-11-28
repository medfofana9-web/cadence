# Voice tuning samples: the same passage in each version so they can be compared side by side.
import os, sys, subprocess, numpy as np, soundfile as sf, re
TEXT = ("Law One. Never outshine the master. "
        "Always make those above you feel comfortably superior. In your desire to please, or to impress them, do not go too far in displaying your talents. "
        "You might accomplish the opposite, and inspire fear and insecurity. "
        "Make your masters appear more brilliant than they are... and you will attain the heights of power.")
out = sys.argv[1]; os.makedirs(out, exist_ok=True)
from kokoro import KPipeline
P = {'a': KPipeline(lang_code='a'), 'b': KPipeline(lang_code='b')}
def voice(spec, lang):
    if '+' not in spec: return spec
    parts = [x.split('*') for x in spec.split('+')]
    return sum(float(w) * P[lang].load_voice(n) for n, w in parts)
def render(spec, lang, speed, sent_gap, para_gap):
    v = voice(spec, lang); sr = 24000; outw = [np.zeros(int(sr * .5), np.float32)]
    sents = re.split(r'(?<=[.!?])\s+', TEXT)
    for k, s in enumerate(sents):
        a = np.concatenate([x.numpy() if hasattr(x, 'numpy') else x for _, _, x in P[lang](s, voice=v, speed=speed)])
        gap = para_gap if k == 1 else sent_gap
        outw += [a.astype(np.float32), np.zeros(int(sr * gap), np.float32)]
    return np.concatenate(outw), sr
STUDIO = ("asetrate=24000*0.955,aresample=24000,atempo=1/0.955,"         # about 3/4 of a semitone deeper, same pace
          "equalizer=f=120:t=q:w=1:g=3,equalizer=f=3500:t=q:w=1.5:g=-2,equalizer=f=7000:t=q:w=2:g=1.5,"  # warmth, less harshness, clarity
          "acompressor=threshold=-20dB:ratio=3:attack=8:release=120,"     # even, close-mic sound
          "aecho=0.8:0.85:28:0.12,loudnorm=I=-18:TP=-1.5")                # a touch of studio room
def save(name, w, sr, studio):
    sf.write(f'{out}/{name}.wav', w, sr)
    af = STUDIO if studio else 'loudnorm=I=-18:TP=-1.5'
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', f'{out}/{name}.wav', '-af', af, '-b:a', '128k', f'{out}/{name}.mp3'], check=True)
    os.remove(f'{out}/{name}.wav'); print('made', name, flush=True)
for tag, spec, lang in [('American', 'am_onyx', 'a'), ('British', 'bm_lewis', 'b')]:
    w, sr = render(spec, lang, .94, .28, .75); save(f'{tag} 1 - Now', w, sr, False)
    w, sr = render(spec, lang, .86, .48, 1.05); save(f'{tag} 2 - Slower and studio', w, sr, True)
blends = {'American': ('am_onyx*0.65+am_michael*0.35', 'a'), 'British': ('bm_lewis*0.6+bm_george*0.4', 'b')}
for tag, (spec, lang) in blends.items():
    w, sr = render(spec, lang, .86, .48, 1.05); save(f'{tag} 3 - Richer blend and studio', w, sr, True)
