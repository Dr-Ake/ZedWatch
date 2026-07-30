'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { detectWindowsRouteIpv4, getIpv4Candidates, pickFallbackLanIp, resolveLanIp } = require('../lib/network');

const dualAdapterInterfaces = {
  Ethernet: [{ family: 'IPv4', internal: false, address: '192.168.0.64' }],
  'Ethernet 2': [{ family: 'IPv4', internal: false, address: '192.168.0.63' }],
  Loopback: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
};

test('collects usable IPv4 interface addresses only', () => {
  assert.deepEqual(getIpv4Candidates(dualAdapterInterfaces), ['192.168.0.64', '192.168.0.63']);
});

test('prefers the address Windows selected for the default route', async () => {
  assert.equal(await resolveLanIp({
    interfaceMap: dualAdapterInterfaces,
    routeAddress: '192.168.0.63',
  }), '192.168.0.63');
});

test('asks Windows for the source address selected for its current gateway', async () => {
  let invocation;
  const address = await detectWindowsRouteIpv4({
    run: async (...args) => {
      invocation = args;
      return { stdout: '192.168.0.63\r\n' };
    },
  });
  assert.equal(address, '192.168.0.63');
  assert.equal(invocation[0], 'powershell.exe');
  assert.match(invocation[1].join(' '), /Get-NetRoute/);
  assert.match(invocation[1].join(' '), /Find-NetRoute/);
  assert.doesNotMatch(invocation[1].join(' '), /1\.1\.1\.1|8\.8\.8\.8/);
});

test('falls back to a private adapter when route detection is unavailable', async () => {
  assert.equal(await resolveLanIp({
    interfaceMap: dualAdapterInterfaces,
    detectRoute: async () => null,
  }), '192.168.0.64');
  assert.equal(pickFallbackLanIp([]), '127.0.0.1');
});
