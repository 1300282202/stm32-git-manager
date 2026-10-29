'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile), base = path.join(require('node:os').tmpdir(), 'stm32-public-tests', 'stm32-c-edge-qa');
process.env.GIT_CONFIG_GLOBAL = path.join(base, 'no-global'); process.env.GIT_CONFIG_NOSYSTEM = '1';
const { GitService } = require('../src/git-service.cjs');
async function fixture(t) {
  await fs.mkdir(base, { recursive: true }); const dir = await fs.mkdtemp(path.join(base, 'case-')), root = path.join(dir, 'repo'); await fs.mkdir(root);
  const git = async args => (await exec('git', ['-c', `safe.directory=${root}`, '-C', root, ...args], { windowsHide: true })).stdout.trim();
  await git(['init', '-b', 'main']); await git(['config', 'user.name', 'C Edge']); await git(['config', 'user.email', 'c-edge@example.invalid']);
  const commit = async subject => { await git(['add', '.']); await git(['commit', '-m', subject]); return git(['rev-parse', 'HEAD']); };
  await fs.writeFile(path.join(root, 'item'), 'file before shape change'); const first = await commit('base');
  const service = new GitService({ dataDir: path.join(dir, 'data') }), call = (action, extra = {}) => service.execute(action, { projectPath: root, ...extra }), change = async (action, extra) => call(action, { token: (await call('state')).token, ...extra });
  t.after(async () => { const rel = path.relative(base, dir); assert.ok(rel && !rel.startsWith('..') && !path.isAbsolute(rel)); await fs.rm(dir, { recursive: true, force: true }); });
  return { dir, root, git, commit, first, call, change };
}
test('backup export supports a former directory replaced by a file after hard reset', async t => {
  const f = await fixture(t); await fs.unlink(path.join(f.root, 'item')); await fs.mkdir(path.join(f.root, 'item')); await fs.writeFile(path.join(f.root, 'item/子文件.txt'), 'old directory bytes'); await f.commit('directory');
  const preview = await f.call('expertPreview', { kind: 'reset', mode: 'hard', target: f.first }); const result = await f.call('expertExecute', { previewToken: preview.token, confirmation: preview.confirmText });
  const out = path.join(f.dir, 'empty'); await fs.mkdir(out); await f.call('expertBackupExport', { id: result.backupId, destination: out }); assert.equal(await fs.readFile(path.join(out, 'item/子文件.txt'), 'utf8'), 'old directory bytes'); assert.equal(await fs.readFile(path.join(f.root, 'item'), 'utf8'), 'file before shape change');
});
test('nested repositories and directory junctions are rejected before previews can become destructive', async t => {
  const f = await fixture(t); await fs.mkdir(path.join(f.root, 'nested/.git'), { recursive: true });
  await assert.rejects(f.call('expertPreview', { kind: 'reset', target: f.first, mode: 'hard' }), /嵌套仓库|子模块/);
  await fs.rmdir(path.join(f.root, 'nested/.git')); await fs.rmdir(path.join(f.root, 'nested'));
  const external = path.join(f.dir, 'outside'); await fs.mkdir(external); await fs.writeFile(path.join(external, 'keep.txt'), 'keep'); await fs.symlink(external, path.join(f.root, 'linked'), 'junction');
  await assert.rejects(f.call('expertPreview', { kind: 'clean', includeIgnored: true }), /链接|联接/); assert.equal(await fs.readFile(path.join(external, 'keep.txt'), 'utf8'), 'keep');
});
test('skipped bisect candidates produce an ambiguous result rather than a false first bad commit', async t => {
  const f = await fixture(t), refs = [f.first]; for (let i = 1; i < 4; i++) { await fs.writeFile(path.join(f.root, 'item'), 'value ' + i); refs.push(await f.commit('version ' + i)); }
  await f.change('expertBisectStart', { good: refs[0], bad: refs[3] }); let status = await f.call('expertBisectStatus');
  for (let i = 0; i < 4 && !status.ambiguous; i++) { await f.change('expertBisectMark', { verdict: 'skip', candidate: status.candidate, logToken: status.logToken }); status = await f.call('expertBisectStatus'); }
  assert.equal(status.found, null); assert.equal(status.ambiguous, true); assert.equal(await f.git(['rev-parse', 'HEAD']), refs[3]); await f.change('expertBisectStop', {}); assert.equal((await f.call('expertBisectStatus')).active, false);
});
