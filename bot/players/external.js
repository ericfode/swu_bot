'use strict';

// v1 name of the bot-program client: `new ExternalBot(name, { cmd, args })` still works and now speaks protocol v2
// (bot/stdio.js StdioClient, spec/protocol.md). v1 programs keep working through the referee's version check.
const { StdioClient } = require('../stdio');

module.exports = { ExternalBot: StdioClient };
