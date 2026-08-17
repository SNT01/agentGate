'use strict';
/** Public API for embedding AgentGate in another service. */
module.exports = {
  Registry: require('./registry/registry').Registry,
  TokenBroker: require('./broker/broker').TokenBroker,
  NonceStore: require('./broker/nonceStore').NonceStore,
  createServer: require('./broker/server').createServer,
  verifyCommit: require('./enforcer/verify').verifyCommit,
  verifyPullRequest: require('./enforcer/verify').verifyPullRequest,
  evaluateReview: require('./enforcer/reviewGate').evaluateReview,
  githubApp: require('./enforcer/githubApp'),
  capability: require('./shared/capability'),
  posture: require('./broker/posture'),
  config: require('./shared/config').config,
};
