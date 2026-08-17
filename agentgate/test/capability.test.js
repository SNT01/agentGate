'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  intersectCapabilities,
  isActionAllowed,
  isEmptyCapabilitySet,
  branchAllowed,
} = require('../src/shared/capability');

test('wildcard set imposes no restriction on a concrete set', () => {
  const result = intersectCapabilities(
    { branches: ['*'], actions: ['*'] },
    { branches: ['feature/*'], actions: ['push'] }
  );
  assert.deepStrictEqual(result, { branches: ['feature/*'], actions: ['push'] });
});

test('two concrete sets intersect to their overlap only', () => {
  const result = intersectCapabilities(
    { branches: ['feature/*', 'agent/*'], actions: ['push', 'pr:open', 'pr:approve'] },
    { branches: ['feature/*'], actions: ['push', 'pr:open'] }
  );
  assert.deepStrictEqual(result, { branches: ['feature/*'], actions: ['push', 'pr:open'] });
});

test('non-overlapping sets intersect to nothing (deny by default)', () => {
  const result = intersectCapabilities(
    { branches: ['release/*'], actions: ['pr:merge'] },
    { branches: ['feature/*'], actions: ['push'] }
  );
  assert.deepStrictEqual(result, { branches: [], actions: [] });
  assert.strictEqual(isEmptyCapabilitySet(result), true);
});

test('intersection never widens: adding a set can only shrink or preserve', () => {
  const base = intersectCapabilities({ branches: ['*'], actions: ['push', 'pr:open'] });
  const narrowed = intersectCapabilities(
    { branches: ['*'], actions: ['push', 'pr:open'] },
    { branches: ['feature/*'], actions: ['push'] }
  );
  assert.ok(narrowed.actions.length <= base.actions.length);
  for (const a of narrowed.actions) assert.ok(base.actions.includes(a) || base.actions.includes('*'));
});

test('branch globs match only their own namespace', () => {
  assert.strictEqual(branchAllowed('feature/login', ['feature/*']), true);
  assert.strictEqual(branchAllowed('main', ['feature/*']), false);
  assert.strictEqual(branchAllowed('feature/a/b', ['feature/*']), true);
});

test('isActionAllowed enforces both action and branch', () => {
  const caps = { branches: ['feature/*'], actions: ['push'] };
  assert.strictEqual(isActionAllowed(caps, 'push', 'feature/x'), true);
  assert.strictEqual(isActionAllowed(caps, 'push', 'main'), false, 'must reject a branch outside the ceiling');
  assert.strictEqual(isActionAllowed(caps, 'pr:merge', 'feature/x'), false, 'must reject an ungranted action');
});

test('malformed capability sets are rejected rather than defaulting open', () => {
  assert.strictEqual(isActionAllowed(null, 'push', 'main'), false);
  assert.strictEqual(isActionAllowed({}, 'push', 'main'), false);
  assert.strictEqual(isActionAllowed({ actions: 'push' }, 'push', 'main'), false);
});
