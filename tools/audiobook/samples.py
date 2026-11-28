# Three takes of the same ~80-second passage, all at normal (1x) speed and the same loudness:
#   American 9  - Chatterbox's own voice, lowered (pitch only, length unchanged), each paragraph read in one pass
#   American 10 - Chatterbox speaking in our Kokoro "Deep American" voice, livelier, each paragraph in one pass,
#                 with Poe-measured breaths at the ends of thoughts (0.7 s between sentences, 1.5 s between paragraphs)
#   American 11 - American 9's voice, pace and expression + American 10's breaths at the ends of thoughts
# Each paragraph is generated whole, so the model hears the full thought and emphasis carries between sentences.
# The passage is original writing (not from any book). The reference clip for our voice is made by Kokoro.
import os, sys, subprocess, re, json, numpy as np, soundfile as sf
sys.path.insert(0, 'tools/audiobook'); from director import direct
TEXT = ("Every court has its quiet observer. He arrives early, speaks little, and remembers everything. While others compete to be seen, he studies who is laughing, who is nervous, and who keeps glancing toward the door. Nobody thinks of him as dangerous. That is exactly the point. By the time the room realizes what he knows, the decisions have already been made, and they were made by him.\n"
        "Consider the merchant who wanted a favor from the governor. He did not ask for it directly. Instead, he sent a gift, then a letter, then a friend who happened to mention his name at dinner. Months passed. When the governor finally offered the favor himself, he believed the idea had been his own. The merchant simply thanked him, and never mentioned the gift again.\n"
        "This is the lesson. Power rarely announces itself. It moves through patience, through timing, and through the careful management of what others believe. Show your hand too early, and you invite resistance. Keep your purpose hidden, and the path clears in front of you. The people who rise are not always the loudest in the room. More often, they are the ones who waited.")
REF = ("I have always believed that the quiet ones are the most dangerous. They watch, they listen, and they wait. "
       "When they finally speak, everyone in the room leans in.")
out = sys.argv[1]; os.makedirs(out, exist_ok=True)
paras = [p for p in direct(TEXT).split('\n') if p.strip()]
EQ = ("equalizer=f=120:t=q:w=1:g=2.5,equalizer=f=3500:t=q:w=1.5:g=-1.5,equalizer=f=7000:t=q:w=2:g=1.5,"
      "acompressor=threshold=-20dB:ratio=3:attack=8:release=120,aecho=0.8:0.85:28:0.1")
LOUD = 'I=-18:TP=-1.5:LRA=11'
def ff(*a): return subprocess.run(['ffmpeg', '-y', '-hide_banner', '-nostats', *a], check=True, capture_output=True, text=True)
def mp3(name, wav, sr, pre=''):
    """Same EQ for every take, then two-pass loudness normalisation so all three play at the same loudness. No speed change."""
    sf.write('/tmp/a.wav', wav, sr)
    ff('-i', '/tmp/a.wav', '-af', pre + EQ, '-ar', '44100', '/tmp/b.wav')
    r = ff('-i', '/tmp/b.wav', '-af', f'loudnorm={LOUD}:print_format=json', '-f', 'null', '-')
    m = json.loads(r.stderr[r.stderr.rindex('{'):r.stderr.rindex('}') + 1])
    ff('-i', '/tmp/b.wav', '-af', f"loudnorm={LOUD}:measured_I={m['input_i']}:measured_TP={m['input_tp']}:measured_LRA={m['input_lra']}:measured_thresh={m['input_thresh']}:offset={m['target_offset']}:linear=true",
       '-ar', '44100', '-b:a', '160k', f'{out}/{name}.mp3')
    r = ff('-i', f'{out}/{name}.mp3', '-af', 'ebur128', '-f', 'null', '-')
    lufs = re.findall(r'I:\s+(-?[\d.]+) LUFS', r.stderr)[-1]
    print(f'made {name}: {len(wav) / sr:.1f} s, {lufs} LUFS', flush=True)

