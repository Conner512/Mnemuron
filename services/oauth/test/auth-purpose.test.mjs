import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {consoleFixture} from './helpers/identity-fixture.mjs';

test('console and OAuth login clearly distinguish purpose without changing authentication',async t=>{
  const f=await consoleFixture(t);
  const consolePage=await f.browser.request('/login');
  assert.equal(consolePage.status,200);
  assert.match(consolePage.text,/data-i18n="consoleLogin"/);
  assert.match(consolePage.text,/data-i18n="consoleLoginNote"/);
  assert.match(consolePage.text,/<form method="post" action="\/login">/);
  const params=new URLSearchParams({client_id:f.config.chatgpt_client.client_id,
    redirect_uri:f.config.chatgpt_client.redirect_uris[0],response_type:'code',scope:'openid offline_access memory:read',
    resource:f.config.resource,state:'synthetic-purpose-state',code_challenge_method:'S256',
    code_challenge:createHash('sha256').update('synthetic-purpose-verifier'.repeat(3)).digest('base64url')});
  const start=await f.browser.request(`/authorize?${params}`);
  assert.equal(start.status,303);
  const page=await f.browser.request(start.headers.get('location'));
  assert.equal(page.status,200);
  assert.match(page.text,/data-i18n="oauthLogin"/);
  assert.match(page.text,/data-i18n="oauthLoginNote"/);
  assert.match(page.text,/<form method="post" action="\/interaction\/[A-Za-z0-9_-]+\/login">/);
  for(const name of ['csrf','username','password','otp'])assert.ok(page.text.includes(`name="${name}"`));
  assert.ok(!page.text.includes('href="/login"'));
  assert.ok(![...f.browser.cookies.keys()].some(k=>k.includes('_console')));
  assert.match(page.headers.get('content-security-policy'),/frame-ancestors 'none'/);
});

test('expired OAuth links explain how to restart, never redirect into console login',async t=>{
  const f=await consoleFixture(t);
  const response=await f.browser.request('/interaction/synthetic-expired-link',{headers:{accept:'text/html'}});
  assert.equal(response.status,403);
  assert.equal(response.headers.get('location'),null);
  assert.match(response.text,/data-i18n="restartAuthorization"/);
  assert.match(response.text,/data-i18n="oauthRestartHelp"/);
  assert.ok(!response.text.includes('href="/login"'));
  assert.ok(!/<form/.test(response.text));
  assert.equal(response.headers.get('cache-control'),'no-store');
});
