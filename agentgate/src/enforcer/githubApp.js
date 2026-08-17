'use strict';
/**
 * GitHub wiring for the enforcer, written against the Probot event shape.
 *
 * This file is deliberately thin: all authorization logic lives in
 * `verify.js` and `reviewGate.js` and is unit-tested without any GitHub
 * credentials (see `test/`). What lives here is only the translation
 * between GitHub payloads and the plain objects that logic expects.
 *
 * Running it for real:
 *   1. npm install probot
 *   2. Register a GitHub App with permissions
 *        checks: write, pull_requests: write, contents: read
 *      subscribed to events: pull_request, pull_request_review
 *   3. Start it:
 *        const { Probot } = require('probot');
 *        const probot = new Probot({ appId, privateKey, secret });
 *        probot.load((app) => require('./githubApp').appFn(app));
 *        probot.start();
 *   4. On the repository, require the `agentgate/verified` status check in
 *      branch protection, and require reviews (CODEOWNERS recommended).
 *
 * Identity in commits: agent-authored commits carry git trailers
 *   Agent-ID: agent_...
 *   Sponsor: human_...
 *   Session-ID: session_...
 *   Signature: <base64 Ed25519 over {sha, message}>
 * Human commits carry `Human-ID:` and `Signature:`. If your organisation
 * standardises on Sigstore/gitsign or SSH signing instead, replace
 * `mapGitHubCommit` — nothing else needs to change.
 */
const { Registry } = require('../registry/registry');
const { verifyPullRequest } = require('./verify');
const { evaluateReview } = require('./reviewGate');
const log = require('../shared/logger');

const CHECK_NAME = 'agentgate/verified';

/** Parse git trailers: lines of the form `Key: value`. */
function parseTrailers(message) {
  const trailers = {};
  for (const line of String(message || '').split('\n')) {
    const m = /^([A-Za-z][A-Za-z-]*):\s*(.+)$/.exec(line.trim());
    if (m) trailers[m[1]] = m[2].trim();
  }
  return trailers;
}

/** Translate a GitHub commit object into the shape `verifyCommit` expects. */
function mapGitHubCommit(ghCommit, branch) {
  const message = ghCommit.commit && ghCommit.commit.message;
  const trailers = parseTrailers(message);
  const isAgent = !!trailers['Agent-ID'];
  return {
    sha: ghCommit.sha,
    authorId: isAgent
      ? trailers['Agent-ID']
      : trailers['Human-ID'] || (ghCommit.author && ghCommit.author.login),
    isAgent,
    branch,
    payload: { sha: ghCommit.sha, message },
    signature: trailers['Signature'],
    trailers,
    sessionId: trailers['Session-ID'],
  };
}

function mapGitHubReview(ghReview) {
  const trailers = parseTrailers(ghReview.body || '');
  const isAgent = !!trailers['Agent-ID'];
  return {
    reviewerId: isAgent ? trailers['Agent-ID'] : trailers['Human-ID'] || (ghReview.user && ghReview.user.login),
    isAgent,
    state: String(ghReview.state || '').toUpperCase(),
  };
}

/**
 * @param {object} app                Probot app
 * @param {object} [options]
 * @param {Registry} [options.registry]
 * @param {(sessionId: string) => object|null} [options.sessionLookup]
 */
function appFn(app, options = {}) {
  const registry = options.registry || new Registry();
  const { sessionLookup } = options;

  app.on(['pull_request.opened', 'pull_request.synchronize', 'pull_request.reopened'], async (context) => {
    const pr = context.payload.pull_request;
    try {
      const { data: ghCommits } = await context.octokit.pulls.listCommits(context.pullRequest());
      const commits = ghCommits.map((c) => mapGitHubCommit(c, pr.head.ref));
      const result = verifyPullRequest(commits, registry, sessionLookup);

      await context.octokit.checks.create(
        context.repo({
          name: CHECK_NAME,
          head_sha: pr.head.sha,
          status: 'completed',
          conclusion: result.conclusion,
          output: {
            title: result.conclusion === 'success' ? 'All commits verified' : 'Verification failed',
            summary: result.summary,
          },
        })
      );
      log.info('pull request verified', { pr: pr.number, conclusion: result.conclusion });
    } catch (err) {
      log.error('pull request verification failed', { pr: pr.number, error: err.message });
      // Fail closed: an error in the enforcer must never read as a pass.
      await context.octokit.checks.create(
        context.repo({
          name: CHECK_NAME,
          head_sha: pr.head.sha,
          status: 'completed',
          conclusion: 'failure',
          output: { title: 'Verification error', summary: `AgentGate could not verify this PR: ${err.message}` },
        })
      );
    }
  });

  app.on('pull_request_review.submitted', async (context) => {
    const review = context.payload.review;
    const decision = evaluateReview(mapGitHubReview(review), registry);
    if (!decision.shouldDismiss) return;
    try {
      await context.octokit.pulls.dismissReview(
        context.pullRequest({ review_id: review.id, message: `AgentGate: review dismissed — ${decision.reason}` })
      );
      log.info('review dismissed', { review: review.id, reason: decision.reason });
    } catch (err) {
      log.error('review dismissal failed', { review: review.id, error: err.message });
    }
  });
}

module.exports = { appFn, mapGitHubCommit, mapGitHubReview, parseTrailers, CHECK_NAME };
