# Original narrator voice: Chatterbox speaking in a timbre made by Kokoro (no real person's voice is used as a reference).
# Delivery: whole paragraphs per pass so emphasis carries across sentences; composed, conversational energy;
# a brief beat after short, weighty sentences; sentence endings left to settle; no forced pauses at commas.
import os, sys, re, json, subprocess, numpy as np, soundfile as sf
sys.path.insert(0, 'tools'); from director import direct
REF = ("I have always believed that the quiet ones are the most dangerous. They watch, they listen, and they wait. "
       "When they finally speak, everyone in the room leans in.")
if sys.argv[1] == 'warm':
    from kokoro import KPipeline; kp = KPipeline(lang_code='a')
    r = np.concatenate([x.numpy() for _, _, x in kp(REF, voice='am_onyx', speed=.92)]); sf.write('/tmp/ref.wav', r, 24000)
    from chatterbox.tts import ChatterboxTTS; ChatterboxTTS.from_pretrained(device='cpu')
    from faster_whisper import WhisperModel; WhisperModel('base.en', device='cpu', compute_type='int8'); sys.exit()
text, out = open(sys.argv[2]).read(), sys.argv[3]; os.makedirs(out, exist_ok=True)
paras = [p.strip() for p in direct(text).split('\n') if p.strip()]
from chatterbox.tts import ChatterboxTTS
from faster_whisper import WhisperModel
import librosa
W = WhisperModel('base.en', device='cpu', compute_type='int8')
# warmth in the low mids (not extra bass), a touch of clarity, gentle room, then two-pass loudness to -18 LUFS
EQ = ("highpass=f=70,equalizer=f=220:t=q:w=1:g=2,equalizer=f=3200:t=q:w=1.5:g=1,equalizer=f=6500:t=q:w=2:g=-1,"
      "acompressor=threshold=-21dB:ratio=2.5:attack=10:release=150,aecho=0.8:0.8:24:0.08")
LOUD = 'I=-18:TP=-1.5:LRA=11'
def ff(*a): return subprocess.run(['ffmpeg', '-y', '-hide_banner', '-nostats', *a], check=True, capture_output=True, text=True)
def mp3(name, wav, sr, pre=''):
    sf.write('/tmp/a.wav', wav, sr); ff('-i', '/tmp/a.wav', '-af', pre + EQ, '-ar', '44100', '/tmp/b.wav')
    r = ff('-i', '/tmp/b.wav', '-af', f'loudnorm={LOUD}:print_format=json', '-f', 'null', '-')
    m = json.loads(r.stderr[r.stderr.rindex('{'):r.stderr.rindex('}') + 1])
    ff('-i', '/tmp/b.wav', '-af', f"loudnorm={LOUD}:measured_I={m['input_i']}:measured_TP={m['input_tp']}:measured_LRA={m['input_lra']}:measured_thresh={m['input_thresh']}:offset={m['target_offset']}:linear=true", '-ar', '44100', '-b:a', '160k', f'{out}/{name}.mp3')
    print('made', name, round(len(wav) / sr, 1), 's', flush=True)
def trim(a, sr):
    idx = np.where(np.abs(a) > 0.012)[0]
    return a[max(0, idx[0] - int(sr * .03)):idx[-1] + int(sr * .08)] if len(idx) else a
def whole(m, p, ex, cfg):
    best = None
    for _ in range(2):
        a = trim(m.generate(p, exaggeration=ex, cfg_weight=cfg, temperature=.75).squeeze(0).numpy(), m.sr)
        if best is None or len(a) > len(best): best = a
        if len(best) / m.sr > len(p.split()) * .3: break
    return best
def silences(a, sr):
    hop = int(sr * .01); rms = np.sqrt(np.convolve(a ** 2, np.ones(hop * 2) / (hop * 2), 'same'))[::hop]
    thr = max(rms.max() * .035, np.percentile(rms, 15) * 2); out, s = [], None
    for i, q in enumerate(rms < thr):
        if q and s is None: s = i
        if not q and s is not None:
            if i - s >= 6 and s > 0: out.append((s * hop, i * hop))
            s = None
    return out
def breaths(a, sr, p):
    """After each sentence: a natural settle (0.5 s); after a short, weighty sentence: a brief beat (0.8 s). Commas untouched."""
    sents = [s for s in re.split(r'(?<=[.!?])\s+', p) if s.strip()]
    if len(sents) < 2: return a
    gaps = [.8 if len(s.split()) <= 7 else .5 for s in sents[:-1]]
    sil = silences(a, sr)
    y = librosa.resample(a, orig_sr=sr, target_sr=16000)
    segs, _ = W.transcribe(y, word_timestamps=True, language='en', beam_size=1)
    words = [w for s in segs for w in s.words]; print('  heard:', ''.join(w.word for w in words).strip(), flush=True)
    ends = [w.end for w in words if re.search(r'[.!?]["”’]?$', w.word.strip())][:len(gaps)]
    picks = []
    for t in ends:
        c = min(sil, key=lambda x: abs(x[0] / sr - t), default=None)
        if c and abs(c[0] / sr - t) < .35 and c not in picks: picks.append(c)
    if len(picks) != len(gaps): print('  could not place every breath; kept the model\'s own'); return a
    keep = int(sr * .05)
    for (s, e), g in sorted(zip(picks, gaps), reverse=True):
        a = np.concatenate([a[:s + keep], np.zeros(max(0, int(sr * g) - 2 * keep), np.float32), a[max(s + keep, e - keep):]])
    return a
def render(m, ex, cfg):
    w = [np.zeros(int(m.sr * .35), np.float32)]
    for i, p in enumerate(paras):
        w += [breaths(whole(m, p, ex, cfg), m.sr, p), np.zeros(int(m.sr * (.9 if i == 0 else 1.1)), np.float32)]
    return np.concatenate(w)
m = ChatterboxTTS.from_pretrained(device='cpu')
m.prepare_conditionals('/tmp/ref.wav', exaggeration=.55)
mp3('Preview A - Original narrator', render(m, .55, .5), m.sr)
m = ChatterboxTTS.from_pretrained(device='cpu')
mp3('Preview B - Original narrator, second timbre', render(m, .55, .5), m.sr, f'asetrate={m.sr}*0.88,aresample={m.sr},atempo={1/0.88:.5f},')
