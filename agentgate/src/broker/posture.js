'use strict';
/**
 * Context (posture) verification — "only from the office, or from an
 * approved context".
 *
 * Two mechanisms are supported:
 *
 *   1. Declared context   — a named context string (`office`, `ci`,
 *                           `device:mbp-12`) matched against the identity's
 *                           allowlist. Simple, and sufficient when the
 *                           context claim itself is bound to a verified
 *                           credential (an agent card pins exactly one).
 *   2. Source IP / CIDR   — `checkSourceIp` matches the request's source
 *                           address against configured office ranges, which
 *                           an attacker outside the network cannot satisfy
 *                           regardless of what context they declare.
 *
 * Production deployments should use both: the declared context selects the
 * policy, and the network check proves the claim. Where stronger assurance
 * is needed, terminate mutual TLS at the edge and pass the verified client
 * certificate subject in as the context instead.
 *
 * Both checks deny by default: an unconfigured allowlist grants nothing.
 */

function checkPosture(context, allowedContexts) {
  if (typeof context !== 'string' || context === '') {
    return { allowed: false, reason: 'no context supplied' };
  }
  if (!Array.isArray(allowedContexts) || allowedContexts.length === 0) {
    return { allowed: false, reason: 'no allowed contexts configured (deny by default)' };
  }
  const allowed = allowedContexts.includes(context) || allowedContexts.includes('*');
  return allowed
    ? { allowed: true }
    : { allowed: false, reason: `context "${context}" is not in the allowed set [${allowedContexts.join(', ')}]` };
}

/** Parse "10.0.0.0/8" into a comparison-ready form. IPv4 only. */
function parseCidr(cidr) {
  const [range, bitsRaw] = String(cidr).split('/');
  const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) throw new Error(`Invalid CIDR prefix: ${cidr}`);
  const octets = range.split('.').map(Number);
  if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) {
    throw new Error(`Invalid CIDR address: ${cidr}`);
  }
  const base = ((octets[0] << 24) >>> 0) + (octets[1] << 16) + (octets[2] << 8) + octets[3];
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { base: (base & mask) >>> 0, mask };
}

function ipToInt(ip) {
  // Normalise IPv4-mapped IPv6 (::ffff:10.0.0.1), which Node reports for
  // dual-stack listeners — without this, office ranges silently never match.
  const normalised = String(ip).replace(/^::ffff:/i, '');
  const octets = normalised.split('.').map(Number);
  if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return null;
  return (((octets[0] << 24) >>> 0) + (octets[1] << 16) + (octets[2] << 8) + octets[3]) >>> 0;
}

/**
 * @param {string} sourceIp        request source address
 * @param {string[]} allowedCidrs  e.g. ['10.0.0.0/8', '203.0.113.7/32']
 */
function checkSourceIp(sourceIp, allowedCidrs) {
  if (!Array.isArray(allowedCidrs) || allowedCidrs.length === 0) {
    return { allowed: false, reason: 'no source IP ranges configured (deny by default)' };
  }
  const ip = ipToInt(sourceIp);
  if (ip === null) return { allowed: false, reason: `unparseable source address "${sourceIp}"` };
  for (const cidr of allowedCidrs) {
    const { base, mask } = parseCidr(cidr);
    if (((ip & mask) >>> 0) === base) return { allowed: true, matched: cidr };
  }
  return { allowed: false, reason: `source address ${sourceIp} is outside the allowed ranges` };
}

module.exports = { checkPosture, checkSourceIp, parseCidr, ipToInt };
