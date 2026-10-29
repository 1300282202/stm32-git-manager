'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { _electron: electron } = require('playwright');
async function main() {
  const root = path.resolve(__dirname, '..'), base = path.join(root, '.test-work'); await fs.mkdir(base, { recursive: true });
  const data = await fs.mkdtemp(path.join(base, 'public-startup-'));
  const env = { ...process.env, STM32_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE; delete env.STM32_SEED_PROJECTS;
  const packaged = Boolean(process.env.STM32_TEST_EXE), pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const application = await electron.launch({ executablePath: process.env.STM32_TEST_EXE || require('electron'), args: packaged ? [] : [root], env, timeout: 60000 });
  const errors = [], outbound = []; let result;
  try {
    const page = await application.firstWindow(); page.on('pageerror', e => errors.push(e.message)); page.on('request', r => { if (/^https?:/.test(r.url())) outbound.push(r.url()); });
    await page.locator('#progress').waitFor({ state: 'hidden' });
    const info = await page.evaluate(() => window.stm32.invoke('appInfo'));
    const projects = await page.evaluate(() => window.stm32.invoke('projects'));
    assert.equal(info.version, pkg.version); assert.deepEqual(projects.recents, []); assert.deepEqual(projects.discovered, []);
    assert.equal(await page.locator('#error-banner').isVisible(), false); assert.deepEqual(errors, []); assert.deepEqual(outbound, []);
    await page.screenshot({ path: path.join(root, 'docs/images/welcome.png') });
    result = { passed: true, packaged, version: info.version, firstRunHasNoProjects: true, errors, outbound };
    await fs.writeFile(path.join(base, 'startup-result.json'), JSON.stringify(result, null, 2) + '\n');
  } finally { await application.close(); }
  console.log(JSON.stringify(result));
}
main().catch(e => { console.error(e); process.exitCode = 1; });

