'use strict';
// What Perch reads. Eric's call (2026-10-11): the shared core of the project, meaning game running,
// coordination, the bot protocol, viewers, analysis, research tooling and dashboards, and not the
// code of specific bots. Tests are left out too. Only source files are read, and built bundles
// (over 256 KB or minified) are skipped. perch runs in a snapshot that holds only these files, so
// Jev never sees anything else, not even as the caller or callee of a core method.
// It is an allow-list: a new bot in bot/players/ or in its own folder under bot/ is out of scope with
// no change here, and a new shared folder must be added to `include`. Globs: `*` stays within one
// directory, `**` crosses directories.
module.exports = {
  // Paths in this repo, as committed at HEAD.
  repo: {
    include: [
      'bot/*.js', // engine wrapper, match, ladder and tournament runners, recorder, ratings, stdio tools
      'bot/players/index.js', // the bot registry
      'bot/players/external.js', // the stdio protocol adapter for out-of-process bots
      'bot/arena/**', // the arena: API, MCP and HTTP servers, referee, registry, dashboard writer
      'bot/info/**', // knowledge-dial research
      'bot/eval/**', // position-evaluation study: evaluators, scoring, dashboard curves and panels
      'bot/tools/**',
      'bot/learn/collect.js', // trajectory collector for any bot
      'bot/learn/eval.js', // head-to-head runner for any two bots
      'bot/omni/lens.js', // writes the per-card lens files the viewers show
      'bot/karabast/**', // Karabast socket client, frame reader and spectate recorder (any bot, any game)
      'bot/compiled/**', // builds any bot as a sandboxed WebAssembly bundle, and runs it
      'spec/**',
      'app/**', // the SWU Arena app: one page to watch the arena and read the research
      'studio/**',
      'analysis/**',
      'meta/**',
      'importer/**',
      'tools/**',
    ],
    exclude: [
      'bot/arena/starters/**', // starter bots copied into new arena players
      'bot/eval/bot.js', // the h@<evaluator> bots
      'bot/determinism-check.js', // checks the heuristic bot's playouts
      'bot/determinize-check.js', // checks the ISMCTS bot's belief model
      'bot/ismcts-panel.js', // the ISMCTS bots' own dashboard panel
      '**/test/**', // tests, by folder or by name
      '**/*.test.*',
      '**/*-test.*',
      '**/*_test.*',
      '**/test_*',
    ],
  },
  // Code in the shared project folder (not in git). `perch shared ...` copies it into a scratch git
  // repo under .perch/shared and runs perch there. The arena's code is in the repo (bot/arena);
  // the folder's arena/ holds copies of players' bots.
  shared: {
    root: '/mnt/project-files',
    include: ['dashboard/**', 'viewer-kit/**', 'research/**', 'env/**'],
    exclude: [
      'dashboard/build.v*.mjs', // old copies of build.mjs
      'dashboard/site/*.v*.cjs', // old copies of core.cjs
      'viewer-kit/swu-viewer-kit.*', // built from studio/ in the repo
      '**/node_modules/**',
    ],
  },
};
