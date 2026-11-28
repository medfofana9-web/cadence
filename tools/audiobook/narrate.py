# Fof Music audiobook narrator: turns an EPUB or PDF into chapter MP3s, tagged so Fof Music files them under Audiobooks.
# Usage: python narrate.py BOOK OUTDIR [--engine chatterbox|kokoro] [--voice NAME] [--limit-words N]
# Prints one JSON line per step ({"step":..}) so the Mac app can show progress. Safe to stop and restart: finished chapters are kept.
import argparse, json, os, re, subprocess, sys, tempfile, time
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import epub_text


def say(**k): print(json.dumps(k), flush=True)


def safe(s): return re.sub(r'[\\/:*?"<>|]+', '', s).strip()[:80] or 'Untitled'


def sentences(text, limit):
    """Paragraphs -> speakable chunks. Each chunk keeps whole sentences and stays under `limit` characters."""
    for para in text.split('\n'):
        para = para.strip()
        if not para: continue
        parts = re.split(r'(?<=[.!?…”"])\s+(?=[A-Z“"‘(])', para)
        buf = ''
        for s in parts:
            while len(s) > limit:                     # very long sentence: break at a comma or semicolon
                cut = max(s.rfind(', ', 0, limit), s.rfind('; ', 0, limit), s.rfind(' — ', 0, limit))
                cut = cut if cut > limit // 3 else s.rfind(' ', 0, limit)
                if buf: yield buf, False; buf = ''
                yield s[:cut + 1].strip(), False; s = s[cut + 1:].strip()
            if len(buf) + len(s) + 1 > limit and buf: yield buf, False; buf = ''
            buf = (buf + ' ' + s).strip()
        if buf: yield buf, True                      # True = end of paragraph (longer pause)


def speakable(t):
    t = t.replace('—', ', ').replace('–', ', ').replace('…', '...')
    t = re.sub(r'\bMr\.', 'Mister', t); t = re.sub(r'\bMrs\.', 'Missus', t); t = re.sub(r'\bDr\.', 'Doctor', t)
    t = re.sub(r'\bSt\. ', 'Saint ', t)
    t = re.sub(r'[\[\]{}*_#<>|~^]', '', t)
    return re.sub(r'\s+', ' ', t).strip()


class Kokoro:
    sr = 24000; limit = 400
    def __init__(self, voice):
        from kokoro import KPipeline
        self.voice = voice or 'am_onyx'
        self.p = KPipeline(lang_code=self.voice[0])
    def __call__(self, text):
        return np.concatenate([a.numpy() if hasattr(a, 'numpy') else a for _, _, a in self.p(text, voice=self.voice, speed=0.95)])


class Chatterbox:
    limit = 260
    def __init__(self, voice):
        import torch
        from chatterbox.tts import ChatterboxTTS
        dev = 'mps' if torch.backends.mps.is_available() else 'cuda' if torch.cuda.is_available() else 'cpu'
        if dev == 'mps':  # the published weights were saved on a GPU; load them onto the Mac's
            orig = torch.load; torch.load = lambda *a, **k: orig(*a, **{**k, 'map_location': torch.device('mps')})
        self.m = ChatterboxTTS.from_pretrained(device=dev); self.sr = self.m.sr
        ref = None
        if voice and voice != 'default':
            ref = voice if os.path.exists(voice) else os.path.join(HERE, 'refs', voice + '.wav')
        if ref and os.path.exists(ref): self.m.prepare_conditionals(ref, exaggeration=0.35)
        self.ref = None
    def __call__(self, text):
        w = self.m.generate(text, exaggeration=0.35, cfg_weight=0.4, temperature=0.7)
        return w.squeeze(0).cpu().numpy()


def to_mp3(wav, sr, path, tags, cover):
    import soundfile as sf, imageio_ffmpeg
    from mutagen.id3 import ID3, TIT2, TPE1, TPE2, TALB, TCON, TRCK, APIC, ID3NoHeaderError
    tmp = path + '.wav'
    sf.write(tmp, wav, sr)
    subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), '-y', '-loglevel', 'error', '-i', tmp,
                    '-af', 'loudnorm=I=-18:TP=-1.5:LRA=11', '-ac', '1', '-ar', '44100', '-b:a', '96k', path + '.part.mp3'], check=True)
    os.remove(tmp)
    try: id3 = ID3(path + '.part.mp3')
    except ID3NoHeaderError: id3 = ID3()
    id3.add(TIT2(encoding=3, text=tags['title'])); id3.add(TPE1(encoding=3, text=tags['author']))
    id3.add(TPE2(encoding=3, text=tags['author'])); id3.add(TALB(encoding=3, text=tags['book']))
    id3.add(TCON(encoding=3, text='Audiobook')); id3.add(TRCK(encoding=3, text=f"{tags['n']}/{tags['of']}"))
    if cover and os.path.exists(cover):
        id3.add(APIC(encoding=3, mime='image/png' if cover.endswith('png') else 'image/jpeg', type=3, desc='Cover', data=open(cover, 'rb').read()))
    id3.save(path + '.part.mp3', v2_version=3)
    os.replace(path + '.part.mp3', path)   # appears all at once, so Fof Music never imports a half-written file


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('book'); ap.add_argument('out')
    ap.add_argument('--engine', default='chatterbox'); ap.add_argument('--voice', default='default')
    ap.add_argument('--limit-words', type=int, default=0, help='only narrate this many words per chapter (for tests)')
    a = ap.parse_args()

    work = tempfile.mkdtemp()
    book = (epub_text.pdf if a.book.lower().endswith('.pdf') else epub_text.epub)(a.book, work)
    cover = os.path.join(work, book['cover']) if book.get('cover') else None
    folder = os.path.join(a.out, safe(book['title'])); os.makedirs(folder, exist_ok=True)
    chs = book['chapters']; total_words = sum(len(c['text'].split()) for c in chs)
    say(step='book', title=book['title'], author=book['author'], chapters=len(chs), words=total_words, folder=folder)

    tts = None
    for i, ch in enumerate(chs, 1):
        dest = os.path.join(folder, f"{i:02d} {safe(ch['title'])}.mp3")
        if os.path.exists(dest): say(step='skip', n=i); continue
        if tts is None:
            say(step='loading', engine=a.engine)
            tts = (Kokoro if a.engine == 'kokoro' else Chatterbox)(a.voice)
        text = ch['text']
        if a.limit_words: text = ' '.join(text.split()[:a.limit_words])
        chunks = [(ch['title'] + '.', True)] + list(sentences(text, tts.limit))
        out, t0 = [np.zeros(int(tts.sr * 0.6), dtype=np.float32)], time.time()
        for k, (c, para_end) in enumerate(chunks):
            c = speakable(c)
            if not re.search(r'\w', c): continue
            try: w = tts(c)
            except Exception as e: say(step='warn', chunk=k, error=str(e)[:200]); continue
            out += [w.astype(np.float32), np.zeros(int(tts.sr * (0.75 if para_end else 0.28)), dtype=np.float32)]
            if k % 10 == 0: say(step='progress', n=i, of=len(chs), chunk=k, chunks=len(chunks), chapter=ch['title'])
        out.append(np.zeros(int(tts.sr * 1.2), dtype=np.float32))
        to_mp3(np.concatenate(out), tts.sr, dest, {'title': ch['title'], 'author': book['author'], 'book': book['title'], 'n': i, 'of': len(chs)}, cover)
        say(step='chapter', n=i, of=len(chs), chapter=ch['title'], seconds=round(time.time() - t0))
    say(step='done', title=book['title'], folder=folder)


if __name__ == '__main__':
    main()
