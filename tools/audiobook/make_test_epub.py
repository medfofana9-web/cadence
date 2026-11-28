# Builds a tiny EPUB (original text) to test the narrator end to end.
import zipfile, sys
ch = {'Chapter One': 'The road was quiet that morning. He walked slowly, listening to the wind. Every step reminded him of the promise he had made.\n\nBy noon he reached the river. The water was cold and clear, and for the first time in weeks, he felt calm.',
      'Chapter Two': 'Mr. Hale was waiting at the gate. "You came back," he said. "Most people never do."\n\nThey stood there for a long moment. Then the old man smiled and opened the door.'}
z = zipfile.ZipFile(sys.argv[1], 'w')
z.writestr('mimetype', 'application/epub+zip')
z.writestr('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
items = ''.join(f'<item id="c{i}" href="c{i}.xhtml" media-type="application/xhtml+xml"/>' for i in range(len(ch)))
spine = ''.join(f'<itemref idref="c{i}"/>' for i in range(len(ch)))
z.writestr('OEBPS/content.opf', f'<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>The Quiet Road</dc:title><dc:creator>Test Author</dc:creator></metadata><manifest>{items}<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/></manifest><spine toc="ncx">{spine}</spine></package>')
nav = ''.join(f'<navPoint id="n{i}"><navLabel><text>{t}</text></navLabel><content src="c{i}.xhtml"/></navPoint>' for i, t in enumerate(ch))
z.writestr('OEBPS/toc.ncx', f'<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><navMap>{nav}</navMap></ncx>')
for i, (t, body) in enumerate(ch.items()):
    ps = ''.join(f'<p>{p}</p>' for p in body.split('\n\n'))
    z.writestr(f'OEBPS/c{i}.xhtml', f'<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><h1>{t}</h1>{ps}</body></html>')
z.close()
