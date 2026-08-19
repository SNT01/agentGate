'use strict';
/**
 * Agent card renewal.
 *
 * Cards expire so a forgotten agent stops working. Acting on that expiry used
 * to mean `issue-agent`, which mints a *new* id — orphaning the audit history
 * and the commit trailers that name the old one. At a few hundred agents on a
 * 30-day TTL that is several identity changes a day, each breaking the
 * attribution the audit log exists to provide.
 *
 * Renewal therefore keeps the id. The risk that introduces is renewal becoming
 * a way to *gain* authority, so most of what follows tests that it cannot:
 * capabilities are recomputed against the sponsor's current set, and a
 * revocation can never be undone by renewing.
 */
const test = require('node:test');
const assert = require('node:assert');

const { Registry } = require('../src/registry/registry');
const { generateKeyPair } = require('../src/shared/crypto');
const { tempDataDir, cleanup } = require('./helpers');

function fixture(t, { sponsorCapabilities, requested } = {}) {
  const dir = tempDataDir('renewal');
  t.after(() => cleanup(dir));
  const registry = new Registry(dir);

  const { humanId } = registry.enrollHuman({
    name: 'Alice',
    allowedContexts: ['office'],
    capabilities: sponsorCapabilities || { branches: ['*'], actions: ['push', 'pr:open', 'pr:comment'] },
  });
  const issued = registry.issueAgentCard({
    sponsorId: humanId,
    tool: { name: 'claude-code', version: '2.4.0' },
    context: 'office',
    requestedCapabilities: requested || { branches: ['feature/*'], actions: ['push', 'pr:open'] },
  });

  return { dir, registry, humanId, cardId: issued.agentCardId, card: issued.card };
}

test('renewal keeps the id and extends the expiry', (t) => {
  const { registry, cardId, card } = fixture(t);

  // Renewed with a longer TTL than the default. Renewing a card issued
  // milliseconds ago with the *same* TTL moves the expiry by only those
  // milliseconds, which is correct but not something to assert on.
  const result = registry.renewAgentCard(cardId, { ttlMs: 60 * 24 * 60 * 60 * 1000 });
  assert.strictEqual(result.agentCardId, cardId, 'the id is the whole point');
  assert.ok(
    new Date(result.card.expiresAt) > new Date(card.expiresAt),
    `expected an expiry after ${card.expiresAt}, got ${result.card.expiresAt}`
  );
  assert.strictEqual(result.previousExpiresAt, card.expiresAt);
  // issuedAt records when the identity came into existence; renewal does not
  // change that.
  assert.strictEqual(result.card.issuedAt, card.issuedAt);
  assert.ok(result.card.renewedAt, 'a renewal is recorded on the card');
});

test('a renewed card still verifies against the registry root', (t) => {
  const { registry, cardId } = fixture(t);
  registry.renewAgentCard(cardId);

  // The expiry is a signed field, so a renewal that forgot to re-sign would
  // leave a card that fails verification — worse than an expired one, because
  // it reads as tampering.
  const verified = registry.verifyAgentCard(cardId);
  assert.strictEqual(verified.valid, true, verified.reason);
});

test('renewal revives an already-expired card', (t) => {
  const { registry, cardId } = fixture(t);

  // The realistic case: nobody noticed until it broke.
  const data = registry.store.load();
  data.agents[cardId].expiresAt = new Date(Date.now() - 60_000).toISOString();
  registry.store.save(data);
  assert.strictEqual(registry.verifyAgentCard(cardId).valid, false);

  registry.renewAgentCard(cardId);
  assert.strictEqual(registry.verifyAgentCard(cardId).valid, true);
});

test('renewal narrows to the sponsor\'s current capabilities', (t) => {
  const { registry, humanId, cardId } = fixture(t);

  // The sponsor loses pr:open after the card was issued.
  const data = registry.store.load();
  data.humans[humanId].capabilities = { branches: ['feature/*'], actions: ['push'] };
  registry.store.save(data);

  const result = registry.renewAgentCard(cardId);
  assert.deepStrictEqual(result.card.capabilities.actions, ['push']);
  assert.strictEqual(result.narrowed, true);
});

test('renewal never widens a card, even when the sponsor gains capabilities', (t) => {
  const { registry, humanId, cardId, card } = fixture(t, {
    requested: { branches: ['feature/*'], actions: ['push'] },
  });
  assert.deepStrictEqual(card.capabilities.actions, ['push'], 'precondition');

  // The sponsor is promoted. The card must not inherit that.
  const data = registry.store.load();
  data.humans[humanId].capabilities = {
    branches: ['*'],
    actions: ['push', 'pr:open', 'pr:comment', 'pr:approve', 'pr:merge'],
  };
  registry.store.save(data);

  const result = registry.renewAgentCard(cardId);
  assert.deepStrictEqual(result.card.capabilities.actions, ['push'], 'renewal is not a promotion');
  assert.deepStrictEqual(result.card.capabilities.branches, ['feature/*']);
  assert.strictEqual(result.narrowed, false);
});

