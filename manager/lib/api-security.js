'use strict';

function validateRequestOrigin(request, { port = 16300 } = {}) {
  const escapedPort = String(port).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const allowedHost = new RegExp(`^(?:127\\.0\\.0\\.1|localhost):${escapedPort}$`, 'i');
  const allowedOrigin = new RegExp(`^http://(?:127\\.0\\.0\\.1|localhost):${escapedPort}$`, 'i');
  const host = String(request?.headers?.host || '');
  if (!allowedHost.test(host)) return false;
  const origin = request?.headers?.origin;
  return !origin || allowedOrigin.test(String(origin));
}

function requireMutationToken(request, expectedToken, options) {
  if (!validateRequestOrigin(request, options)) throw new Error('Request origin was rejected.');
  if (!expectedToken || request?.headers?.['x-zedwatch-token'] !== expectedToken) {
    throw new Error('Session token is missing or invalid.');
  }
  return true;
}

module.exports = { requireMutationToken, validateRequestOrigin };
