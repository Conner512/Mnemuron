import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {fixture, listen, close, freePort} from './fixture.mjs';
import {createAuthorizationServer} from '../src/server.mjs';
import {validateAuthConfig} from '../src/config.mjs';
import {createGateway} from '../../../adapters/chatgpt-web/src/server.mjs';
import {validateGatewayConfig} from '../../../adapters/chatgpt-web/src/config.mjs';
import {applySecurityHeaders, validateSecurityHeaders, PERMISSIONS_POLICY} from '../../../shared/security-headers.mjs';
import {writePrivate, randomSecret} from '../../../shared/oauth-common.mjs';

// Explicit http.request preserves the canonical Host over loopback. Fetch may
// replace a supplied Host with its transport URL's host; no DNS or TLS is used here.
function proxyTransport(origin, port) {
  return {request: (target, {method = 'GET', headers = {}} = {}) => new Promise((resolve, reject) => {
    const request = http.request({host: '127.0.0.1', port, path: target, method,
      headers: {host: new URL(origin).host, connection: 'close', ...headers}}, response => {
      const received = new Headers();
      for (let i = 0; i < response.rawHeaders.length; i += 2) received.append(response.rawHeaders[i], response.rawHeaders[i + 1]);
      response.setEncoding('utf8'); let text = '';
      response.on('data', chunk => {text += chunk;});
      response.on('end', () => resolve({status: response.statusCode, headers: received, text}));
      response.on('error', reject);
    });
    request.on('error', reject); request.end();
  })};
}

test('HARDEN-HEADERS policy is bounded, host-only, and independent of forwarding input', () => {
  for (const policy of [null, [], {}, {hsts_max_age_seconds: -1}, {hsts_max_age_seconds: 1.5},
    {hsts_max_age_seconds: '300'}, {hsts_max_age_seconds: 31536001},
    {hsts_max_age_seconds: 300, includeSubDomains: true}, {hsts_max_age_seconds: 300, preload: true}]) {
    assert.throws(() => validateSecurityHeaders({security_headers: policy}));
  }
  const origin = new URL('https://auth.synthetic.fixture');
  const makeRequest = () => ({headers: {host: origin.host, 'x-forwarded-proto': 'http'},
    rawHeaders: ['Host', origin.host], socket: {remoteAddress: '127.0.0.1'}});
  const apply = (request, config = {}, canonical = origin) => {
    validateSecurityHeaders(config);
    const headers = new Map();
    applySecurityHeaders(request, {setHeader: (k, v) => headers.set(k, v)}, canonical, config);
    assert.equal(headers.get('permissions-policy'), PERMISSIONS_POLICY);
    return headers.get('strict-transport-security');
  };
  assert.equal(apply(makeRequest()), 'max-age=300');
  for (const age of [0, 3600, 31536000]) assert.equal(apply(makeRequest(), {security_headers: {hsts_max_age_seconds: age}}), `max-age=${age}`);
  assert.equal(apply(makeRequest(), {security_headers: {hsts_max_age_seconds: null}}), undefined);
  for (const change of [r => {r.socket.remoteAddress = '192.0.2.2';}, r => {r.headers.host = 'foreign.synthetic.fixture';},
    r => {r.rawHeaders.push('hOsT', origin.host);}, r => {r.rawHeaders = [];}]) {
    const request = makeRequest(); change(request); request.headers['x-forwarded-proto'] = 'https';
    assert.equal(apply(request), undefined);
  }
  assert.equal(apply(makeRequest(), {isolated: true}), undefined);
  assert.equal(apply(makeRequest(), {}, new URL('http://auth.synthetic.fixture')), undefined);
});

