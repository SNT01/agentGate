'use strict';
/** Shared test fixtures: an isolated data directory per test file. */
const fs = require('fs');
const os = require('os');
const path = require('path');

function tempDataDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `agentgate-${label}-`));
  return dir;
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

module.exports = { tempDataDir, cleanup };
