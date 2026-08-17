'use strict';
/**
 * Capability sets and the narrowing rule that underpins AgentGate's
 * authorization model.
 *
 * A capability set describes what an identity may do on a repository:
 *   { branches: ['feature/*', 'agent/*'], actions: ['push', 'pr:open', 'pr:comment'] }
 *
 * `intersectCapabilities` is the ONLY operation this module exposes for
 * combining sets, and it can only ever narrow. There is deliberately no
 * union, merge, or grant function anywhere in the codebase: authority flows
 * sponsor → agent card → repo policy → issued token, and every stage can
 * only tighten what the previous stage allowed. That makes least privilege
 * a structural property (it holds because of how scope is computed) rather
 * than a policy one (which would hold only while the policy is correct).
 */

/** Convert a branch glob (`feature/*`) to an anchored RegExp. */
function globToRegExp(glob) {
  const escaped = String(glob).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function branchAllowed(branch, patterns) {
  if (!Array.isArray(patterns)) return false;
  return patterns.some((p) => globToRegExp(p).test(branch));
}

/**
 * `'*'` in a set means "this set imposes no additional restriction on this
 * field" (e.g. a human's org-wide grant) — NOT a literal pattern to match
 * against another set's concrete globs. A set listing concrete patterns
 * (e.g. ['feature/*']) DOES restrict: the result contains only entries
 * present in every concrete set. Two concrete, non-overlapping sets
 * correctly intersect to nothing (deny by default).
 */
function narrowField(sets, field) {
  const lists = sets.map((s) => (s && Array.isArray(s[field]) ? s[field] : []));
  const concrete = lists.filter((l) => !l.includes('*'));
  if (concrete.length === 0) return ['*']; // every set was unrestricted
  let result = concrete[0];
  for (let i = 1; i < concrete.length; i++) {
    result = result.filter((x) => concrete[i].includes(x));
  }
  return result;
}

function intersectCapabilities(...sets) {
  if (sets.length === 0) return { branches: [], actions: [] };
  return {
    branches: narrowField(sets, 'branches'),
    actions: narrowField(sets, 'actions'),
  };
}

/** True only if `capSet` permits `action`, and (when a branch is given) permits it on that branch. */
function isActionAllowed(capSet, action, branch) {
  if (!capSet || !Array.isArray(capSet.actions)) return false;
  if (!capSet.actions.includes(action) && !capSet.actions.includes('*')) return false;
  if (branch && !branchAllowed(branch, capSet.branches)) return false;
  return true;
}

/** True when a capability set grants nothing at all. */
function isEmptyCapabilitySet(capSet) {
  if (!capSet) return true;
  return (capSet.branches || []).length === 0 || (capSet.actions || []).length === 0;
}

module.exports = {
  intersectCapabilities,
  isActionAllowed,
  isEmptyCapabilitySet,
  branchAllowed,
  globToRegExp,
};
