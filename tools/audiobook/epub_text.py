# Turns an EPUB (or PDF) into clean chapter text for narration.
# Usage: python epub_text.py book.epub out.json
# Output: {"title","author","cover"(file in same dir or null),"chapters":[{"title","text"}]}
import json, re, sys, os, zipfile, posixpath
from bs4 import BeautifulSoup

SKIP = re.compile(r'^(contents|table of contents|copyright|about the (author|publisher)|also by|back ads|cover|title page|dedication|'
                  r'acknowledg|praise|international acclaim|a preview|preview of|excerpt from|newsletter|index|bibliography|notes?$|'
                  r'more from|books by|other books|sign up|discover more|reading group|teaser)', re.I)
MAX_WORDS = 4500   # about 30 minutes of narration per track


def clean(t):
    t = t.replace('­', '').replace('​', '')
    t = re.sub(r'[ \t ]+', ' ', t)
    t = re.sub(r'\s*\n\s*', '\n', t)
    return t.strip()


import warnings
from bs4 import XMLParsedAsHTMLWarning
warnings.filterwarnings('ignore', category=XMLParsedAsHTMLWarning)
BACK = re.compile(r'^(a preview|preview of|excerpt from|about the author|also by|back ads|copyright|about the publisher|more from|books by)', re.I)


def lead_in(t):
    # drop caps and small-caps openings: "T HE BOY'S NAME WAS SANTIAGO. DUSK was" -> "The boy's name was Santiago. Dusk was"
    t = re.sub(r'^([A-Z]) ([A-Z]{1,})\b', r'\1\2', t)
    m = re.match(r"^((?:[A-Z][A-Z’'.,-]*\s+){2,}[A-Z][A-Z’'.,-]*)\b", t)
    if m and not m.group(1).isupper() is False:
        caps = m.group(1)
        t = caps.capitalize() + t[len(caps):]
    return t


def html_text(raw):
    s = BeautifulSoup(raw, 'lxml')
    for x in s(['script', 'style', 'sup', 'nav']): x.decompose()
    for a in s.select('a[href^="#"]'):
        if re.fullmatch(r'\[?\d+\]?|\*', a.get_text(strip=True)): a.decompose()   # footnote markers
    paras = []
    for el in s.find_all(['h1', 'h2', 'h3', 'h4', 'p', 'li', 'blockquote', 'div']):
        if el.find(['p', 'div', 'h1', 'h2', 'h3', 'li']): continue
        t = clean(el.get_text(' '))
        if not t: continue
        if re.fullmatch(r'[*•·\s◆♦~—-]+', t): paras.append('⁂'); continue   # scene break
        paras.append(t)
    return paras


