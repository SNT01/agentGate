'use strict';
/**
 * Traversal-safe static file serving for the optional dashboard build.
 *
 * There is no `fs`-based serving anywhere else in the broker — this is the
 * one place that reads from disk in response to a URL, so it is also the
 * one place a path-traversal bug could appear. `resolveAsset` normalizes
 * the requested path and refuses anything that resolves outside the
 * configured asset root, full stop.
 *
 * The dashboard build is optional: `npm run broker` must keep working with
 * no `ui/` build present. When the asset root doesn't exist, `serveUi`
 * returns a plain-text explanation instead of a crash or a bare 404.
 */
const fs = require('fs');
const path = require('path');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

/**
 * Resolve `urlPath` (e.g. '/ui/assets/app.js') against `assetRoot`, stripping
 * the `/ui` prefix, defaulting to index.html for the SPA root and for any
 * path with no file extension (client-side routing), and refusing to
 * resolve outside `assetRoot` under any input including `..` segments,
 * encoded traversal sequences, or absolute paths.
 *
 * @returns {{filePath: string, contentType: string} | null} null if the
 *   resolved path escapes the asset root or does not exist.
 */
function resolveAsset(assetRoot, urlPath) {
  let rel = urlPath.replace(/^\/ui\/?/, '');
  if (rel === '') rel = 'index.html';

  // Decode percent-encoding once; reject anything that still looks like a
  // traversal attempt or an absolute/rooted path before touching the disk.
  let decoded;
  try {
    decoded = decodeURIComponent(rel);
  } catch (_e) {
    return null;
  }
  if (decoded.includes('\0')) return null;

  const resolvedRoot = path.resolve(assetRoot);
  const resolved = path.resolve(resolvedRoot, decoded);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
    return null; // escaped the asset root
  }

  let target = resolved;
  if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) {
    // No file extension and nothing on disk: hand back index.html so the
    // SPA's client-side router can take over (e.g. /ui/audit on reload).
    if (!path.extname(decoded)) {
      target = path.join(resolvedRoot, 'index.html');
    }
  }
  if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) return null;

  const ext = path.extname(target);
  return { filePath: target, contentType: MIME_TYPES[ext] || 'application/octet-stream' };
}

/**
 * Serve a dashboard asset for `urlPath`. Always succeeds with a response —
 * never throws — so callers can pass the result straight to `res.writeHead`.
 *
 * @returns {{status: number, contentType: string, body: Buffer|string}}
 */
function serveUi(assetRoot, urlPath) {
  if (!fs.existsSync(assetRoot)) {
    return {
      status: 503,
      contentType: 'text/plain; charset=utf-8',
      body:
        'The AgentGate dashboard has not been built.\n\n' +
        'Run:\n  cd ui && npm ci && npm run build\n\n' +
        `Expected build output at: ${assetRoot}\n`,
    };
  }

  const asset = resolveAsset(assetRoot, urlPath);
  if (!asset) {
    return { status: 404, contentType: 'text/plain; charset=utf-8', body: 'Not found' };
  }

  return { status: 200, contentType: asset.contentType, body: fs.readFileSync(asset.filePath) };
}

module.exports = { serveUi, resolveAsset, MIME_TYPES };
