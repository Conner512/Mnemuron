import {generate} from 'otplib';
import {seconds} from '../../../../shared/oauth-common.mjs';

// Enrollment consumes a previous-step code so a later current-step login code is not a replay.
// Generated in the last moments of a step, that code ages out of the ±30 s window before it is
// verified (CI: REGISTRATION_UNAVAILABLE), so wait out the step boundary first.
export async function previousStepCode(secret,{marginMs=2_000}={}) {
  const untilNextStep=30_000-(Date.now()%30_000);
  if(untilNextStep<marginMs)await new Promise(resolve=>setTimeout(resolve,untilNextStep+50));
  return generate({secret,epoch:seconds()-30});
}
