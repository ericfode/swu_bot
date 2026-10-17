'use strict';
// The same small, structured entry point for the hosted and stdio MCP servers. No setup or bot code runs here.
function localHelp({ owner = 'your-login', competitor } = {}) {
    const login = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(owner) ? owner : 'your-login';
    const name = typeof competitor === 'string' && /^[a-z][a-z0-9_]{0,31}$/.test(competitor) ? ` --name ${competitor}` : '';
    const run = `npm run dev -- ../my-bot --owner ${login}${name}`;
    return {
        topic: 'local', runner: 'bot/dev.js (npm run dev): the arena intake, WASI sandbox and play-seed runner; no uploads',
        setup: {
            requires: ['Git and repository access', 'Node 22 (.nvmrc; nvm commands below require nvm)', 'Python 3 with venv', 'macOS or Linux; setup downloads pinned tools and current card data'],
            commands: ['git clone --recurse-submodules https://github.com/ericfode/swu_bot.git', 'cd swu_bot', 'nvm install', 'nvm use', 'npm run setup', 'node bot/dev.js --help'],
            builds: 'setup installs locked dependencies, builds the pinned forceteki engine, fetches cards, and prepares Wasmtime, Javy and CPython for WASI. No arena service credentials required.'
        },
        candidate: {
            folder: '../my-bot holds only the files to submit: bot.py, bot.js, or a ready WASM bundle with arena.json. Replace this path with your bot folder.',
            buildAndCheck: `${run} --games 0`,
            checkMeaning: 'Builds/packages and executes the candidate handshake in the established sandbox; no matches. Run only when you intend to test that candidate.',
            nativeWasmBuild: 'For a Rust WASI source project: rustup target add wasm32-wasip1; cargo build --release --target wasm32-wasip1. Copy the resulting .wasm into a bundle with arena.json; validate it with python3 -I bot/compiled/bundle.py <bundle-folder>. JS and Python are packaged by the harness.'
        },
        protocol: {
            version: 2, manifest: { schema: 'swu-arena-bot/1', protocol: 2, kind: 'wasm', platform: 'wasm32-wasip1', runtime: 'wasi-p1', run: { cmd: './bot.wasm', args: [] }, network: 'none' },
            requirements: ['The manifest schema /1 is distinct from bot protocol 2. Include entry_sha256 for the entry file and build.commit/source/toolchain when known.', 'hello intentionally uses the negotiation envelope v:1 with versions:[2] in the v2-only arena; choose protocol 2 with exactly {"t":"ready","v":2}. Missing v or v:1 is incompatible with the v2-only arena.', 'Read newline-delimited JSON from stdin; reply JSON lines on stdout, logs on stderr. On decide, return {"t":"act","i":<legal action index>}; on over, return {"t":"ok"}.', 'Use hello.cards and hello.seed. Omit manifest cards; the sandbox has no card folder, network or service credentials.'],
            details: 'arena_guide {"topic":"protocol"}; spec/protocol.md; bot/compiled/README.md. A v2 manifest alone is not verified ready.v:2 evidence; the sandboxed intake check makes that decision.'
        },
        opponents: {
            discover: 'arena_opponents {} lists only current-round bundles with verified v2 handshake evidence bound to the exact tar hash and active arena/engine/runner context, under the existing tables access rules. Empty means none eligible/cached yet; private submissions and arbitrary old hashes are unavailable.',
            select: 'arena_download_opponent {"name":"<exact catalog name>","sha256":"<exact catalog hash>"} returns an authenticated download descriptor, not executable code or a local file.',
            command: 'node bot/arena/download-opponent.js --arena https://swu-arena.fly.dev --name <catalog-name> --sha256 <catalog-sha256> --out ../opponents',
            authorization: 'The helper uses your existing ARENA_TOKEN OAuth token from the environment; never paste tokens into commands, source, logs, URLs or submissions. Sign in/connect normally if access is missing. It does not obtain credentials or expand access.',
            verification: 'The helper pins the selected version and SHA256, downloads only the same-origin catalog URL with no redirects, checks the canonical uncompressed tar hash, and calls bundle.py unpack/load (no links, traversal or overwrite). It writes a new bundle folder and separate provenance.json. It never executes the bundle.',
            provenance: 'sha256 is the whole canonical uncompressed tar, distinct from arena.json.entry_sha256. Manifest build metadata is a provenance claim, not an authenticity guarantee. Keep the returned origin, version, hash and provenance with your results.'
        },
        test: {
            baseline: `${run} --vs heuristic,rush --games 4 --seed 4242 --jobs 1`,
            downloadedOpponent: `${run} --vs <downloaded-bundle-folder> --games 4 --seed 4242 --jobs 1`,
            consent: 'Downloading is not execution. Choose opponents deliberately; only the explicit dev command packages/start-checks them and runs matches in the existing WASI sandbox. Never run downloaded .wasm directly, as native code, or load downloaded .cwasm.',
            limits: 'Both seats per seed; games rounded up to even. Default 60 seconds thinking per bot/game, 6000 steps. --cap-sec accepts 10..600; --jobs controls concurrency. Three equivalent candidate failures stop early unless --all.',
            reproducibility: 'Keep --seed, both bundle/source hashes, repo and engine commits, toolchain, deck file and card-data hash fixed. run.json records the seed, bundle ids, cards and deals. Javy builds can differ bytewise with identical source; pin downloaded bytes. npm run setup may fetch newer card data.',
            snapshotCommands: ['git rev-parse HEAD', 'git -C forceteki rev-parse HEAD', 'cat forceteki/test/json/card-data-hash.txt'],
            results: 'Runs are in ../my-bot/.runs/<run>/: run.json, index.json, ladder.json, games/*.jsonl and bots/ transcripts/stderr. Check W-L-D, own faults, no-result games, thinking time and memory; small local samples are not arena ranks. Trusted heuristic/rush run in process locally and can differ from hosted ports.',
            exitCodes: { 0: 'All games ended and no candidate loss by its own fault; ordinary losses are allowed.', 1: 'Bot fault, no result or job failure.', 2: 'Usage error or missing sandbox/setup.', 3: 'The intake refused a bot; fix the printed reason.' },
            inspect: ['node bot/dev.js --view <run-folder>', `${run} --again <run-folder>/bots/<game>.<seat>.in.jsonl`]
        },
        troubleshooting: [
            'Missing engine/cards/Wasmtime/Javy/CPython: use Node 22 and rerun npm run setup. Unsupported Javy platforms can use Python or prebuilt WASI bundles.',
            '401/403: reconnect your existing authorized account; tables/download access follows current site settings and invites. Never retry with project/helper credentials.',
            'No opponents, 404 or 503: no eligible current-round bundle, changed lineup, or sleeping/unavailable games machine. Refresh the catalog later; do not guess hashes or private paths.',
            'Hash mismatch, unsafe tar, invalid manifest, incompatible protocol: discard the download and refresh the catalog. The helper leaves no admitted bundle on failure.',
            'Handshake failure: use explicit ready.v:2, flush stdout, keep logs on stderr, read cards from hello.cards. A v2 manifest cannot repair a v1 program.',
            'Repeated no-op decisions can hit the step cap. Use the printed replay/again command; engine errors and no-result games are not normal scored wins. Reproduction of a timeout needs the original seeded run and time cap.'
        ]
    };
}

const HELP_DESCRIPTION = 'How to set up, build and test locally with the existing arena harness, select/download authorized v2 WASM opponents, verify hashes, reproduce seeds, and interpret failures. Read before local testing.';
module.exports = { localHelp, HELP_DESCRIPTION };
