'use strict';

const os = require('os');
const net = require('net');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const PRIVATE_IPV4 = /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/;

function getIpv4Candidates(interfaceMap = os.networkInterfaces()) {
  const candidates = [];
  for (const entries of Object.values(interfaceMap || {})) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal && entry.address) candidates.push(entry.address);
    }
  }
  return candidates;
}

function pickFallbackLanIp(candidates) {
  return candidates.find((address) => PRIVATE_IPV4.test(address)) || candidates[0] || '127.0.0.1';
}

async function detectWindowsRouteIpv4({ run = execFileAsync } = {}) {
  const script = [
    "$routes = Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' -ErrorAction Stop | Where-Object { $_.State -eq 'Alive' -and $_.NextHop -ne '0.0.0.0' }",
    '$ranked = foreach ($route in $routes) {',
    "  $interface = Get-NetIPInterface -AddressFamily IPv4 -InterfaceIndex $route.InterfaceIndex -ErrorAction Stop",
    '  [pscustomobject]@{ NextHop = $route.NextHop; Metric = ([int]$route.RouteMetric + [int]$interface.InterfaceMetric) }',
    '}',
    '$gateway = $ranked | Sort-Object Metric | Select-Object -First 1 -ExpandProperty NextHop',
    'if ($gateway) {',
    '  Find-NetRoute -RemoteIPAddress $gateway -ErrorAction Stop | Select-Object -First 1 -ExpandProperty IPAddress',
    '}',
  ].join('; ');

  try {
    const { stdout } = await run('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', script], {
      windowsHide: true,
      timeout: 4000,
    });
    const address = String(stdout || '').trim().split(/\r?\n/).find(Boolean) || '';
    return net.isIP(address) === 4 ? address : null;
  } catch {
    return null;
  }
}

async function resolveLanIp({ interfaceMap = os.networkInterfaces(), routeAddress, detectRoute = detectWindowsRouteIpv4 } = {}) {
  const candidates = getIpv4Candidates(interfaceMap);
  const selectedRoute = routeAddress === undefined ? await detectRoute() : routeAddress;
  return candidates.includes(selectedRoute) ? selectedRoute : pickFallbackLanIp(candidates);
}

module.exports = { detectWindowsRouteIpv4, getIpv4Candidates, pickFallbackLanIp, resolveLanIp };
