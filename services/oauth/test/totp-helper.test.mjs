import test from 'node:test';
import assert from 'node:assert/strict';
import {generate,verify,generateSecret} from 'otplib';
import {seconds} from '../../../shared/oauth-common.mjs';
import {previousStepCode} from './helpers/totp.mjs';

test('TOTP-01: a previous-step enrollment code generated at a step boundary still verifies after the boundary',async t=>{
  const secret=generateSecret(),stepStart=1_800_000_000_000;
  t.mock.timers.enable({apis:['Date','setTimeout'],now:stepStart+29_970}); // 30 ms before the next step
  // The hazard the helper avoids: generated now, verified 80 ms later in the next step.
  const naive=await generate({secret,epoch:seconds()-30});
  t.mock.timers.tick(80);
  assert.equal((await verify({secret,token:naive,epochTolerance:30})).valid,false);
  t.mock.timers.setTime(stepStart+29_970);
  const pending=previousStepCode(secret);
  t.mock.timers.tick(100);
  const code=await pending;
  t.mock.timers.tick(80);
  assert.equal((await verify({secret,token:code,epochTolerance:30})).valid,true);
});
