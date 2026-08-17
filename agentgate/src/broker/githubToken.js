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
 * Requires `@octokit/auth-app` and a registered GitHub App:
 *   npm install @octokit/auth-app
 *
 * Set:
 *   AGENTGATE_GITHUB_APP_ID
 *   AGENTGATE_GITHUB_PRIVATE_KEY       (PEM, or a path via ..._PRIVATE_KEY_PATH)
 *   AGENTGATE_GITHUB_INSTALLATION_ID
 */
const fs = require('fs');

/**
 * Map an AgentGate capability set to GitHub App installation permissions.
 * Deliberately conservative: anything not explicitly granted is omitted,
 * and no mapping ever produces `admin`.
 */
function toGitHubPermissions(scope) {
  const actions = new Set(scope.actions || []);
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
  const inline = process.env.AGENTGATE_GITHUB_PRIVATE_KEY;
  if (inline) return inline.replace(/\\n/g, '\n');
  const keyPath = process.env.AGENTGATE_GITHUB_PRIVATE_KEY_PATH;
  if (keyPath) return fs.readFileSync(keyPath, 'utf8');
  throw new Error(
    'GitHub App private key not configured — set AGENTGATE_GITHUB_PRIVATE_KEY or AGENTGATE_GITHUB_PRIVATE_KEY_PATH'
  );
}

/**
 * Mint an installation token limited to `repositories` and to the
 * permissions implied by `scope`.
 *
 * @param {{scope: object, repositories: string[]}} params
 * @returns {Promise<{token: string, expiresAt: string, permissions: object}>}
 */
async function mintInstallationToken({ scope, repositories }) {
  let createAppAuth;
  try {
    ({ createAppAuth } = require('@octokit/auth-app'));
  } catch (_e) {
    throw new Error(
      'GitHub token exchange requires @octokit/auth-app — run `npm install @octokit/auth-app`. ' +
        'Until then the broker issues AgentGate session tokens only.'
    );
  }

  const appId = process.env.AGENTGATE_GITHUB_APP_ID;
  const installationId = process.env.AGENTGATE_GITHUB_INSTALLATION_ID;
  if (!appId || !installationId) {
    throw new Error('Set AGENTGATE_GITHUB_APP_ID and AGENTGATE_GITHUB_INSTALLATION_ID');
  }

  const auth = createAppAuth({ appId, privateKey: loadPrivateKey(), installationId });
  const permissions = toGitHubPermissions(scope);

  const result = await auth({
    type: 'installation',
    installationId,
    repositoryNames: repositories,
    permissions,
  });

  return { token: result.token, expiresAt: result.expiresAt, permissions };
}

module.exports = { mintInstallationToken, toGitHubPermissions };
