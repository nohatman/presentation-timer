'use strict';

// Windows Firewall decision for Foxy Timer for Windows (tools/local-server/lib/firewall.js):
// can other devices on the laptop's current network reach its server?

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluate } = require('../tools/local-server/lib/firewall');

const wifi = (category) => ({ interfaceAlias: 'WiFi', profiles: [{ alias: 'WiFi', name: 'Venue', category }] });

test('an Allow rule for the network type Windows gave the Wi-Fi lets devices in', () => {
  assert.equal(evaluate({ ...wifi('Public'), rules: [{ action: 'Allow', profile: 'Public' }] }).state, 'ok');
  assert.equal(evaluate({ ...wifi('Public'), rules: [{ action: 'Allow', profile: 'Any' }] }).state, 'ok');
  assert.equal(evaluate({ ...wifi('Private'), rules: [{ action: 'Allow', profile: 'Domain, Private' }] }).state, 'ok');
  assert.equal(evaluate({ ...wifi('DomainAuthenticated'), rules: [{ action: 'Allow', profile: 'Domain' }] }).state, 'ok');
});

test('"Allow on private networks" does not help on a Public Wi-Fi (the silent failure)', () => {
  const r = evaluate({ ...wifi('Public'), rules: [{ action: 'Allow', profile: 'Private' }] });
  assert.equal(r.state, 'blocked');
  assert.equal(r.reason, 'no-allow-rule');
  assert.equal(r.networkName, 'Venue');
  assert.equal(r.category, 'Public');
});

test('no rule at all is blocked; a Block rule beats an Allow rule (Cancel on the Windows prompt)', () => {
  assert.equal(evaluate({ ...wifi('Private'), rules: [] }).state, 'blocked');
  const r = evaluate({ ...wifi('Public'), rules: [{ action: 'Allow', profile: 'Any' }, { action: 'Block', profile: 'Public' }] });
  assert.equal(r.state, 'blocked');
  assert.equal(r.reason, 'block-rule');
  assert.equal(evaluate({ ...wifi('Private'), rules: [{ action: 'Allow', profile: 'Any' }, { action: 'Block', profile: 'Public' }] }).state, 'ok', 'a block for another network type does not apply');
});

test('unknown when the network interface has no Windows network profile', () => {
  assert.equal(evaluate({ interfaceAlias: 'Ethernet', profiles: [{ alias: 'WiFi', name: 'x', category: 'Public' }], rules: [] }).state, 'unknown');
});
