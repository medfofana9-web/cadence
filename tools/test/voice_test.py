# Loads the in-app narrator voices in a real browser and saves a sample of each (run on GitHub, which can reach the model host).
import asyncio, json, struct, sys, time, wave, http.server, threading, functools
from playwright.async_api import async_playwright
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 8765), functools.partial(http.server.SimpleHTTPRequestHandler, directory='.'))
threading.Thread(target=srv.serve_forever, daemon=True).start()
TEXT = "Power is never given. It is taken, quietly, by those who understand the rules of the game."
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(); pg = await b.new_page()
        pg.on('console', lambda m: print('console:', m.text[:200]))
        await pg.goto('http://127.0.0.1:8765/tools/test/blank.html')
        t0 = time.time()
        r = await pg.evaluate("""async (text) => { const m = await import('/lib/voice.js'); const t0 = performance.now(); await m.load(); const t1 = performance.now();
            const out = {}; for (const v of ['american', 'british']) { const s = performance.now(); const a = await m.speak(text, v); out[v] = { ms: Math.round(performance.now() - s), rate: a.rate, samples: Array.from(a.samples) }; }
            return { load: Math.round(t1 - t0), out }; }""", TEXT)
        print('model load ms', r['load'])
        for v, a in r['out'].items():
            print(v, 'generate ms', a['ms'], 'audio s', round(len(a['samples']) / a['rate'], 2))
            with wave.open(f'out-{v}.wav', 'w') as w:
                w.setnchannels(1); w.setsampwidth(2); w.setframerate(a['rate'])
                w.writeframes(b''.join(struct.pack('<h', max(-32767, min(32767, int(x * 32767)))) for x in a['samples']))
        await b.close()
asyncio.run(main())
