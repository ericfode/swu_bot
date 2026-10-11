# Packs card art for the cards in some replays into JSON files of data URIs, for pages that can't load external
# images (published artifacts). Holotable's static build fetches it next to the page as art-pack.json.
#   python3 scripts/art-pack.py <card-art dir> <out.json> <replays dir>[:<dir>...] [width=160] [quality=62] [part MB=12]
# A pack bigger than the part size is split: <out.json> becomes {"parts": [...]} naming <out>-1.json, <out>-2.json...
import base64, glob, io, json, os, re, sys
from PIL import Image

art_dir, out, replays = sys.argv[1], sys.argv[2], sys.argv[3]
width = int(sys.argv[4]) if len(sys.argv) > 4 else 160
quality = int(sys.argv[5]) if len(sys.argv) > 5 else 62
part_mb = float(sys.argv[6]) if len(sys.argv) > 6 else 12
codes = set()
for top in replays.split(':'):
    for root, _, files in os.walk(top):
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
parts, cur, size = [], {}, 0
for k, v in pack.items():
    if cur and size + len(v) > part_mb * 1e6:
        parts.append(cur)
        cur, size = {}, 0
    cur[k] = v
    size += len(v) + len(k) + 6
parts.append(cur)
stem = os.path.splitext(out)[0]
# parts left over from an earlier, bigger run would sit beside the pack looking current: remove them
for old in glob.glob(f'{glob.escape(stem)}-*.json'):
    tail = old[len(stem) + 1:-5]
    if tail.isdigit() and (len(parts) == 1 or int(tail) > len(parts)):
        os.remove(old)
if len(parts) == 1:
    with open(out, 'w') as fh:
        json.dump(pack, fh, separators=(',', ':'))
else:
    names = []
    for i, part in enumerate(parts, 1):
        name = f'{stem}-{i}.json'
        with open(name, 'w') as fh:
            json.dump(part, fh, separators=(',', ':'))
        names.append(os.path.basename(name))
    with open(out, 'w') as fh:
        json.dump({'parts': names}, fh)
total = sum(len(v) for v in pack.values()) / 1e6
print(f'{len(pack)} images for {len(codes)} cards ({missing} without art), {total:.1f} MB in {len(parts)} file(s) -> {out}')
