'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);
const testRoot = path.join(require('node:os').tmpdir(), 'stm32-public-tests', 'stm32-c-qa');
process.env.GIT_CONFIG_GLOBAL = path.join(testRoot, 'no-global'); process.env.GIT_CONFIG_NOSYSTEM = '1';
const { GitService } = require('../src/git-service.cjs');
const { keyFor } = require('../src/git-utils.cjs');
async function git(root, args) { return (await exec('git', ['-c', `safe.directory=${root}`, '-c', 'core.quotepath=false', '-C', root, ...args], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 })).stdout.trim(); }
async function fixture(t) {
  await fs.mkdir(testRoot, { recursive: true }); const directory = await fs.mkdtemp(path.join(testRoot, 'case-'));
  const root = path.join(directory, '工程 & 中文'); await fs.mkdir(root);
  await git(root, ['init', '-b', 'main']); await git(root, ['config', 'user.name', 'C Fixture']); await git(root, ['config', 'user.email', 'c@example.invalid']);
  await fs.writeFile(path.join(root, '.gitignore'), 'Objects/\n'); await fs.writeFile(path.join(root, 'main.c'), 'int value = 0;\n');
  await git(root, ['add', '.']); await git(root, ['commit', '-m', 'base']);
  const base = await git(root, ['rev-parse', 'HEAD']); const dataDir = path.join(directory, 'data');
  const service = new GitService({ dataDir }); const call = (action, extra = {}) => service.execute(action, { projectPath: root, ...extra });
  const change = async (action, extra = {}) => call(action, { token: (await call('state')).token, ...extra });
  const commit = async (value, subject = 'value ' + value) => { await fs.writeFile(path.join(root, 'main.c'), `int value = ${value};\n`); await git(root, ['add', '.']); await git(root, ['commit', '-m', subject]); return git(root, ['rev-parse', 'HEAD']); };
  const preview = extra => call('expertPreview', extra);
  const execute = (p, extra = {}) => call('expertExecute', { previewToken: p.token, confirmation: p.confirmText, ...extra });
  t.after(async () => { const rel = path.relative(testRoot, directory); assert.ok(rel && !rel.startsWith('..') && !path.isAbsolute(rel)); await fs.rm(directory, { recursive: true, force: true }); });
  return { root, directory, dataDir, service, call, change, commit, base, preview, execute };
}
test('C1 expert workflows', { concurrency: 3 }, async t => {
  await Promise.all([
    t.test('hard reset preserves committed history, working bytes and original index in verified backups', async t => {
      const f = await fixture(t), head = await f.commit(1);
      await fs.writeFile(path.join(f.root, 'main.c'), 'staged'); await git(f.root, ['add', 'main.c']); await fs.writeFile(path.join(f.root, 'main.c'), 'working');
      const binary = Buffer.from([0, 255, 3, 7]); await fs.writeFile(path.join(f.root, '资料 & 草稿.bin'), binary); await fs.mkdir(path.join(f.root, 'Objects')); await fs.writeFile(path.join(f.root, 'Objects/out.bin'), binary);
      const index = await fs.readFile(path.join(f.root, '.git/index')); const p = await f.preview({ kind: 'reset', target: f.base, mode: 'hard' });
      await assert.rejects(f.execute(p, { confirmation: 'wrong' }), /确认文字/);
      const result = await f.execute(p); assert.equal(result.state.head, f.base); assert.equal(await git(f.root, ['rev-parse', result.rescueBranch]), head);
      assert.equal(await fs.readFile(path.join(f.root, 'main.c'), 'utf8'), 'int value = 0;\n');
      const backup = path.join(f.dataDir, 'expert-backups', keyFor(f.root), result.backupId);
      assert.deepEqual(await fs.readFile(path.join(backup, 'index.bin')), index);
      const out = path.join(f.directory, '导出'); await fs.mkdir(out); await f.call('expertBackupExport', { id: result.backupId, destination: out });
      assert.equal(await fs.readFile(path.join(out, 'main.c'), 'utf8'), 'working'); assert.deepEqual(await fs.readFile(path.join(out, '资料 & 草稿.bin')), binary); assert.deepEqual(await fs.readFile(path.join(out, 'Objects/out.bin')), binary);
      assert.equal((await f.call('expertBackups')).items[0].phase, 'completed');
      await fs.writeFile(path.join(backup, 'files/main.c'), 'tamper'); const empty = path.join(f.directory, 'empty'); await fs.mkdir(empty);
      await assert.rejects(f.call('expertBackupExport', { id: result.backupId, destination: empty }), /校验失败/); assert.deepEqual(await fs.readdir(empty), []);
    }),
    t.test('soft and mixed reset preserve disk bytes and have distinct index effects', async t => {
      const f = await fixture(t), second = await f.commit(1);
      await fs.writeFile(path.join(f.root, 'main.c'), 'stage 2'); await git(f.root, ['add', 'main.c']); await fs.writeFile(path.join(f.root, 'main.c'), 'work 3');
      const index = await fs.readFile(path.join(f.root, '.git/index'));
      await f.execute(await f.preview({ kind: 'reset', target: f.base, mode: 'soft' }));
      assert.deepEqual(await fs.readFile(path.join(f.root, '.git/index')), index); assert.equal(await fs.readFile(path.join(f.root, 'main.c'), 'utf8'), 'work 3');
      await f.execute(await f.preview({ kind: 'reset', target: second, mode: 'mixed' }));
      assert.equal(await git(f.root, ['show', ':main.c']), 'int value = 1;'); assert.equal(await fs.readFile(path.join(f.root, 'main.c'), 'utf8'), 'work 3');
    }),
    t.test('clean requires selected preview files; ignored edits invalidate old previews and sources remain', async t => {
      const f = await fixture(t); await fs.mkdir(path.join(f.root, 'Objects')); await fs.writeFile(path.join(f.root, 'Objects/a.bin'), Buffer.from([0, 1, 255])); await fs.writeFile(path.join(f.root, '未跟踪.txt'), 'draft');
      const first = await f.preview({ kind: 'clean', includeIgnored: true }); assert.ok(first.candidates.some(item => item.ignored));
      await fs.writeFile(path.join(f.root, 'Objects/a.bin'), 'changed ignored');
      await assert.rejects(f.execute(first, { paths: ['Objects/a.bin'] }), /预览后改变/);
      const fresh = await f.preview({ kind: 'clean', includeIgnored: true });
      await assert.rejects(f.execute(fresh, { paths: ['main.c'] }), /只能清理/); await assert.rejects(f.execute(fresh, { paths: ['../outside'] }), /只能清理/);
      const result = await f.execute(fresh, { paths: ['Objects/a.bin', '未跟踪.txt'] });
      assert.equal(await fs.readFile(path.join(f.root, 'main.c'), 'utf8'), 'int value = 0;\n'); await assert.rejects(fs.stat(path.join(f.root, '未跟踪.txt')), { code: 'ENOENT' }); assert.ok((await fs.stat(path.join(f.root, 'Objects'))).isDirectory());
      const out = path.join(f.directory, 'recover'); await fs.mkdir(out); await f.call('expertBackupExport', { id: result.backupId, destination: out }); assert.equal(await fs.readFile(path.join(out, 'Objects/a.bin'), 'utf8'), 'changed ignored');
    }),
    t.test('amend is limited to unshared clean history; revert creates a new commit and conflict abort is backed up', async t => {
      const f = await fixture(t), second = await f.commit(1);
      const amended = await f.execute(await f.preview({ kind: 'amend', message: '新的说明' })); assert.notEqual(amended.state.head, second); assert.equal(await git(f.root, ['show', '-s', '--format=%s', 'HEAD']), '新的说明'); assert.equal(await git(f.root, ['rev-parse', amended.rescueBranch]), second);
      await git(f.root, ['update-ref', 'refs/remotes/origin/main', amended.state.head]); await assert.rejects(f.preview({ kind: 'amend', message: 'shared' }), /已共享/);
      const reversed = await f.execute(await f.preview({ kind: 'revert', target: amended.state.head })); assert.notEqual(reversed.state.head, f.base); assert.equal(await fs.readFile(path.join(f.root, 'main.c'), 'utf8'), 'int value = 0;\n');
      const target = await f.commit(2); await f.commit(3);
      const conflict = await f.execute(await f.preview({ kind: 'revert', target })); assert.equal(conflict.conflicted, true); assert.equal(conflict.state.operation, '撤销提交');
      await f.change('abortOperation'); assert.equal(await fs.readFile(path.join(f.root, 'main.c'), 'utf8'), 'int value = 3;\n');
    }),
    t.test('reflog rescue does not switch branches or overwrite unfinished files', async t => {
      const f = await fixture(t), second = await f.commit(1); await fs.writeFile(path.join(f.root, 'main.c'), 'unfinished');
      const result = await f.change('expertRescue', { hash: f.base, name: 'rescue/old-base' }); assert.equal(result.state.head, second); assert.equal(result.state.branch, 'main'); assert.equal(await fs.readFile(path.join(f.root, 'main.c'), 'utf8'), 'unfinished');
      assert.ok((await f.call('expertReflog')).items.some(item => item.hash === f.base)); await assert.rejects(f.change('expertRescue', { hash: 'HEAD;bad', name: 'rescue/x' }), /有效版本/);
    }),
    t.test('no-checkout bisect finds the known bug using independent worktrees and preserves the main project', async t => {
      const f = await fixture(t), commits = [f.base]; for (let i = 1; i < 8; i++) commits.push(await f.commit(i));
      const initial = await fs.readFile(path.join(f.root, 'main.c')); await f.change('expertBisectStart', { good: commits[0], bad: commits[7] });
      let status = await f.call('expertBisectStatus'); assert.ok(status.active && status.managed);
      const worktree = path.join(f.directory, 'candidate'); await fs.mkdir(worktree); await f.change('expertBisectWorktree', { destination: worktree, candidate: status.candidate, logToken: status.logToken });
      assert.equal(await git(worktree, ['rev-parse', 'HEAD']), status.candidate);
      let stale;
      for (let i = 0; !status.found && i < 6; i++) {
        const value = Number(/value = (\d+)/.exec(await git(f.root, ['show', status.candidate + ':main.c']))[1]); stale = status;
        await f.change('expertBisectMark', { verdict: value < 4 ? 'good' : 'bad', candidate: status.candidate, logToken: status.logToken }); status = await f.call('expertBisectStatus');
      }
      assert.equal(status.found, commits[4]); assert.equal(await git(f.root, ['rev-parse', 'HEAD']), commits[7]); assert.deepEqual(await fs.readFile(path.join(f.root, 'main.c')), initial);
      await assert.rejects(f.change('expertBisectMark', { verdict: 'good', candidate: stale.candidate, logToken: stale.logToken }), /候选版本已变化|已经找到/);
      await fs.writeFile(path.join(f.root, 'main.c'), 'edit while bisect'); await f.change('expertBisectStop'); assert.equal((await f.call('expertBisectStatus')).active, false); assert.equal(await fs.readFile(path.join(f.root, 'main.c'), 'utf8'), 'edit while bisect');
    }),
    t.test('diagnostics, complete command catalog and offline bundle use fixed commands; bundle is clonable and never overwritten', async t => {
      const f = await fixture(t), second = await f.commit(1); const before = await fs.readFile(path.join(f.root, '.git/index'));
      const catalog = await f.call('expertCatalog'); assert.ok(catalog.items.length >= 180); assert.ok(catalog.items.find(item => item.name === 'rebase').status === '目录与帮助'); assert.ok(catalog.items.find(item => item.name === 'credential-manager').kind === 'external');
      const help = await f.call('expertHelp', { command: 'reset' }); assert.match(help.text, /git reset/); await assert.rejects(f.call('expertHelp', { command: 'reset;whoami' }), /目录中的条目/);
      const diagnosis = await f.call('expertDiagnose'); assert.equal(diagnosis.passed, true); assert.deepEqual(await fs.readFile(path.join(f.root, '.git/index')), before);
      await fs.writeFile(path.join(f.root, 'main.c'), 'not committed'); const bundle = path.join(f.directory, 'history.bundle'); const result = await f.change('expertBundleExport', { destination: bundle }); assert.ok(result.bytes > 0); assert.equal((await f.call('expertBundleVerify', { filePath: bundle })).valid, true);
      const hash = crypto.createHash('sha256').update(await fs.readFile(bundle)).digest('hex'); await assert.rejects(f.change('expertBundleExport', { destination: bundle }), /已存在/); assert.equal(crypto.createHash('sha256').update(await fs.readFile(bundle)).digest('hex'), hash);
      const clone = path.join(f.directory, 'clone'); await git(f.directory, ['clone', '--no-checkout', '--', bundle, clone]); assert.equal(await git(clone, ['rev-parse', 'main']), second); assert.equal(await git(clone, ['show', 'main:main.c']), 'int value = 1;'); assert.equal(await fs.readFile(path.join(f.root, 'main.c'), 'utf8'), 'not committed');
    }),
  ]);
});
