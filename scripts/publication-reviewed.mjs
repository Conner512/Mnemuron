import {createHash} from 'node:crypto';

const sha256 = content => createHash('sha256').update(content).digest('hex');

// Reviewed self-hosted OFL fonts; the license is web/console/FONTS-LICENSE.txt.
// Both scanners use the same exact path AND bytes. Unknown, renamed or changed binaries still fail.
const binaries = new Map([
  ['web/console/display-font.woff2', '85f55a58a31e61a2e19e8bb25fed503181bf2a6b4cab76c589992cfaac377447'],
  ['web/console/mono-font.woff2', '29bf2691317290c0693d305d51abd52ddc027c93207f528f7efa8cf0f8b504ca'],
]);
export const isReviewedBinary = (file, content) => Buffer.isBuffer(content) && binaries.get(file) === sha256(content);

// Already-public synthetic test inputs in 58b7aa1 / 03c0d64. Current fixtures use documentation addresses
// and the standard synthetic UUID prefix. Preserve history without exempting a test directory or rewriting it.
// These reviews suppress only the named identifier rule, never a secret, private artifact or changed payload.
const syntheticHistory = new Map([
  ['server/test/config-tunnel.test.mjs', new Map([
    ['fb8382b82f44afd97d20d172a7d92951b631f4ba7ed9b4542b83d939f03c396e', ['non-synthetic-uuid']],
    ['9b3eab28c702712bef51a380fc93b28e1dd36b3fc9710fc618e5c362b2207e86', ['non-synthetic-uuid']],
  ])],
  ['server/test/console-hosts.test.mjs', new Map([
    ['2ae009673603aa39f6c14c39769fcb12f5c90f104e6c2dc80bacc7424f37ad97', ['private-ip']],
  ])],
  ['services/oauth/test/console-models-ui.test.mjs', new Map([
    ['a90f90076c2d9e40c8e7bc5756219da07ccae7c582cbdabcd9322c37eef90d63', ['private-ip']],
  ])],
]);
export const reviewedSyntheticRules = (file, content) => syntheticHistory.get(file)?.get(sha256(content)) || [];
