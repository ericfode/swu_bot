'use strict';
// What Perch reads. Eric's call (2026-10-11): the shared core of the project, meaning game running,
// coordination, the bot protocol, viewers, analysis and research dashboards, and not the code of
// specific bots. Bot code lives in bot/players/ and bot/<language>/, so a new bot is out of scope
// without any change here. Add a new shared directory to `include`; add a bot file that sits
// elsewhere to `exclude`. Globs: `*` stays within one directory, `**` crosses directories.
module.exports = {
  // Paths in this repo, as committed at HEAD.
  repo: {
    include: [
      'bot/*.js', // engine wrapper, match, ladder and tournament runners, recorder, ratings, stdio adapter tools
      'bot/players/index.js', // the bot registry
      'bot/players/external.js', // the stdio protocol adapter for out-of-process bots
      'bot/test/**',
      'spec/**',
      'viewer/**',
      'studio/**',
      'analysis/**',
      'meta/**',
      'importer/**',
      'tools/**',
    ],
    exclude: [
      'bot/test/bots.test.js', // tests of the bots' choices
    ],
  },
  // Code in the shared project folder (not in git). `perch shared ...` copies it into a scratch git
  // repo under .perch/shared and runs perch there.
  shared: {
    root: '/mnt/project-files',
    include: ['dashboard/**', 'viewer-kit/**', 'arena/**', 'research/**'],
    exclude: [
      'arena/agents/**', // copies of arena players' bots
      'arena/versions/**',
      'arena/archive/**',
      'viewer-kit/swu-viewer-kit.mjs', // built from studio/ in the repo
      '**/node_modules/**',
    ],
  },
};
