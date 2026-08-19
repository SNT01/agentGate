'use strict';
/**
 * Named capability presets, and per-repository ceilings.
 *
 * Two problems, one file.
 *
 * **Profiles.** Issuing a card meant spelling out `--branches` and `--actions`
 * on every invocation. Across a hundred agents that is a hundred chances to
 * type something slightly different, and no way to answer "what is a CI agent
 * allowed to do here" other than reading a hundred cards. A profile names a
 * capability set once; `issue-agent --profile ci-agent` refers to it.
 *
 * **Repository policy.** The documented capability chain is
 * `sponsor → agent card → repo policy → issued token`, and the third stage did
 * not exist. `repoPolicy` reached the broker only in the body of the untrusted
 * `POST /token` request, which nothing ever sent — safe, because intersection
 * can only narrow, but inert. A ceiling that arrives from the caller is not a
 * policy in any useful sense anyway; it needs a source the operator controls.
 * That is the `repositories` section here, read by the broker and intersected
 * server-side.
 *
 * The file is optional. Absent, behaviour is exactly what it was.
 *
 *   {
 *     "profiles": {
 *       "ci-agent":  { "branches": ["ci/*"], "actions": ["push"],
 *                      "context": "ci", "cardTtlDays": 7 }
 *     },
 *     "repositories": {
 *       "acme/payments": { "branches": ["feature/*"], "actions": ["push", "pr:open"] },
 *       "acme/*":        { "actions": ["push", "pr:open", "pr:comment"] }
 *     }
 *   }
 *
 * A repository entry may omit a field, which then imposes no restriction on it
 * — the same convention `intersectCapabilities` already applies to `'*'`.
 */
const path = require('path');
const { JsonStore } = require('./store');
const { config } = require('./config');
const { globToRegExp } = require('./capability');

const DEFAULT = { profiles: {}, repositories: {} };

const VALID_ACTIONS = ['push', 'pr:open', 'pr:comment', 'pr:approve', 'pr:merge', '*'];

/**
 * Validate one capability set from the file, throwing with the key that is
 * wrong. A policy file typo must be a startup-time error naming the line, not
 * a silently ignored restriction — the failure mode of the latter is a token
 * broader than the operator believes they authorised.
 */
function validateSet(set, label, { requireFields }) {
  if (!set || typeof set !== 'object' || Array.isArray(set)) {
    throw new Error(`${label}: expected an object`);
  }
  for (const field of ['branches', 'actions']) {
    if (set[field] === undefined) {
      if (requireFields) throw new Error(`${label}: ${field} is required`);
      continue; // omitted means "imposes no restriction"
    }
    if (!Array.isArray(set[field]) || set[field].length === 0) {
      throw new Error(`${label}: ${field} must be a non-empty array`);
    }
  }
  for (const action of set.actions || []) {
    if (!VALID_ACTIONS.includes(action)) {
      throw new Error(`${label}: unknown action "${action}" (valid: ${VALID_ACTIONS.join(', ')})`);
    }
  }
}

class PolicyStore {
  constructor(dataDir = config.dataDir) {
    this.store = new JsonStore(path.join(dataDir, 'policies.json'), DEFAULT);
  }

  /** The whole file, with missing sections filled in. */
  load() {
    const data = this.store.load() || {};
    return {
      profiles: data.profiles || {},
      repositories: data.repositories || {},
    };
  }

  /**
   * Check the file over, returning problems rather than throwing so a caller
   * can report all of them at once.
   * @returns {string[]}
   */
  validate() {
    const problems = [];
    let data;
    try {
      data = this.load();
    } catch (err) {
      return [`policies.json is not readable: ${err.message}`];
    }

    for (const [name, profile] of Object.entries(data.profiles)) {
      try {
        // A profile is what a card is issued *from*, so it has to be complete.
        validateSet(profile, `profile "${name}"`, { requireFields: true });
        if (profile.cardTtlDays !== undefined && !(Number(profile.cardTtlDays) > 0)) {
          problems.push(`profile "${name}": cardTtlDays must be a positive number`);
        }
      } catch (err) {
        problems.push(err.message);
      }
    }

    for (const [pattern, policy] of Object.entries(data.repositories)) {
      try {
        validateSet(policy, `repository "${pattern}"`, { requireFields: false });
      } catch (err) {
        problems.push(err.message);
      }
      if (!/^[A-Za-z0-9._*-]+\/[A-Za-z0-9._*-]+$/.test(pattern)) {
        problems.push(`repository "${pattern}": expected owner/name, optionally with * wildcards`);
      }
    }

    return problems;
  }

  /** A named profile, or null. */
  profile(name) {
    return this.load().profiles[name] || null;
  }

  profileNames() {
    return Object.keys(this.load().profiles);
  }

  /**
   * The capability ceiling for `owner/name`, or null when no entry matches.
   *
   * Every matching pattern applies, intersected — so `acme/*` and
   * `acme/payments` both constrain `acme/payments`, and adding a broad rule can
   * never loosen a specific one. That is the only composition rule consistent
   * with "authority can only narrow": there is no precedence to reason about,
   * because more rules can only mean less authority.
   */
  repositoryPolicy(repository) {
    if (!repository || typeof repository !== 'string') return null;
    const { repositories } = this.load();

    const matches = Object.entries(repositories)
      .filter(([pattern]) => globToRegExp(pattern).test(repository))
      .map(([, policy]) => policy);

    if (!matches.length) return null;

    const combined = {};
    for (const field of ['branches', 'actions']) {
      const constraints = matches.map((m) => m[field]).filter(Boolean);

      // An omitted field means "this policy says nothing about branches (or
      // actions)", which must be expressed as `['*']` — the marker
      // `intersectCapabilities` reads as "imposes no restriction". Leaving it
      // absent instead makes `narrowField` see an empty concrete list and
      // intersect *everything* away: a policy naming only `actions` would
      // silently deny every branch, and the token would grant nothing.
      if (!constraints.length) {
        combined[field] = ['*'];
        continue;
      }

      combined[field] = constraints.reduce((acc, list) => {
        if (acc === null) return list;
        if (acc.includes('*')) return list;
        if (list.includes('*')) return acc;
        return acc.filter((item) => list.includes(item));
      }, null);
    }
    return combined;
  }

  /** Overwrite the file. Used by tests and by future policy commands. */
  save(data) {
    this.store.save({ profiles: data.profiles || {}, repositories: data.repositories || {} });
  }
}

module.exports = { PolicyStore, validateSet };
