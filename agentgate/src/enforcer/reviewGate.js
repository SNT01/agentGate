'use strict';
/**
 * Review gate — decides whether a pull request approval counts.
 *
 * Policy: AI agents may comment and request changes, but an agent's
 * approval never counts. Only a verified, non-revoked human can approve.
 * This rule lives here rather than in token scope because GitHub has no
 * permission that separates "approve" from "comment" — both are
 * `pull_requests: write` — so it must be enforced after the fact by
 * dismissing the review.
 *
 * Pure function: returns a decision. `githubApp.js` performs the actual
 * dismissal API call when `shouldDismiss` is true.
 */

const APPROVED = 'APPROVED';

/**
 * @param {{reviewerId: string, isAgent: boolean, state: string}} review
 * @param {import('../registry/registry').Registry} registry
 * @returns {{shouldDismiss: boolean, reason: string}}
 */
function evaluateReview(review, registry) {
  if (!review || typeof review !== 'object') {
    return { shouldDismiss: true, reason: 'malformed review payload' };
  }
  const { reviewerId, isAgent, state } = review;

  if (String(state).toUpperCase() !== APPROVED) {
    return { shouldDismiss: false, reason: 'non-approving review is always allowed (comment / changes requested)' };
  }

  if (isAgent) {
    return { shouldDismiss: true, reason: 'AI agent approvals never count — approval requires a verified human' };
  }

  if (!reviewerId) {
    return { shouldDismiss: true, reason: 'reviewer identity could not be resolved' };
  }

  if (registry.isRevoked(reviewerId)) {
    return { shouldDismiss: true, reason: 'reviewer identity has been revoked' };
  }

  const human = registry.getHuman(reviewerId);
  if (!human) {
    return { shouldDismiss: true, reason: 'reviewer is not an enrolled, verified identity' };
  }

  const actions = human.capabilities && human.capabilities.actions ? human.capabilities.actions : [];
  if (!actions.includes('pr:approve') && !actions.includes('*')) {
    return { shouldDismiss: true, reason: 'reviewer is enrolled but does not hold the pr:approve capability' };
  }

  return { shouldDismiss: false, reason: 'verified human approval — counts' };
}

module.exports = { evaluateReview };
