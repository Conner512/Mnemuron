import { requireConfig } from './oauth-common.mjs';

export const PERMISSIONS_POLICY = 'camera=(), microphone=(), geolocation=(), payment=(), usb=()';

export function validateSecurityHeaders(config) {
  const policy = config.security_headers === undefined ? { hsts_max_age_seconds: 300 } : config.security_headers;
  requireConfig(policy && typeof policy === 'object' && !Array.isArray(policy)
    && Object.keys(policy).length === 1 && Object.hasOwn(policy, 'hsts_max_age_seconds'), 'security headers policy');
  const age = policy.hsts_max_age_seconds;
  // null delegates HSTS entirely to the edge; 0 explicitly clears a cached policy.
  requireConfig(age === null || (Number.isSafeInteger(age) && age >= 0 && age <= 31536000), 'HSTS max age');
  config.security_headers = { hsts_max_age_seconds: age };
}

export function applySecurityHeaders(request, response, origin, config) {
  response.setHeader('permissions-policy', PERMISSIONS_POLICY);
  const age = config.security_headers.hsts_max_age_seconds;
  // Both production listeners are loopback-only behind a fixed HTTPS origin.
  // Match that transport contract even on error responses; never infer TLS from
  // Forwarded/X-Forwarded-Proto or reflect any request value into a header.
  const hostCount = request.rawHeaders.filter((name, index) => index % 2 === 0 && name.toLowerCase() === 'host').length;
  if (age !== null && !config.isolated && origin.protocol === 'https:'
    && request.headers.host === origin.host && hostCount === 1
    && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress)) {
    response.setHeader('strict-transport-security', `max-age=${age}`);
  }
}
