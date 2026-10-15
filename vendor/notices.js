'use strict';
// Third-party notices for the vendored builds (vendor/README.md). refresh.js calls these from the temporary folder it
// built in, so vendor/notices/<name>.md always lists what the files in vendor/<name>/ bundle: every package, its
// version and license, and the license texts the package ships (each text once).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const LICENSE_FILE = /^(licen[cs]e|copying|notice|unlicense)/i;

function licenseTexts(dir) {
    return fs.readdirSync(dir).filter((f) => LICENSE_FILE.test(f) && fs.statSync(path.join(dir, f)).isFile()).sort()
        .map((f) => fs.readFileSync(path.join(dir, f), 'utf8').replace(/\r\n/g, '\n').trim());
}

// The viewer kit: the packages are the node_modules folders its source map names (a second build with a source map,
// into a folder of its own). Tailwind's generated styles are in the kit too, with no module of their own in the map.
function holotable(src, root) {
    const out = path.join(src, '.notices-kit');
    const env = { ...process.env, ATLAS_KIT: path.join(root, 'meta', 'atlas-kit.js') };
    execFileSync('npx', ['vite', 'build', '--config', 'vite.kit.config.ts', '--mode', 'kit', '--sourcemap', '--outDir', out, '--logLevel', 'error'], { cwd: src, env, stdio: 'inherit' });
    const map = JSON.parse(fs.readFileSync(path.join(out, 'swu-viewer-kit.js.map'), 'utf8'));
    const dirs = new Set([path.join(src, 'node_modules', 'tailwindcss')]);
    for (const source of map.sources) {
        const i = source.lastIndexOf('node_modules/');
        if (i < 0) {
            continue;
        }
        const [scope, name] = source.slice(i + 'node_modules/'.length).split('/');
        dirs.add(path.resolve(out, source.slice(0, i), 'node_modules', scope.startsWith('@') ? `${scope}/${name}` : scope));
    }
    return [...dirs].map((dir) => {
        const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
        return { name: pkg.name, version: pkg.version, license: pkg.license, url: `https://www.npmjs.com/package/${pkg.name}`, texts: licenseTexts(dir) };
    });
}

// Kessel's Node package: the crates compiled into the WebAssembly (kessel-wasm's normal dependencies on wasm32; macros
// only run at build time), and forceteki, whose card code the card catalog is compiled from.
function kessel(src, root) {
    const cargo = (args) => execFileSync('cargo', args, { cwd: src, encoding: 'utf8', maxBuffer: 256 << 20 });
    const tree = cargo(['tree', '-q', '-p', 'kessel-wasm', '-e', 'normal,no-proc-macro', '--target', 'wasm32-unknown-unknown', '--prefix', 'none', '--format', '{p}']);
    const wanted = new Set(tree.split('\n').map((line) => line.replace(/ \(.*$/, '').trim()).filter(Boolean));
    const meta = JSON.parse(cargo(['metadata', '-q', '--format-version', '1', '--filter-platform', 'wasm32-unknown-unknown']));
    const crates = meta.packages.filter((p) => p.source && wanted.has(`${p.name} v${p.version}`)).map((p) => ({
        name: p.name, version: p.version, license: p.license, url: `https://crates.io/crates/${p.name}`, texts: licenseTexts(path.dirname(p.manifest_path))
    }));
    const ft = [path.join(src, 'LICENSE.forceteki'), path.join(root, 'forceteki', 'LICENSE')].find((f) => fs.existsSync(f));
    if (!ft) {
        throw new Error('no forceteki license: run git submodule update --init forceteki');
    }
    const forceteki = { name: 'forceteki (card code)', version: "Kessel's pin", license: 'MIT', url: 'https://github.com/SWU-Karabast/forceteki', texts: [fs.readFileSync(ft, 'utf8').trim()] };
    return [forceteki, ...crates];
}

// Holocron's JEPA bot: its own player file (no imports) and its own two models, so nothing third-party.
function jepa() {
    return [];
}

function render(name, repo, commit, packages) {
    const texts = [];
    const rows = [...packages].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version)).map((p) => {
        const refs = p.texts.map((text) => {
            let i = texts.indexOf(text);
            if (i < 0) {
                i = texts.push(text) - 1;
            }
            return `[T${i + 1}](#t${i + 1})`;
        });
        return `| [${p.name}](${p.url}) | ${p.version} | ${p.license || 'see its page'} | ${refs.join(' ') || 'none shipped'} |`;
    });
    const head = [`# Third-party notices: vendor/${name}`, '', `The built files in \`vendor/${name}/\` come from ${repo} at \`${commit.slice(0, 7)}\`.`];
    if (!packages.length) {
        return [...head, 'They bundle no third-party packages.', '`vendor/refresh.js` writes this file with every refresh; never edit it by hand.', ''].join('\n');
    }
    return [
        ...head,
        'They bundle the packages below, each under its own license. The license texts the packages ship follow the table,',
        'each text once. `vendor/refresh.js` writes this file with every refresh; never edit it by hand.',
        '',
        '| Package | Version | License | Texts |',
        '|---|---|---|---|',
        ...rows,
        '',
        '## License texts',
        ...texts.flatMap((text, i) => ['', `### T${i + 1}`, '', '````text', text, '````']),
        ''
    ].join('\n');
}

// What the build of vendor/<name> bundles; every target in refresh.js needs an entry here (an empty list for none).
function list(name, src, root) {
    const of = { holotable, kessel, jepa }[name];
    if (!of) {
        throw new Error(`vendor/notices.js has no entry for ${name}: add one that lists what its build bundles`);
    }
    return of(src, root);
}

module.exports = { list, render };