def split_long(title, paras):
    words = sum(len(p.split()) for p in paras)
    if words <= MAX_WORDS * 1.3: return [{'title': title, 'text': '\n'.join(p for p in paras if p != '⁂')}]
    n = -(-words // MAX_WORDS); target = words / n
    out, cur, cw = [], [], 0
    for i, p in enumerate(paras):
        if p != '⁂': cur.append(p); cw += len(p.split())
        nxt_break = p == '⁂' or (i + 1 < len(paras) and paras[i + 1] == '⁂')
        if cw >= target * (0.8 if nxt_break else 1.15) and len(out) < n - 1:
            out.append(cur); cur, cw = [], 0
    if cur:
        if out and sum(len(x.split()) for x in cur) < target * 0.4: out[-1] += cur
        else: out.append(cur)
    return [{'title': f'{title} ({i + 1} of {len(out)})' if len(out) > 1 else title, 'text': '\n'.join(c)} for i, c in enumerate(out)]


def epub(path, outdir):
    z = zipfile.ZipFile(path)
    opf_path = BeautifulSoup(z.read('META-INF/container.xml'), 'xml').find('rootfile')['full-path']
    base = posixpath.dirname(opf_path)
    opf = BeautifulSoup(z.read(opf_path), 'xml')
    j = lambda h: posixpath.normpath(posixpath.join(base, h)) if base else h
    title = (opf.find('dc:title') or opf.find('title')).get_text(strip=True)
    author = ', '.join(a.get_text(strip=True) for a in opf.find_all(['dc:creator', 'creator'])) or 'Unknown'
    items = {i['id']: i for i in opf.find_all('item')}
    spine = [j(items[r['idref']]['href']) for r in opf.find_all('itemref') if r['idref'] in items]

    # cover image
    cover = None
    cid = (opf.find('meta', attrs={'name': 'cover'}) or {}).get('content') if opf.find('meta', attrs={'name': 'cover'}) else None
    ci = items.get(cid) if cid else None
    ci = ci or next((i for i in items.values() if 'cover-image' in (i.get('properties') or '')), None)
    ci = ci or next((i for i in items.values() if i.get('media-type', '').startswith('image') and 'cover' in i['href'].lower()), None)
    if ci:
        cover = 'cover' + os.path.splitext(ci['href'])[1]
        open(os.path.join(outdir, cover), 'wb').write(z.read(j(ci['href'])))

    # chapter titles from the table of contents (top level only)
    toc = {}
    ncx = next((i for i in items.values() if i.get('media-type') == 'application/x-dtbncx+xml'), None)
    nav = next((i for i in items.values() if 'nav' in (i.get('properties') or '')), None)
    if ncx:
        n = BeautifulSoup(z.read(j(ncx['href'])), 'xml')
        for np_ in n.find('navMap').find_all('navPoint', recursive=False):
            src = np_.find('content')['src'].split('#')[0]
            toc.setdefault(posixpath.normpath(posixpath.join(posixpath.dirname(j(ncx['href'])), src)), np_.find('text').get_text(strip=True))
    elif nav:
        n = BeautifulSoup(z.read(j(nav['href'])), 'lxml')
        ol = (n.find('nav', attrs={'epub:type': 'toc'}) or n).find('ol')
        for li in ol.find_all('li', recursive=False):
            a = li.find('a')
            if a and a.get('href'): toc.setdefault(posixpath.normpath(posixpath.join(posixpath.dirname(j(nav['href'])), a['href'].split('#')[0])), a.get_text(strip=True))

    groups, cur = [], None
    for f in spine:
        if f in toc or cur is None: cur = {'title': toc.get(f, title), 'paras': []}; groups.append(cur)
        cur['paras'] += html_text(z.read(f))
    chapters, num = [], 0
    for g in groups:
        if chapters and BACK.match(g['title']): break
        if SKIP.match(g['title']) or sum(len(p.split()) for p in g['paras']) < 60: continue
        paras = g['paras']
        if paras and clean(paras[0]).lower() == g['title'].lower(): paras = paras[1:]
        paras = [p for p in paras if not re.match(r'^(translated (from|by)|copyright|all rights reserved)', p, re.I)]
        if paras: paras[0] = lead_in(paras[0])
        spoken = g['title'] if not re.fullmatch(r'\d+', g['title']) else f'Chapter {g["title"]}'
        for c in split_long(spoken, paras):
            num += 1; chapters.append(c)
    return {'title': title, 'author': author, 'cover': cover, 'chapters': chapters}


def pdf(path, outdir):
    import fitz
    d = fitz.open(path)
    title = d.metadata.get('title') or os.path.splitext(os.path.basename(path))[0]
    author = d.metadata.get('author') or 'Unknown'
    pix = d[0].get_pixmap(dpi=110); pix.save(os.path.join(outdir, 'cover.png'))
    toc = [(lvl, t, p) for lvl, t, p in d.get_toc() if lvl == 1]
    pages = []
    for pg in d:
        lines = [l for l in pg.get_text().split('\n')]
        lines = [l for l in lines if not re.fullmatch(r'\s*\d+\s*', l)]           # page numbers
        txt = '\n'.join(lines)
        txt = re.sub(r'-\n(\w)', r'\1', txt)                                       # hyphenated line breaks
        txt = re.sub(r'(?<![.!?:"”])\n(?=[a-z])', ' ', txt)                        # broken lines inside sentences
        pages.append(txt)
    bounds = [(t, p - 1) for _, t, p in toc] or [(title, 0)]
    chapters = []
    for i, (t, start) in enumerate(bounds):
        end = bounds[i + 1][1] if i + 1 < len(bounds) else len(pages)
        if SKIP.match(t): continue
        paras = [clean(p) for p in '\n'.join(pages[start:end]).split('\n') if clean(p)]
        if sum(len(p.split()) for p in paras) < 60: continue
        chapters += split_long(t, paras)
    return {'title': title, 'author': author, 'cover': 'cover.png', 'chapters': chapters}


if __name__ == '__main__':
    src, out = sys.argv[1], sys.argv[2]
    outdir = os.path.dirname(os.path.abspath(out))
    book = pdf(src, outdir) if src.lower().endswith('.pdf') else epub(src, outdir)
    json.dump(book, open(out, 'w'), ensure_ascii=False, indent=1)
    for c in book['chapters']: print(f"{len(c['text'].split()):6d} words  {c['title']}")
