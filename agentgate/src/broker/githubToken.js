'use strict';
/**
 * Exchange an AgentGate authorization decision for a real, scope-limited
 * GitHub App installation token.
 *
 * This is the one place where AgentGate's internal capability model is
 * translated into GitHub's permission vocabulary. It is isolated here so
 * that the authorization logic (registry, broker, capability intersection)
 * stays testable without any GitHub credentials, and so a different forge
 * (GitLab, Gitea) can be supported by adding a sibling module.
 *
 * The exchange is a *translation* step and never a widening one: the scope
 * it receives is already the intersection of sponsor rights, agent card
 * ceiling, and repo policy, and `toGitHubPermissions` can only map that to
 * an equal or narrower set of GitHub permissions.
 *
 * Requires `@octokit/auth-app` and a registered GitHub App:
 *   npm install --no-save @octokit/auth-app
 *
 * See README §"Live GitHub App wiring" for registration and configuration.
 */
const fs = require('fs');
const { config } = require('../shared/config');

/**
 * Map an AgentGate capability set to GitHub App installation permissions.
 * Deliberately conservative: anything not explicitly granted is omitted,
 * and no mapping ever produces `admin`.
 *
 * Note what this mapping *cannot* express: GitHub installation tokens are
 * scoped per repository, never per branch. A scope of
 * `{branches: ['feature/*'], actions: ['push']}` mints a token that GitHub
 * itself would also accept on `main`. The branch half of the capability set
 * is enforced by the enforcer (src/enforcer/verify.js) and by branch
 * protection rules on the repository — not by the token. The broker records
 * the branch scope in the audit entry so the divergence is visible.
 */
function toGitHubPermissions(scope) {
  const actions = new Set((scope && scope.actions) || []);
  const permissions = { metadata: 'read' };

  if (actions.has('push') || actions.has('*')) permissions.contents = 'write';
  else permissions.contents = 'read';

  if (actions.has('pr:open') || actions.has('pr:comment') || actions.has('*')) {
    permissions.pull_requests = 'write';
  }
  // Note: GitHub has no permission that separates "approve" from "comment" on
  // a PR — both are `pull_requests: write`. That is precisely why AgentGate
  // enforces the human-only approval rule in the enforcer's review gate
  // (src/enforcer/reviewGate.js) rather than relying on token scope alone.
  return permissions;
}

function loadPrivateKey() {
  if (config.githubPrivateKey) return config.githubPrivateKey;
  if (config.githubPrivateKeyPath) return fs.readFileSync(config.githubPrivateKeyPath, 'utf8');
  throw new Error(
    'GitHub App private key not configured — set AGENTGATE_GITHUB_PRIVATE_KEY_PATH (preferred) or AGENTGATE_GITHUB_PRIVATE_KEY'
  );
}

/**
 * Turn a mint failure into a sentence that names the fix.
 *
 * `reason` is the entirety of what the developer sees at the other end of a
 * failed `git push`, so a generic message costs someone an afternoon. Every
 * branch here corresponds to a row in the README troubleshooting table.
 */
function describeMintError(err) {
  const message = (err && err.message) || String(err);
  const status = err && (err.status || err.statusCode);
  const code = err && err.code;

  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return 'GitHub API unreachable (DNS) — check the broker host network and AGENTGATE_GITHUB_API_BASE_URL';
  }
  if (code === 'ETIMEDOUT' || code === 'ECONNREFUSED' || code === 'ECONNRESET' || /timed out/i.test(message)) {
    return 'GitHub API unreachable or too slow — the token exchange timed out';
  }
  if (/@octokit\/auth-app/.test(message)) {
    return message; // already actionable: names the install command
  }
  if (/private key/i.test(message) && !status) {
    return message;
  }
  if (status === 401) {
    return 'GitHub rejected the App credentials (401) — check AGENTGATE_GITHUB_APP_ID, the private key, and the broker clock (JWTs allow ~60s of skew)';
  }
  if (status === 404) {
    return 'GitHub returned 404 — check AGENTGATE_GITHUB_INSTALLATION_ID, and that the repository is one the App is installed on';
  }
  if (status === 403 || status === 422) {
    return `GitHub returned ${status} — the App does not hold a permission this scope requires; grant it on the App and accept the permission request on the installation`;
  }
  if (status) return `GitHub token exchange failed (${status}): ${message}`;
  return `GitHub token exchange failed: ${message}`;
}

/**
 * Mint an installation token limited to `repositories` and to the
 * permissions implied by `scope`.
 *
 * @param {{scope: object, repositories: string[]}} params  repositories are
 *        *bare* names; they resolve against the installation's account.
 * @returns {Promise<{token: string, expiresAt: string, permissions: object}>}
 */
async function mintInstallationToken({ scope, repositories }) {
  let createAppAuth;
  try {
    ({ createAppAuth } = require('@octokit/auth-app'));
  } catch (_e) {
    throw new Error(
      'GitHub token exchange requires @octokit/auth-app — run `npm install --no-save @octokit/auth-app`. ' +
        'Until then the broker issues AgentGate session tokens only.'
    );
  }

  const appId = config.githubAppId;
  const installationId = config.githubInstallationId;
  if (!appId || !installationId) {
    throw new Error('Set AGENTGATE_GITHUB_APP_ID and AGENTGATE_GITHUB_INSTALLATION_ID');
  }
  if (!Array.isArray(repositories) || repositories.length === 0) {
    throw new Error('refusing to mint an installation-wide token — no repository was resolved');
  }

  const auth = createAppAuth({
    appId,
    privateKey: loadPrivateKey(),
    installationId,
    ...(config.githubApiBaseUrl ? { baseUrl: config.githubApiBaseUrl } : {}),
  });
  const permissions = toGitHubPermissions(scope);

  const result = await auth({
    type: 'installation',
    installationId,
    repositoryNames: repositories,
    permissions,
    // Never serve a cached token: the permissions and repository set differ
    // per request, and a cache hit would hand back a wider grant than this
    // decision authorised.
    refresh: true,
  });

  return { token: result.token, expiresAt: result.expiresAt, permissions };
}

module.exports = { mintInstallationToken, toGitHubPermissions, describeMintError };
