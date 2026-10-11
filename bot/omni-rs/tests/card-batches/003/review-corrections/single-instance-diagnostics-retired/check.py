"""Replay explicit synthetic engine diagnostics; no actual-card coverage claim."""
import argparse
import gzip
import hashlib
import json
import pathlib
import subprocess
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('runtime', choices=['native', 'wasm'])
args = parser.parse_args()
directory = pathlib.Path(__file__).resolve().parent
root = next(parent for parent in directory.parents if (parent / 'bot/env.js').is_file())
index = json.loads((directory / 'index.json').read_text())
command = [str(root / 'target/release/omni-rs'), 'check'] if args.runtime == 'native' else ['node', str(root / 'bot/omni/wasm/check.js')]
for case in index['cases']:
    folder = directory / case['directory']
    for name, expected in case['files'].items():
        assert hashlib.sha256((folder / name).read_bytes()).hexdigest() == expected, name
    with tempfile.TemporaryDirectory(prefix='swu-synthetic-review-') as temporary:
        inputs = pathlib.Path(temporary)
        for name, expected in [('catalog', 'catalogueDecompressedSha256'), ('pool', 'poolDecompressedSha256')]:
            payload = gzip.decompress((folder / (name + '.json.gz')).read_bytes())
            assert hashlib.sha256(payload).hexdigest() == case[expected]
            (inputs / (name + '.json')).write_bytes(payload)
        result = subprocess.run(command + [str(folder / 'comparison.jsonl.gz'), '--catalogue', str(inputs / 'catalog.json'), '--pool', str(inputs / 'pool.json')], cwd=root, check=False)
        if result.returncode:
            raise SystemExit(result.returncode)