test('HARDEN-HEADERS OAuth login, assets, redirects and errors retain CSP/cache policy behind trusted TLS termination', async t => {
  const f = await fixture(t, {start: false});
  const config = structuredClone(f.config);
  Object.assign(config, {issuer: 'https://auth.synthetic.fixture', resource: 'https://web.synthetic.fixture/mcp', identity_mode: 'multi_account_v1'});
  config.identity = {encryption_key_file: path.join(f.directory, 'identity-key')};
  writePrivate(config.identity.encryption_key_file, randomSecret());
  config.chatgpt_client.redirect_uris = ['https://chatgpt.com/connector_platform_oauth_redirect'];
  config.introspection_client.allowed_resource = config.resource;
  config.reverse_proxy.allowed_host = new URL(config.issuer).host;
  assert.throws(() => validateAuthConfig({...config, security_headers: {hsts_max_age_seconds: '300'}}));
  const app = createAuthorizationServer(config);
  t.after(() => close(app.server));
  await listen(app.server, f.ports.authPort);
  // Only the local transport is contacted. The synthetic HTTPS origin models an existing trusted TLS proxy.
  const browser = proxyTransport(config.issuer, f.ports.authPort);
  for (const [target, status, cache] of [['/login', 200, 'no-store'], ['/app', 303, 'no-store'],
    ['/assets/app.mjs', 200, 'no-cache'], ['/.well-known/oauth-authorization-server', 200, 'no-store'],
    ['/console-api/me', 401, 'no-store'], ['/authorize', 400, 'no-store'], ['/missing', 404, 'no-store']]) {
    const response = await browser.request(target, {headers: {'x-forwarded-proto': 'http'}});
    assert.equal(response.status, status, target);
    assert.equal(response.headers.get('strict-transport-security'), 'max-age=300', target);
    assert.equal(response.headers.get('permissions-policy'), PERMISSIONS_POLICY, target);
    assert.equal(response.headers.get('cache-control'), cache, target);
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  }
  const error = await browser.request('/login', {method: 'POST', headers: {origin: 'https://foreign.synthetic.fixture', accept: 'text/html'}});
  assert.equal(error.status, 403);
  assert.equal(error.headers.get('strict-transport-security'), 'max-age=300');
  assert.equal(error.headers.get('permissions-policy'), PERMISSIONS_POLICY);
  assert.match(error.headers.get('content-type'), /text\/html/);
  assert.equal(error.headers.get('cache-control'), 'no-store');
});

test('HARDEN-HEADERS Gateway applies configured HSTS to metadata, anonymous API rejection and errors', async t => {
  const config = JSON.parse(fs.readFileSync(new URL('../../../adapters/chatgpt-web/config/gateway.runtime.example.json', import.meta.url), 'utf8'));
  const port = await freePort(), origin = 'https://web.synthetic.fixture';
  Object.assign(config, {issuer: origin, resource: origin + '/mcp', authorization_server_metadata_url: origin + '/.well-known/oauth-authorization-server',
    security_headers: {hsts_max_age_seconds: 600}});
  config.listen.port = port; config.introspection.endpoint = origin + '/introspect'; config.reverse_proxy.allowed_host = new URL(origin).host;
  assert.throws(() => validateGatewayConfig({...config, security_headers: {hsts_max_age_seconds: 600, preload: true}}));
  const app = createGateway(config); t.after(() => close(app.server)); await listen(app.server, port);
  const browser = proxyTransport(origin, port);
  for (const [target, status] of [['/.well-known/oauth-protected-resource', 200], ['/mcp', 401], ['/missing', 404]]) {
    const response = await browser.request(target);
    assert.equal(response.status, status); assert.equal(response.headers.get('strict-transport-security'), 'max-age=600');
    assert.equal(response.headers.get('permissions-policy'), PERMISSIONS_POLICY);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(response.headers.get('content-security-policy'), /default-src 'none'/);
  }
});

test('HARDEN-HEADERS isolated HTTP ignores forged TLS headers and keeps Permissions-Policy', async t => {
  const f = await fixture(t);
  const response = await f.browser.request('/.well-known/oauth-authorization-server', {headers: {'x-forwarded-proto': 'https', forwarded: 'proto=https'}});
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('strict-transport-security'), null);
  assert.equal(response.headers.get('permissions-policy'), PERMISSIONS_POLICY);
});
