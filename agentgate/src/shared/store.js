'use strict';
/**
 * JSON-file persistence with atomic writes.
 *
 * Writes go to a temp file in the same directory and are then renamed over
 * the target. `rename` is atomic within a filesystem, so a crash mid-write
 * leaves the previous good file intact rather than a truncated one — which
 * matters here because a corrupted registry or audit log is a security
 * incident, not just a data-loss one.
 *
 * Files are created with mode 0600 (owner read/write only): the registry
 * holds public keys and the broker key file holds a private key, and
 * neither should be world-readable.
 *
 * To move to Postgres, reimplement `load`/`save` — nothing else in the
 * codebase touches the filesystem.
 */
const fs = require('fs');
const path = require('path');

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

class JsonStore {
  constructor(filePath, defaultValue) {
    this.filePath = filePath;
    this.default = defaultValue;
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: DIR_MODE });
    if (!fs.existsSync(filePath)) {
      this.save(defaultValue);
    }
  }

  load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      return JSON.parse(raw);
    } catch (err) {
      if (err.code === 'ENOENT') return this.default;
      throw new Error(`Corrupt or unreadable state file ${this.filePath}: ${err.message}`);
    }
  }

  save(data) {
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: FILE_MODE });
    fs.renameSync(tmp, this.filePath);
  }
}

module.exports = { JsonStore };
