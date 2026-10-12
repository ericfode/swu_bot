'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { digest } = require('./coverage');
const { sha256 } = require('../inventory');
const repo = path.resolve(__dirname, '../../..');
// Full local import closure is available, instead of pretending an excerpt
// captures every inherited default. Reviewers navigate its source inventory.
function sourceBundle(entries, destination, server = path.join(repo, 'forceteki/server')) {
    const { ts } = require('../../card-compiler/compiler');
    const files = new Map(),
        missing = new Set(),
        visited = new Set();
    const queue = entries.filter((e) => e.sourcePath).map((e) => e.sourcePath);
    queue.push('game/AbilityHelper.ts', 'game/core/gameSteps/AbilityResolver.ts');
    while (queue.length) {
        const relative = queue.shift();
        if (visited.has(relative)) continue;
        visited.add(relative);
        const file = path.resolve(server, relative);
        assert.ok(file.startsWith(path.resolve(server) + path.sep), 'Dependency escaped engine source');
        if (!fs.existsSync(file)) {
            missing.add(relative);
            continue;
        }
        const text = fs.readFileSync(file, 'utf8'),
            dependencies = [];
        const source = ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true);
        const specifiers = new Set();
        function imports(node) {
            if (
                (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
                node.moduleSpecifier &&
                ts.isStringLiteral(node.moduleSpecifier)
            )
                specifiers.add(node.moduleSpecifier.text);
            if (
                ts.isCallExpression(node) &&
                (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
                    (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
            ) {
                if (node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]))
                    specifiers.add(node.arguments[0].text);
                else missing.add(relative + ' -> dynamic module reference');
            }
            ts.forEachChild(node, imports);
        }
        imports(source);
        for (const spec of specifiers) {
            if (!spec.startsWith('.')) continue;
            const base = path.resolve(path.dirname(file), spec.replace(/\.js$/, ''));
            const resolved = [
                base + '.ts',
                base + '.js',
                path.join(base, 'index.ts'),
                path.join(base, 'index.js'),
            ].find((f) => fs.existsSync(f));
            if (!resolved) {
                missing.add(relative + ' -> ' + spec);
                continue;
            }
            const dep = path.relative(server, resolved).split(path.sep).join('/');
            dependencies.push(dep);
            queue.push(dep);
        }
        const bytes = Buffer.from(text),
            hash = sha256(bytes),
            artifact = 'sources/' + hash + path.extname(file);
        fs.mkdirSync(path.join(destination, 'sources'), { recursive: true });
        if (!fs.existsSync(path.join(destination, artifact))) fs.writeFileSync(path.join(destination, artifact), bytes);
        files.set(relative, { path: 'forceteki/server/' + relative, sha256: hash, artifact, dependencies });
    }
    return { files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)), unresolved: [...missing].sort() };
}
function implementationSnapshot() {
    const paths = [
        'Cargo.toml',
        'Cargo.lock',
        'bot/omni-rs/Cargo.toml',
        'bot/omni-rs/build.rs',
        'bot/omni-wasm/Cargo.toml',
        'bot/card-compiler/compiler.js',
        'bot/card-compiler/build.js',
        'bot/omni/rs/state.js',
        'bot/omni/rs/make-pool.js',
    ];
    for (const dir of ['bot/omni-rs/src', 'bot/omni-wasm/src', 'bot/cards/pipeline']) {
        for (const file of fs
            .readdirSync(path.join(repo, dir), { recursive: true })
            .filter((f) => /\.(rs|js)$/.test(f)))
            paths.push(dir + '/' + file);
    }
    return [...new Set(paths)]
        .sort()
        .map((relative) => ({ path: relative, sha256: sha256(fs.readFileSync(path.join(repo, relative))) }));
}
function createPacket({
    catalogue,
    catalogueSha256,
    implementationBefore,
    plans,
    coverage,
    comparisons,
    mutations,
    rules,
    out,
}) {
    const entries = plans.map((p) => catalogue.cards.find((c) => c.setCode === p.cardId));
    const engine = sourceBundle(entries, out);
    for (const entry of entries.filter((e) => e.sourcePath))
        assert.equal(
            engine.files.find((f) => f.path === 'forceteki/server/' + entry.sourcePath)?.sha256,
            entry.sourceHash,
            'Card source differs from compiled configuration',
        );
    const inputs = new Map(catalogue.inputs.map((f) => [f.file, f.sha256]));
    for (const file of engine.files)
        assert.equal(
            file.sha256,
            inputs.get(file.path.replace('forceteki/', '')),
            'Engine dependency differs from compiled source: ' + file.path,
        );
    const snapshot = implementationSnapshot();
    assert.deepEqual(snapshot, implementationBefore, 'Implementation inventory changed after build began');
    const sources = snapshot.map((source) => {
        assert.equal(
            source.sha256,
            implementationBefore?.find((f) => f.path === source.path)?.sha256,
            'Implementation changed after build began: ' + source.path,
        );
        const artifact = 'sources/' + source.sha256 + path.extname(source.path);
        fs.mkdirSync(path.join(out, 'sources'), { recursive: true });
        fs.copyFileSync(path.join(repo, source.path), path.join(out, artifact));
        assert.equal(
            sha256(fs.readFileSync(path.join(out, artifact))),
            source.sha256,
            'Implementation changed during packet copy',
        );
        return { ...source, artifact };
    });
    const packet = {
        schema: 'swu-card-review-packet/v1',
        catalogueSha256,
        canonicalCatalogueSha256: digest(catalogue),
        engine,
        implementation: sources,
        rules,
        cards: entries.map((entry) => ({
            cardId: entry.setCode,
            printedCard: entry.card,
            sourcePath: entry.sourcePath,
            sourceHash: entry.sourceHash,
            configuration: entry.abilities,
            attachCondition: entry.attachCondition ?? null,
            intrinsicKeywordValues: entry.keywordValues ?? {},
            diagnostics: entry.diagnostics,
            probes: plans.find((p) => p.cardId === entry.setCode),
            coverage: coverage.find((c) => c.cardId === entry.setCode),
        })),
        comparisons,
        mutations,
        instructions: [
            'Review printed card text against full Karabast source and inherited helper defaults before reading the generated configuration.',
            'Compare source to typed IR, then IR to generated Rust and shared runtime primitives. Trace agreement is independent evidence, not a specification.',
            'Check evaluation time, binding scope, eligible versus effective targets, costs, cancellation, optionality, event identity, continuation success, phase expiry and interactions.',
            'Inspect uncovered obligations and source branches absent from the IR. Request distinguishing experiments for ambiguity.',
            'Classify text versus Karabast discrepancies as baseline findings; source-to-IR differences as conversion findings; IR-to-Rust differences as runtime findings.',
            'Return swu-card-review/v1 JSON bound to packetSha256, with reviewer model/effort and every selected card. Each card has verdict, findings, uncoveredReviewed; each uncoveredReviewed item has id and assessment covering every uncovered obligation; each finding has category, kind, summary, sourceRefs.',
        ],
    };
    fs.writeFileSync(path.join(out, 'packet.json'), JSON.stringify(packet, null, 2) + '\n');
    fs.writeFileSync(
        path.join(out, 'README.md'),
        '# Semantic review\n\nPacket SHA-256: `' +
            digest(packet) +
            '`\n\n' +
            packet.instructions.map((s) => '- ' + s).join('\n') +
            '\n\nSource files are content-addressed in `sources/`; packet paths retain their original identity. Unresolved imports remain explicit. No LLM verdict is inferred from passing tests.\n',
    );
    return packet;
}
module.exports = { sourceBundle, createPacket, implementationSnapshot };
