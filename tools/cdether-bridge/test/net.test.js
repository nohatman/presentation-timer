'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const net = require('../lib/net');

test('directedBroadcast - /24', () => {
  assert.equal(net.directedBroadcast('192.168.8.238', '255.255.255.0'), '192.168.8.255');
});

test('directedBroadcast - /16', () => {
  assert.equal(net.directedBroadcast('172.20.5.9', '255.255.0.0'), '172.20.255.255');
});

test('directedBroadcast - /25', () => {
  assert.equal(net.directedBroadcast('10.0.0.130', '255.255.255.128'), '10.0.0.255');
  assert.equal(net.directedBroadcast('10.0.0.5', '255.255.255.128'), '10.0.0.127');
});

test('directedBroadcast - /8', () => {
  assert.equal(net.directedBroadcast('10.1.2.3', '255.0.0.0'), '10.255.255.255');
});

test('directedBroadcast - rejects /31 and /32', () => {
  assert.throws(() => net.directedBroadcast('192.168.1.1', '255.255.255.254'), /no directed broadcast/);
  assert.throws(() => net.directedBroadcast('192.168.1.1', '255.255.255.255'), /no directed broadcast/);
});

test('directedBroadcast - rejects non-contiguous mask', () => {
  assert.throws(() => net.directedBroadcast('192.168.1.1', '255.255.0.255'), /not contiguous/);
});

test('directedBroadcast - rejects garbage', () => {
  assert.throws(() => net.directedBroadcast('not.an.ip', '255.255.255.0'));
});

test('prefixLength', () => {
  assert.equal(net.prefixLength('255.255.255.0'), 24);
  assert.equal(net.prefixLength('255.255.255.128'), 25);
  assert.equal(net.prefixLength('0.0.0.0'), 0);
  assert.equal(net.prefixLength('255.255.255.255'), 32);
});

test('ipToInt / intToIp round-trip', () => {
  for (const ip of ['0.0.0.0', '192.168.8.238', '255.255.255.255', '10.0.0.1']) {
    assert.equal(net.intToIp(net.ipToInt(ip)), ip);
  }
});

test('resolveInterface - matches by name even when the IP has changed', (t) => {
  const orig = os.networkInterfaces;
  t.after(() => { os.networkInterfaces = orig; });

  os.networkInterfaces = () => ({
    'CDEther LAN': [
      { address: '192.168.8.99', netmask: '255.255.255.0', family: 'IPv4', internal: false, mac: 'aa:bb:cc:dd:ee:ff', cidr: '192.168.8.99/24' },
    ],
    'Wi-Fi': [
      { address: '10.4.0.20', netmask: '255.255.0.0', family: 'IPv4', internal: false, mac: '11:22:33:44:55:66', cidr: '10.4.0.20/16' },
    ],
  });

  // Saved address was .50 last time; name still resolves and picks up .99
  const iface = net.resolveInterface({ name: 'CDEther LAN', address: '192.168.8.50' });
  assert.equal(iface.name, 'CDEther LAN');
  assert.equal(iface.address, '192.168.8.99');
  assert.equal(iface.broadcast, '192.168.8.255');
});

test('resolveInterface - falls back to address match', (t) => {
  const orig = os.networkInterfaces;
  t.after(() => { os.networkInterfaces = orig; });
  os.networkInterfaces = () => ({
    'Renamed Adapter': [
      { address: '192.168.8.99', netmask: '255.255.255.0', family: 'IPv4', internal: false, cidr: '192.168.8.99/24' },
    ],
  });
  const iface = net.resolveInterface({ name: 'Old Name', address: '192.168.8.99' });
  assert.equal(iface.name, 'Renamed Adapter');
});

test('resolveInterface - returns null when nothing matches', (t) => {
  const orig = os.networkInterfaces;
  t.after(() => { os.networkInterfaces = orig; });
  os.networkInterfaces = () => ({ 'Wi-Fi': [{ address: '10.0.0.5', netmask: '255.255.255.0', family: 'IPv4', internal: false, cidr: '10.0.0.5/24' }] });
  assert.equal(net.resolveInterface({ name: 'Nope', address: '1.2.3.4' }), null);
});

test('listInterfaces - excludes internal by default, includes on request', (t) => {
  const orig = os.networkInterfaces;
  t.after(() => { os.networkInterfaces = orig; });
  os.networkInterfaces = () => ({
    'lo': [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', internal: true, cidr: '127.0.0.1/8' }],
    'eth0': [{ address: '192.168.1.5', netmask: '255.255.255.0', family: 'IPv4', internal: false, cidr: '192.168.1.5/24' }],
  });
  assert.deepEqual(net.listInterfaces().map((i) => i.name), ['eth0']);
  assert.equal(net.listInterfaces({ includeInternal: true }).length, 2);
});
