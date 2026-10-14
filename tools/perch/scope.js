'use strict';
// What Perch reads. Eric's call (2026-10-11): the shared core of the project, meaning game running,
// coordination, the bot protocol, viewers, analysis, research tooling and dashboards, and not the
// code of specific bots. This repo holds the arena's part of that core (the research and the bots are in
// holocron, the Rust simulator in kessel, the viewer in holotable). Tests are left out too. Only source
// files are read, and built bundles (over 256 KB or minified) are skipped. perch runs in a snapshot that
// holds only these files, so Jev never sees anything else, not even as the caller or callee of a core
// method.
// It is an allow-list: a new bot in bot/players/ or in its own folder under bot/ is out of scope with
// no change here, and a new shared folder must be added to `include`. Globs: `*` stays within one
// directory, `**` crosses directories.
module.exports = {
  // Paths in this repo, as committed at HEAD.
  repo: {
    include: [
      'bot/*.js', // engine wrapper, match, ladder and tournament runners, recorder, ratings, stdio tools
      'bot/players/index.js', // the bot registry
      'bot/arena/**', // the arena: API, MCP and HTTP servers, referee, registry, dashboard writer
      'bot/compiled/**', // builds any bot as a sandboxed WebAssembly bundle, and runs it
      'spec/**',
      'app/**', // the SWU Arena app: one page to watch the arena and read the research
      'meta/**', // the Strategy Atlas kit the app and the viewer kit use
      'tools/**',
    ],
    exclude: [
      'bot/arena/starters/**', // starter bots copied into new arena players
      'vendor/**', // other repositories' builds (vendor/README.md)
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
      'viewer-kit/swu-viewer-kit.*', // Holotable's build (vendor/holotable in the repo)
      '**/node_modules/**',
    ],
  },
};
