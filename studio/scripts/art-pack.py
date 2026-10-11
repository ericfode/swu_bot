# Packs card art for the cards in some replays into one JSON file of data URIs, for pages that can't load
# external images (published artifacts). Holotable's static build fetches it next to the page as art-pack.json.
#   python3 scripts/art-pack.py <card-art dir> <out.json> <replays dir> [width=160] [quality=62]
import base64, io, json, os, re, sys
from PIL import Image

art_dir, out, replays = sys.argv[1], sys.argv[2], sys.argv[3]
width = int(sys.argv[4]) if len(sys.argv) > 4 else 160
quality = int(sys.argv[5]) if len(sys.argv) > 5 else 62
codes = set()
for root, _, files in os.walk(replays):
    for f in files:
        if f.endswith('.jsonl'):
            with open(os.path.join(root, f), encoding='utf8') as fh:
                codes.update(re.findall(r'"s":"([A-Z0-9]+_\d+)"', fh.read()))
pack, missing = {}, 0
for code in sorted(codes):
    s, n = code.split('_')
    for suffix in ('', '-b'):
        p = os.path.join(art_dir, s, f'{n}{suffix}.webp')
        if not os.path.exists(p):
            if not suffix:
                missing += 1
            continue
        im = Image.open(p)
        if im.width > width:
            im = im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)
        buf = io.BytesIO()
        im.save(buf, 'WEBP', quality=quality, method=6)
        pack[code + suffix] = 'data:image/webp;base64,' + base64.b64encode(buf.getvalue()).decode()
with open(out, 'w') as fh:
    json.dump(pack, fh, separators=(',', ':'))
print(f'{len(pack)} images for {len(codes)} cards ({missing} without art), {os.path.getsize(out) / 1e6:.1f} MB -> {out}')
