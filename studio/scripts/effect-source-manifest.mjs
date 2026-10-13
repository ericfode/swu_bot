import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const hash = value => createHash('sha256').update(value).digest('hex');

/** Shared review provenance for both a build and a directly served development tree. */
export function effectSourceManifest() {
    // The renderer uses shared card faces, scores, settings and routes as well as effects.
    // Fingerprint the complete viewer source so a port cannot silently reuse earlier evidence.
    const files = fs.readdirSync(path.join(repository, 'studio/src'), { recursive: true })
        .filter(file => /\.(tsx?|css)$/.test(file))
        .map(file => `studio/src/${file}`).sort();
    const sourceHashes = Object.fromEntries(files.map(file => [file, hash(fs.readFileSync(path.join(repository, file)))]));
    return { sourceFingerprint: hash(JSON.stringify(sourceHashes)), sourceHashes };
}
