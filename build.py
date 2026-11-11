"""Inline engine.js and app.js into index.template.html -> ../Rally Route Planner.html"""
from pathlib import Path
here = Path(__file__).parent
html = (here / 'index.template.html').read_text()
html = html.replace('/*__ENGINE__*/', (here / 'engine.js').read_text())
html = html.replace('/*__APP__*/', (here / 'app.js').read_text())
# allow only these exact inline scripts: swap 'unsafe-inline' in script-src for their hashes
import base64, hashlib, re
hashes = ' '.join("'sha256-" + base64.b64encode(hashlib.sha256(m.encode()).digest()).decode() + "'"
                  for m in re.findall(r'<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>', html, re.S))
html = html.replace("script-src 'self' 'unsafe-inline'", f"script-src 'self' {hashes}", 1)
for out in (here.parent / 'Rally Route Planner.html', here / 'index.html'):
    out.write_text(html)
    print(f'wrote {out} ({len(html) // 1024} KB)')
