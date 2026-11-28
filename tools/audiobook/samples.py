# Compare the current voice with a more natural model (Chatterbox) speaking in the same two voices.
# Chatterbox takes the voice from a short reference clip; the clip here is made by our own Kokoro voices (no real person's voice).
import os, sys, subprocess, re, numpy as np, soundfile as sf
sys.path.insert(0, 'tools/audiobook'); from director import direct
TEXT = ("Law One. Never outshine the master.\n"
        "Always make those above you feel comfortably superior. In your desire to please or impress them, do not go too far in displaying your talents, or you might accomplish the opposite: inspire fear and insecurity.\n"
        "Make your masters appear more brilliant than they are, and you will attain the heights of power.\n"
        "Louis XIV was not amused.")
REF = ("I have always believed that the quiet ones are the most dangerous. They watch, they listen, and they wait. "
       "When they finally speak, everyone in the room leans in.")
out = sys.argv[1]; os.makedirs(out, exist_ok=True)
STUDIO = ("asetrate=24000*0.955,aresample=24000,atempo=1/0.955,equalizer=f=120:t=q:w=1:g=3,equalizer=f=3500:t=q:w=1.5:g=-2,"
          "equalizer=f=7000:t=q:w=2:g=1.5,acompressor=threshold=-20dB:ratio=3:attack=8:release=120,aecho=0.8:0.85:28:0.12,loudnorm=I=-18:TP=-1.5")
def mp3(name, wav, sr, af=STUDIO):
    sf.write(f'{out}/{name}.wav', wav, sr)
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', f'{out}/{name}.wav', '-af', af, '-ar', '44100', '-b:a', '128k', f'{out}/{name}.mp3'], check=True)
    os.remove(f'{out}/{name}.wav'); print('made', name, flush=True)
from kokoro import KPipeline
K = {'a': KPipeline(lang_code='a'), 'b': KPipeline(lang_code='b')}
def kok(text, v, lang, speed=.9):
    return np.concatenate([x.numpy() for _, _, x in K[lang](text, voice=v, speed=speed)])
paras = [p for p in direct(TEXT).split('\n') if p.strip()]
refs = {}
for tag, v, lang in [('American', 'am_onyx', 'a'), ('British', 'bm_lewis', 'b')]:
    w = []
    for p in paras: w += [kok(p, v, lang, .86), np.zeros(int(24000 * .9), np.float32)]
    mp3(f'{tag} 2 - Current voice, tuned', np.concatenate(w), 24000)
    r = kok(REF, v, lang, .9); sf.write(f'/tmp/ref-{tag}.wav', r, 24000); refs[tag] = f'/tmp/ref-{tag}.wav'
import torch
from chatterbox.tts import ChatterboxTTS
m = ChatterboxTTS.from_pretrained(device='cpu')
for tag in ['American', 'British']:
    for label, ex, cfg in [('4 - New model', .45, .4), ('5 - New model, more dramatic', .7, .3)]:
        m.prepare_conditionals(refs[tag], exaggeration=ex)
        w = []
        for p in paras:
            w += [m.generate(p, exaggeration=ex, cfg_weight=cfg, temperature=.75).squeeze(0).numpy(), np.zeros(int(m.sr * .9), np.float32)]
        mp3(f'{tag} {label}', np.concatenate(w), m.sr, STUDIO.replace('24000', str(m.sr)))
