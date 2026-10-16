'use strict';
// Pack a CommonJS bot program and the files it requires into one script for Javy (QuickJS compiled to WebAssembly).
//
//   node bot/compiled/js/bundle.js bot/test/fixtures/search-bot.js node-search > search-bot.bundle.js
//
// The entry runs as the main module (`require.main === module`) with process.argv = ['javy', <entry>, ...args]: Javy
// has no command line, so the arguments are fixed at build time. Two substitutions make Node code run there:
// bot/stdio.js becomes js/serve.js (Javy.IO instead of Node streams) and 'crypto' becomes js/crypto.js (sha1 only).
// Any other Node built-in is a build error. A require must be a string literal; one in a comment line is skipped.
// bundle(entry, args, {root}) packs only files inside root (a submitted bot's folder): a require that leads out of it is
// an error, so nothing else on the machine can end up in the bot. QuickJS names a place in the script function.mjs:LINE;
// build() also gives which lines hold which file, sourcePositions() turns such places into the bot's file and line, and
// the script carries the same as globalThis.__where (js/serve.js uses it for a stack it logs).

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const SWAP = { [path.join(ROOT, 'bot', 'stdio.js')]: path.join(__dirname, 'serve.js') };
const BUILTINS = { crypto: path.join(__dirname, 'crypto.js') };

/** require('x') specifiers in code lines, in order of first use. */
function requires(source) {
    const out = [];
    for (const line of source.split('\n')) {
        const t = line.trim();
        if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) {
            continue;
        }
        for (const m of line.matchAll(/\brequire\(\s*(['"])([^'"]+)\1\s*\)/g)) {
            if (!out.includes(m[2])) {
                out.push(m[2]);
            }
        }
    }
    return out;
}

function resolve(spec, from, root = null) {
    const shown = path.relative(root ?? ROOT, from);
    if (spec.startsWith('node:') || !/^\.{0,2}\//.test(spec)) {
        const name = spec.replace(/^node:/, '');
        if (BUILTINS[name]) {
            return BUILTINS[name];
        }
        throw new Error(`${shown}: require('${spec}') is not available in a compiled bot`);
    }
    const base = path.resolve(path.dirname(from), spec);
    for (const f of [base, `${base}.js`, `${base}.json`, path.join(base, 'index.js')]) {
        if (root && !(f.startsWith(root + path.sep) && fs.existsSync(f) && fs.realpathSync(f).startsWith(fs.realpathSync(root) + path.sep))) {
            continue;
        }
        if (fs.existsSync(f) && fs.statSync(f).isFile()) {
            return SWAP[f] ?? f;
        }
    }
    throw new Error(`${shown}: cannot find '${spec}'${root ? ' in the bot\'s folder' : ''}`);
}

/**
 * Text with each place in a bundled script that QuickJS names (function.mjs:LINE, or function.mjs:LINE:COLUMN) given
 * as the bot's own file and line; `sources` is build()'s [first line, last line, file] for each file. A place on one of
 * the bundle's own lines stays as it is.
 */
function sourcePositions(text, sources) {
    return String(text).replace(/function\.mjs:(\d+)(:\d+)?/g, (all, n, col) => {
        const at = sources.find(([from, to]) => Number(n) >= from && Number(n) <= to);
        return at ? `${at[2]}:${Number(n) - at[0] + 1}${col ?? ''}` : all;
    });
}

/** The bundled script, as a string. */
function bundle(entry, args = [], opts = {}) {
    return build(entry, args, opts).script;
}

/** {script, sources}: the bundled script, and the lines of the script each file's own lines are on ([first, last, file]). */
function build(entry, args = [], { root = null } = {}) {
    root = root && path.resolve(root);
    const files = [];
    const index = new Map();
    const add = (file) => {
        if (!index.has(file)) {
            index.set(file, files.length);
            files.push({ file, deps: {} });
            const me = files[files.length - 1];
            const source = fs.readFileSync(file, 'utf8');
            me.source = source;
            if (!file.endsWith('.json')) {
                for (const spec of requires(source)) {
                    me.deps[spec] = add(resolve(spec, file, root));
                }
            }
        }
        return index.get(file);
    };
    const main = path.resolve(entry);
    if (root && !main.startsWith(root + path.sep)) {
        throw new Error(`${entry}: the entry must be inside ${root}`);
    }
    add(main);
    const rel = (f) => path.relative(root && f.startsWith(root + path.sep) ? root : ROOT, f).split(path.sep).join('/');
    // each file's lines start on the line after its header: line 4 is the first header (three lines come before it)
    const sources = [];
    let line = 4;
    const defs = files.map(({ file, deps, source }) => {
        const body = file.endsWith('.json') ? `module.exports = ${source.trim()};` : source;
        const n = body.split('\n').length;
        sources.push([line + 1, line + n, rel(file)]);
        line += n + 2;
        return `[${JSON.stringify(rel(file))}, ${JSON.stringify(deps)}, function (exports, require, module, __filename, __dirname) {\n${body}\n}]`;
    });
    const script = [
        `// bundled by bot/compiled/js/bundle.js from ${rel(main)}; do not edit`,
        `globalThis.process = { argv: ${JSON.stringify(['javy', rel(main), ...args])}, env: {}, exitCode: 0 };`,
        `const __defs = [\n${defs.join(',\n')}\n];`,
        `globalThis.__where = (text) => (${sourcePositions})(text, ${JSON.stringify(sources)});`,
        'const __cache = [];',
        'function __load(id) {',
        '    if (__cache[id]) return __cache[id].exports;',
        '    const [file, deps, fn] = __defs[id];',
        '    const module = { id: file, exports: {} };',
        '    __cache[id] = module;',
        '    const require = (spec) => {',
        '        if (!(spec in deps)) throw new Error(`${file}: require(\'${spec}\') is not in this bundle`);',
        '        return __load(deps[spec]);',
        '    };',
        '    require.main = __cache[0];',
        "    fn.call(module.exports, module.exports, require, module, '/bot/' + file, '/bot/' + file.replace(/\\/?[^/]*$/, ''));",
        '    return module.exports;',
        '}',
        '__load(0);',
        ''
    ].join('\n');
    return { script, sources };
}

module.exports = { bundle, build, sourcePositions, requires };
if (require.main === module) {
    const [entry, ...args] = process.argv.slice(2);
    if (!entry) {
        console.error('usage: node bot/compiled/js/bundle.js <entry.js> [args...]');
        process.exit(2);
    }
    process.stdout.write(bundle(entry, args));
}
