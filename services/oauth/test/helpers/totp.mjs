import {generate} from 'otplib';
import {seconds} from '../../../../shared/oauth-common.mjs';

// Tests enrol with the previous TOTP step so a later sign-in can still use the current one.
// Verification accepts one step either side of its own clock, so a code generated in the last
// moments of a step can fall out of the window before it is checked. Start from a fresh step.
export async function previousStepCode(secret) {
  const left=30000-Date.now()%30000;
  if(left<=2000)await new Promise(resolve=>setTimeout(resolve,left+20));
  return generate({secret,epoch:seconds()-30});
}
