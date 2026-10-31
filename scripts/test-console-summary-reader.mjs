// Real-browser summary reader acceptance against disposable synthetic Core/OAuth services.
// No production service, real identity, or model call is used. Evidence stays outside the checkout.
// PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs [CHROMIUM_EXECUTABLE=/path/to/chrome]
// MNEMURON_UI_EVIDENCE=/private/path node scripts/test-console-summary-reader.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import assert from 'node:assert/strict';
import {READER_FIRST_QUOTE, READER_SECOND_QUOTE, READER_OTHER_QUOTE, READER_LONG_QUOTE, READER_PAGE_QUOTES} from '../services/oauth/test/helpers/summary-reader-fixture.mjs';

const root = path.resolve(import.meta.dirname, '..'), base = path.resolve(process.env.MNEMURON_UI_EVIDENCE || os.tmpdir());
assert.ok(base !== root && !base.startsWith(root + path.sep), 'Evidence must stay outside the checkout');
const evidence = fs.mkdtempSync(path.join(base, 'summary-reader-browser-'));
fs.chmodSync(evidence, 0o700);
const privateLog = fs.mkdtempSync(path.join(os.tmpdir(), 'summary-reader-fixture-'));
const log = fs.openSync(path.join(privateLog, 'fixture.stderr'), 'wx', 0o600);
const {chromium} = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
const fixture = spawn(process.execPath, ['services/oauth/test/helpers/console-functional-preview.mjs'], {cwd: root, stdio: ['pipe', 'pipe', log]});
const queue = [], waiters = [];
createInterface({input: fixture.stdout}).on('line', line => {
  if (!line.startsWith('{')) return;
  const value = JSON.parse(line);if (waiters.length) waiters.shift()(value);else queue.push(value);
});
async function read() {
  let timer;
  try {return await Promise.race([queue.length ? Promise.resolve(queue.shift()) : new Promise(r => waiters.push(r)),
    new Promise((_, reject) => {timer = setTimeout(() => reject(new Error('Synthetic fixture timeout')), 30000);})]);}
  finally {clearTimeout(timer);}
}
async function command(command) {
  fixture.stdin.write(JSON.stringify({command}) + '\n');const result = await read();
  assert.ok(!result.fixture_error, result.fixture_error);assert.equal(result.request, command);return result;
}
const checks = [], check = (name, value = true) => {assert.ok(value, name);checks.push(name);console.log(`PASS ${name}`);};
const settled = async page => {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})));
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
};
const screenshot = async (page, name) => {await settled(page);await page.screenshot({path: path.join(evidence, name + '.png'), fullPage: false});};
let browser, cfg, exitCode = 0;
try {
  cfg = await read();assert.equal(cfg.fixture, true);assert.match(cfg.url, /^http:\/\/127\.0\.0\.1:/);
  await command('seed-summaries');const seeded = await command('seed-summary-reader');
  browser = await chromium.launch({headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? {executablePath: process.env.CHROMIUM_EXECUTABLE} : {})});
  for (const [width, locale] of [[1440, 'zh-CN'], [390, 'zh-CN'], [320, 'zh-CN'], [1440, 'en'], [390, 'en'], [320, 'en']]) {
    const context = await browser.newContext({viewport: {width, height: 900}}), page = await context.newPage(), errors = [];
    page.setDefaultTimeout(15000);page.on('pageerror', e => errors.push(e.message));
    page.on('console', message => {if (message.type() === 'error' && /Content Security Policy|Refused/.test(message.text())) errors.push(message.text());});
    await context.addCookies([{name: cfg.cookie, value: cfg.accounts[0].token, url: cfg.url, httpOnly: true, sameSite: 'Lax'}]);
    await context.addInitScript(([locale, account]) => localStorage.setItem(`mnemuron.appearance.v1.${account}`, JSON.stringify({locale})), [locale, cfg.accounts[0].account_id]);
    const tag = `${width}-${locale === 'en' ? 'en' : 'zh'}`;
    await page.goto(cfg.url + '/app/summaries');await page.locator('.summary-library').waitFor();await settled(page);
    check(`${tag}: list fits the viewport`, await page.evaluate(() => document.scrollingElement.scrollWidth <= document.scrollingElement.clientWidth + 1));
    const entry = page.locator(`[data-summary="${seeded.normal_id}"]`);
    check(`${tag}: real validated excerpts are separated in the preview`, await entry.locator('.summary-preview-quote').count() === 3);
    check(`${tag}: technical data and superseded content are folded`, await page.locator('.summary-technical[open], .summary-history[open]').count() === 0);
    check(`${tag}: historical summary is not an actionable current result`, await page.locator('.summary-history [data-summary]').count() === 0);
    await screenshot(page, `list-${tag}`);

    // The normal keyboard path opens a real revision-bound summary.
    await entry.focus();await page.keyboard.press('Enter');await page.locator('.summary-reader .claim-list').waitFor();await settled(page);
    check(`${tag}: the pane title carries scope and date`, /Synthetic release rehearsal/.test(await page.locator('#detail-title').innerText()) && /2026-10-03/.test(await page.locator('#detail-title').innerText()));
    const paragraphs = await page.locator('.summary-excerpt .body-content').allTextContents();
    assert.deepEqual(paragraphs, [READER_FIRST_QUOTE, READER_SECOND_QUOTE, READER_OTHER_QUOTE]);
    check(`${tag}: exact paragraphs are readable and grouped by their two sources`);
    check(`${tag}: coverage distinguishes two cited sources from three inputs`, /2\s*\/\s*3/.test(await page.locator('.summary-reader-coverage').innerText()) && await page.locator('[data-i18n="summaryReaderOmittedNote"]').count() === 1);
    check(`${tag}: source grouping retains revision-bound navigation`, await page.locator(`.claim-list [data-memory="${seeded.source_id}"][data-revision="${seeded.source_revision}"]`).count() === 1);
    check(`${tag}: summary quality tools no longer lead the reading pane`, !(await page.locator('#memory-content [data-review-open="summary"]').isVisible()) && await page.locator('.summary-reader-tools[open]').count() === 0);
    const dimensions = await page.evaluate(() => {
      const pane = document.querySelector('#memory-dialog'), quote = document.querySelector('.summary-excerpt .body-content'), rect = quote.getBoundingClientRect();
      return {fits: pane.scrollWidth <= pane.clientWidth + 1, top: rect.top, width: rect.width, paneWidth: pane.clientWidth};
    });
    check(`${tag}: first excerpt is in the first fold with a full-width reading column`, dimensions.fits && dimensions.top < 540 && dimensions.width >= dimensions.paneWidth - 64);
    await screenshot(page, `detail-${tag}`);

    // Source round trip and quality disclosure use actual keyboard interaction, not DOM-only state.
    await page.locator('.claim-list [data-memory]').first().focus();await page.keyboard.press('Enter');
    await page.locator('#memory-content [data-detail-back]').waitFor();
    check(`${tag}: source opens separately with a route back`, await page.locator('#memory-content .claim-list').count() === 0);
    await page.locator('#memory-content [data-detail-back]').click();await page.locator('.summary-reader .claim-list').waitFor();
    assert.deepEqual(await page.locator('.summary-excerpt .body-content').allTextContents(), paragraphs);
    check(`${tag}: Back restores the same source-grouped summary`);
    await page.locator('.summary-reader-tools>summary').focus();await page.keyboard.press('Enter');
    check(`${tag}: quality tools and provenance remain available by keyboard`, await page.locator('#memory-content [data-review-open="summary"]').isVisible() && await page.locator('.summary-provenance').isVisible());
    check(`${tag}: expanded provenance stays inside the pane`, await page.locator('#memory-dialog').evaluate(d => d.scrollWidth <= d.clientWidth + 1));
    await page.locator('#memory-content [data-close]').click();
    check(`${tag}: closing restores focus to the original summary card`, await page.evaluate(id => document.activeElement?.dataset.summary === id, seeded.normal_id));
    check(`${tag}: no script or CSP errors`, errors.length === 0);

    if (width === 390 && locale === 'zh-CN') {
      // The synthetic session lowers the detail budget to 8 KiB while keeping its real source
      // under the public 4096-unit limit. Exercise the actual quote-fragment algorithm, not a
      // forged response or a giant quotation disconnected from its cited original.
      let response = page.waitForResponse(r => /\/console-api\/summary\?/.test(r.url()) && r.status() === 200);
      await page.locator(`[data-summary="${seeded.long_id}"]`).click();
      let result = await (await response).json(), content = '', pages = 0;
      while (true) {
        await page.locator('.summary-reader .body-content').first().waitFor();
        content += (await page.locator('.summary-excerpt .body-content').allTextContents()).join('');pages++;
        check(`Long quotation page ${pages}: keeps the exact summary and revision`, result.results[0].summary_id === seeded.long_id && result.results[0].revision === 1);
        if (!result.next_request) {
          check('Last quotation page is marked as the end, not as all sources fact-checked', await page.locator('[data-i18n="summaryReaderEnd"]').count() === 1);break;
        }
        check(`Long quotation page ${pages}: next segment is explicit`, await page.locator('[data-i18n="summaryReaderExcerptPartial"]').count() === 1 && await page.locator('[data-detail-next]').count() === 1);
        response = page.waitForResponse(r => /\/console-api\/summary\?/.test(r.url()) && r.status() === 200);
        await page.locator('[data-detail-next]').click();result = await (await response).json();
        await page.locator('[data-i18n="summaryReaderContinuedQuote"]').waitFor();
        check(`Long quotation page ${pages + 1}: continuation starts at the top of the reading pane`, await page.locator('#memory-dialog').evaluate(d => d.scrollTop < 2));
        assert.ok(pages < 20, 'Pagination must make progress');
      }
      assert.equal(content, READER_LONG_QUOTE);check('Reduced-budget real quotation reassembles byte-for-byte without loss or repetition', pages > 1);
      await screenshot(page, 'long-quote-continuation-390-zh');
      await page.locator('#memory-dialog .close-button').click();

      response = page.waitForResponse(r => /\/console-api\/summary\?/.test(r.url()) && r.status() === 200);
      await page.locator(`[data-summary="${seeded.multipage_id}"]`).click();
      result = await (await response).json();const collected = [];pages = 0;
      while (true) {
        await page.locator('.summary-reader .body-content').first().waitFor();
        collected.push(...await page.locator('.summary-excerpt .body-content').allTextContents());pages++;
        check(`Standard 48 KiB page ${pages}: keeps its summary binding`, result.results[0].summary_id === seeded.multipage_id && result.budget_bytes === 48 * 1024);
        if (!result.next_request) break;
        response = page.waitForResponse(r => /\/console-api\/summary\?/.test(r.url()) && r.status() === 200);
        await page.locator('[data-detail-next]').click();result = await (await response).json();
        await page.locator('[data-i18n="summaryReaderContinued"]').waitFor();
        assert.ok(pages < 20, 'Standard pagination must make progress');
      }
      assert.deepEqual(collected, READER_PAGE_QUOTES);check('Normal 48 KiB pagination retains every exact source quote', pages > 1);
      await page.locator('#memory-dialog .close-button').click();
    }
    await context.close();
  }
} catch (error) {exitCode = 1;console.error(`FAIL ${error.stack || error.message}`);}
finally {
  await browser?.close();
  if (fixture.exitCode === null) {fixture.stdin.write(JSON.stringify({command: 'stop'}) + '\n');await new Promise(resolve => fixture.once('exit', resolve));}
  fs.writeFileSync(path.join(evidence, 'checks.json'), JSON.stringify({passed: checks.length, failed: exitCode, checks}, null, 2), {mode: 0o600});
  if (exitCode) console.error('Private fixture log: ' + privateLog);else fs.rmSync(privateLog, {recursive: true, force: true});
  console.log(`${exitCode ? 'FAILED' : 'PASSED'} ${checks.length} checks; evidence ${evidence}`);
}
process.exit(exitCode);
