'use strict';
/**
 * Ed25519 crypto primitives built on Node's native `crypto` module — no
 * external dependencies. Used by the Registry (root key + human/agent keys),
 * the Broker (session/token signing), and the Audit Chain (entry signing).
 */
const crypto = require('crypto');

function generateKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  };
}

function toKeyObject(b64, kind) {
  const der = Buffer.from(b64, 'base64');
  if (kind === 'public') {
    return crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
  }
  return crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}

/**
 * Canonical JSON stringify with sorted keys, so signatures and hashes are
 * deterministic regardless of property insertion order.
 *
 * Undefined values follow JSON semantics: an object key whose value is
 * undefined is omitted, and an undefined array element becomes null. This
 * matters because hashed records are persisted with JSON.stringify, which
 * drops those keys — without matching that behaviour here, a record's hash
 * would change across a save/load round trip and every stored signature
 * would fail to verify.
 */
function canonicalize(value) {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalize(v) ?? 'null').join(',')}]`;
  }
  const parts = [];
  for (const key of Object.keys(value).sort()) {
    const encoded = canonicalize(value[key]);
    if (encoded === undefined) continue; // omit undefined keys, as JSON does
    parts.push(`${JSON.stringify(key)}:${encoded}`);
  }
  return `{${parts.join(',')}}`;
}

function sign(payloadObj, privateKeyB64) {
  const encoded = canonicalize(payloadObj);
  if (encoded === undefined) throw new Error('Cannot sign an undefined payload');
  const data = Buffer.from(encoded, 'utf8');
  const key = toKeyObject(privateKeyB64, 'private');
  return crypto.sign(null, data, key).toString('base64');
}

function verify(payloadObj, signatureB64, publicKeyB64) {
  try {
    const encoded = canonicalize(payloadObj);
    if (encoded === undefined || typeof signatureB64 !== 'string') return false;
    const data = Buffer.from(encoded, 'utf8');
    const key = toKeyObject(publicKeyB64, 'public');
    return crypto.verify(null, data, key, Buffer.from(signatureB64, 'base64'));
  } catch (_e) {
    return false;
  }
}

function sha256(obj) {
  const encoded = canonicalize(obj);
  if (encoded === undefined) throw new Error('Cannot hash an undefined value');
  return crypto.createHash('sha256').update(encoded).digest('hex');
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

module.exports = { generateKeyPair, sign, verify, sha256, canonicalize, randomId };