from kokoro import KPipeline
kp = KPipeline(lang_code='a')
ref = np.concatenate([x.numpy() for _, _, x in kp(REF, voice='am_onyx', speed=.9)]); sf.write('/tmp/ref.wav', ref, 24000)
from faster_whisper import WhisperModel
W = WhisperModel('base.en', device='cpu', compute_type='int8')
from chatterbox.tts import ChatterboxTTS
import librosa

def trim(a, sr):
    idx = np.where(np.abs(a) > 0.012)[0]
    return a[max(0, idx[0] - int(sr * .03)):idx[-1] + int(sr * .06)] if len(idx) else a
def whole(m, p, ex, cfg):  # one pass per paragraph; retry once if the model cut the paragraph short
    best = None
    for _ in range(2):
        a = trim(m.generate(p, exaggeration=ex, cfg_weight=cfg, temperature=.8).squeeze(0).numpy(), m.sr)
        if best is None or len(a) > len(best): best = a
        if len(best) / m.sr > len(p.split()) * .28: break   # long enough to hold every word
    return best
def silences(a, sr):
    hop = int(sr * .01); rms = np.sqrt(np.convolve(a ** 2, np.ones(hop * 2) / (hop * 2), 'same'))[::hop]
    thr = max(rms.max() * .035, np.percentile(rms, 15) * 2); quiet = rms < thr; out, s = [], None
    for i, q in enumerate(quiet):
        if q and s is None: s = i
        if not q and s is not None:
            if i - s >= 6 and s > 0: out.append((s * hop, i * hop))
            s = None
    return out
def sentence_breaths(a, sr, p, gap):
    """Set the pause after each sentence (not the last) to `gap` seconds, keeping the model's own phrasing elsewhere."""
    n = len(re.findall(r'[.!?](?=\s)', p))
    if not n: return a
    sil = silences(a, sr)
    y = librosa.resample(a, orig_sr=sr, target_sr=16000)
    segs, _ = W.transcribe(y, word_timestamps=True, language='en', beam_size=1)
    ends = [w.end for s in segs for w in s.words if re.search(r'[.!?]["”’]?$', w.word.strip())][:-1] if True else []
    picks = []
    for t in ends:   # the silence that starts nearest each sentence-ending word
        c = min(sil, key=lambda x: abs(x[0] / sr - t), default=None)
        if c and abs(c[0] / sr - t) < .35 and c not in picks: picks.append(c)
    how = 'word timings'
    if len(picks) != n:   # fall back to the n longest silences
        picks = sorted(sorted(sil, key=lambda x: x[1] - x[0])[-n:]); how = 'longest pauses'
    print(f'  {n} sentence breaths placed by {how}', flush=True)
    keep = int(sr * .04)
    for s, e in sorted(picks, reverse=True):
        a = np.concatenate([a[:s + keep], np.zeros(int(sr * gap) - 2 * keep, np.float32), a[max(s + keep, e - keep):]])
    return a
def join(parts, sr, gap): 
    w = [np.zeros(int(sr * .3), np.float32)]
    for x in parts: w += [x, np.zeros(int(sr * gap), np.float32)]
    return np.concatenate(w)

LOWER = 'asetrate={sr}*0.8,aresample={sr},atempo=1.25,'   # pitch down, same length (1x)
m = ChatterboxTTS.from_pretrained(device='cpu')             # model's own built-in voice
raw9 = [whole(m, p, .75, .5) for p in paras]
mp3('American 9 - built-in voice, model pauses', join(raw9, m.sr, .9), m.sr, LOWER.format(sr=m.sr))
mp3('American 11 - 9 voice + Poe breaths', join([sentence_breaths(a, m.sr, p, .7) for a, p in zip(raw9, paras)], m.sr, 1.5), m.sr, LOWER.format(sr=m.sr))
m.prepare_conditionals('/tmp/ref.wav', exaggeration=1.0)   # our Deep American voice
raw10 = [whole(m, p, 1.0, .4) for p in paras]
mp3('American 10 - our voice + Poe breaths', join([sentence_breaths(a, m.sr, p, .7) for a, p in zip(raw10, paras)], m.sr, 1.5), m.sr)
