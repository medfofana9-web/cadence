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
    r = kok(REF, v, lang, .9); sf.write(f'/tmp/ref-{tag}.wav', r, 24000); refs[tag] = f'/tmp/ref-{tag}.wav'
# Matched to the measured style: natural pitch (no deepening), brisk phrases, frequent pauses (~0.7 s between
# sentences, ~0.45 s at commas and colons, ~1.5 s between paragraphs), wide expressive range.
NATURAL = ("equalizer=f=120:t=q:w=1:g=2.5,equalizer=f=3500:t=q:w=1.5:g=-1.5,equalizer=f=7000:t=q:w=2:g=1.5,"
           "acompressor=threshold=-20dB:ratio=3:attack=8:release=120,aecho=0.8:0.85:28:0.1,loudnorm=I=-18:TP=-1.5")
from chatterbox.tts import ChatterboxTTS
m = ChatterboxTTS.from_pretrained(device='cpu')
def phrases(p):  # split at sentence ends and at commas/colons/semicolons, keeping the punctuation
    out = []
    for sent in re.split(r'(?<=[.!?])\s+', p):
        parts = re.split(r'(?<=[,:;])\s+', sent)
        for k, ph in enumerate(parts): out.append((ph, 'sent' if k == len(parts) - 1 else 'comma'))
    return out
def trim(a, sr):  # cut the model's own silence at both ends so our pauses are the real pauses
    idx = np.where(np.abs(a) > 0.012)[0]
    return a[max(0, idx[0] - int(sr * .03)):idx[-1] + int(sr * .06)] if len(idx) else a
for tag in ['American', 'British']:
    m.prepare_conditionals(refs[tag], exaggeration=.75)
    w = [np.zeros(int(m.sr * .4), np.float32)]
    for p in paras:
        for sent in re.split(r'(?<=[.!?])\s+', p):   # whole sentences keep the rise and fall
            w += [trim(m.generate(sent, exaggeration=.75, cfg_weight=.3, temperature=.8).squeeze(0).numpy(), m.sr), np.zeros(int(m.sr * .5), np.float32)]
        w.append(np.zeros(int(m.sr * .6), np.float32))
    mp3(f'{tag} 7 - Matched, brisker', np.concatenate(w), m.sr, 'atempo=1.13,' + NATURAL)
