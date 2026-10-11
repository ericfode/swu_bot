import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

const ID = 'virtual:atlas-kit';

/**
 * `import kit from 'virtual:atlas-kit'`: the Strategy Atlas kit (meta/atlas-kit.js, a UMD script owned by the meta
 * analyzer) as an ES module, for the spots on the board. It runs with a local `module`, so it never sets
 * window.AtlasKit and a kit the host page loaded keeps winning (src/data/atlas.ts prefers it). ATLAS_KIT overrides the
 * path; with no file, the module is null and the viewer draws no spots.
 */
export function atlasKit(): Plugin {
    const file = path.resolve(process.env.ATLAS_KIT ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'meta', 'atlas-kit.js'));
    return {
        name: 'atlas-kit',
        resolveId: (id) => (id === ID ? `\0${ID}` : null),
        load(id) {
            if (id !== `\0${ID}`) {
                return null;
            }
            if (!fs.existsSync(file)) {
                this.warn(`no Atlas kit at ${file}: the viewer will draw no Atlas spots (set ATLAS_KIT to the file)`);
                return 'export default null;';
            }
            this.addWatchFile(file);
            return `const module = { exports: {} };\n${fs.readFileSync(file, 'utf8')}\nexport default module.exports;\n`;
        }
    };
}