test('a revoked card cannot be renewed', (t) => {
  const { registry, cardId } = fixture(t);
  registry.revoke(cardId, 'compromised');

  // Renewing a revoked card would restore authority somebody deliberately
  // withdrew — the one thing revocation must be proof against.
  assert.throws(() => registry.renewAgentCard(cardId), /revoked and cannot be renewed/i);
});

test('a card whose sponsor is revoked cannot be renewed', (t) => {
  const { registry, humanId, cardId } = fixture(t);
  registry.revoke(humanId, 'left the company');

  assert.throws(() => registry.renewAgentCard(cardId), /Sponsor .* is revoked/i);
});

test('renewal fails when the sponsor no longer holds the card\'s context', (t) => {
  const { registry, humanId, cardId } = fixture(t);
  const data = registry.store.load();
  data.humans[humanId].allowedContexts = ['ci'];
  registry.store.save(data);

  assert.throws(() => registry.renewAgentCard(cardId), /no longer permitted to act from context/i);
});

test('renewal fails rather than issuing an empty card', (t) => {
  const { registry, humanId, cardId } = fixture(t, {
    requested: { branches: ['feature/*'], actions: ['push'] },
  });

  // No overlap at all: the honest outcome is an error naming the fix, not a
  // card that grants nothing and looks valid.
  const data = registry.store.load();
  data.humans[humanId].capabilities = { branches: ['release/*'], actions: ['pr:approve'] };
  registry.store.save(data);

  assert.throws(() => registry.renewAgentCard(cardId), /no longer overlap|grant nothing/i);
});

test('an unknown card is refused', (t) => {
  const { registry } = fixture(t);
  assert.throws(() => registry.renewAgentCard('agent_doesnotexist'), /Unknown agent card/i);
});

test('a custom ttl is honoured', (t) => {
  const { registry, cardId } = fixture(t);
  const ttlMs = 90 * 24 * 60 * 60 * 1000;
  const before = Date.now();

  const result = registry.renewAgentCard(cardId, { ttlMs });
  const expiresIn = new Date(result.card.expiresAt).getTime() - before;
  // Within a minute of 90 days, allowing for execution time.
  assert.ok(Math.abs(expiresIn - ttlMs) < 60_000, `expected ~90 days, got ${expiresIn}ms`);
});

// --- expiry reporting -------------------------------------------------------

test('listExpiringAgentCards reports soonest first, including already expired', (t) => {
  const { registry, humanId } = fixture(t);

  const makeCard = (expiresAt) => {
    const keys = generateKeyPair();
    const issued = registry.issueAgentCard({
      sponsorId: humanId,
      tool: { name: 'copilot', version: '1.0.0' },
      context: 'office',
      requestedCapabilities: { branches: ['feature/*'], actions: ['push'] },
      publicKey: keys.publicKey,
    });
    const data = registry.store.load();
    data.agents[issued.agentCardId].expiresAt = expiresAt;
    registry.store.save(data);
    return issued.agentCardId;
  };

  const expired = makeCard(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
  const soon = makeCard(new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString());
  makeCard(new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString());

  const expiring = registry.listExpiringAgentCards(7 * 24 * 60 * 60 * 1000);
  const ids = expiring.map((c) => c.id);
  assert.ok(ids.includes(expired), 'already expired is the most urgent case, not an excluded one');
  assert.ok(ids.includes(soon));
  assert.strictEqual(ids[0], expired, 'soonest (most negative) first');
  assert.ok(!ids.includes('agent_nonexistent'));
  assert.ok(expiring.every((c) => c.expiresInMs <= 7 * 24 * 60 * 60 * 1000));
});

test('listExpiringAgentCards omits revoked cards', (t) => {
  const { registry, cardId } = fixture(t);
  const data = registry.store.load();
  data.agents[cardId].expiresAt = new Date(Date.now() + 1000).toISOString();
  registry.store.save(data);
  registry.revoke(cardId, 'no longer needed');

  // A revoked card is not a renewal task; surfacing it as one is noise that
  // makes the real list less trustworthy.
  const expiring = registry.listExpiringAgentCards(7 * 24 * 60 * 60 * 1000);
  assert.strictEqual(
    expiring.find((c) => c.id === cardId),
    undefined
  );
});
