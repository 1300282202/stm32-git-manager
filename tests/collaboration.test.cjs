'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);
const testRoot = path.join(require('node:os').tmpdir(), 'stm32-public-tests', 'stm32-b-qa');
process.env.GIT_CONFIG_GLOBAL = path.join(testRoot, 'no-global-config');
process.env.GIT_CONFIG_NOSYSTEM = '1';
const { GitService } = require('../src/git-service.cjs');
async function git(root, args) {
  const result = await exec('git', ['-c', `safe.directory=${root}`, '-c', 'core.quotepath=false', '-C', root, ...args], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  return result.stdout.trim();
}
async function fixture(t) {
  await fs.mkdir(testRoot, { recursive: true });
  const directory = await fs.mkdtemp(path.join(testRoot, 'case-'));
  const root = path.join(directory, '工程 & B'); await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'main.c'), 'int pin = 0;\n');
  await git(root, ['init', '-b', 'main']);
  await git(root, ['config', 'user.name', 'B Fixture']); await git(root, ['config', 'user.email', 'b@example.invalid']);
  await git(root, ['add', '--', 'main.c']); await git(root, ['commit', '-m', 'base']);
  const service = new GitService({ dataDir: path.join(directory, 'data'), seedProjects: [root] });
  const call = (action, value = {}) => service.execute(action, { projectPath: root, ...value });
  const change = async (action, value = {}) => call(action, { token: (await call('state')).token, ...value });
  const commit = async (name, content, message) => { await fs.writeFile(path.join(root, name), content); await git(root, ['add', '--', name]); await git(root, ['commit', '-m', message]); return git(root, ['rev-parse', 'HEAD']); };
  t.after(async () => {
    const relative = path.relative(testRoot, directory);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await fs.rm(directory, { force: true, recursive: true });
  });
  return { directory, root, service, call, change, commit };
}

test('B collaboration workflows', { concurrency: 3 }, async t => {
  await Promise.all([
    t.test('branches and stash preserve index, working bytes and untracked files', async t => {
      const f = await fixture(t);
      await f.change('branchCreate', { name: 'feature/button', switchTo: true });
      await fs.writeFile(path.join(f.root, 'main.c'), 'int pin = 1;\n'); await git(f.root, ['add', 'main.c']);
      await fs.writeFile(path.join(f.root, 'main.c'), 'int pin = 2;\n'); await fs.writeFile(path.join(f.root, '草稿.txt'), 'draft');
      await assert.rejects(f.change('branchSwitch', { name: 'main' }), /未提交/);
      await f.change('stashCreate', { message: '按键实验', includeUntracked: true });
      assert.equal((await f.call('state')).files.length, 0);
      const stash = (await f.call('stashes')).items[0];
      await f.change('branchSwitch', { name: 'main' });
      await f.change('stashApply', { hash: stash.hash, reinstateIndex: true });
      assert.equal(await fs.readFile(path.join(f.root, 'main.c'), 'utf8'), 'int pin = 2;\n');
      assert.equal(await git(f.root, ['show', ':main.c']), 'int pin = 1;');
      assert.equal(await fs.readFile(path.join(f.root, '草稿.txt'), 'utf8'), 'draft');
      await f.change('stashDrop', { hash: stash.hash });
      const list = await f.call('stashes'); assert.equal(list.items.length, 0); assert.equal(list.archives.length, 1);
      await f.change('stashRecover', { id: list.archives[0].id }); assert.equal((await f.call('stashes')).items[0].hash, stash.hash);
    }),
    t.test('fast-forward merge, rename and merged-branch deletion work without rewriting main', async t => {
      const f = await fixture(t);
      await f.change('branchCreate', { name: 'feature/uart', switchTo: true });
      const featureHash = await f.commit('uart.c', 'void uart(void) {}\n', 'add uart');
      await f.change('branchSwitch', { name: 'main' });
      const preview = await f.call('mergePreview', { source: 'feature/uart' }); assert.equal(preview.fastForward, true);
      const result = await f.change('merge', { source: preview.source, sourceHash: preview.sourceHash });
      assert.equal(result.conflicted, false); assert.equal(result.state.head, featureHash);
      await f.change('branchRename', { name: 'feature/uart', newName: 'feature/uart-done' });
      await f.change('branchDelete', { name: 'feature/uart-done' });
      assert.deepEqual((await f.call('branches')).local.map(item => item.name), ['main']);
    }),
    t.test('merge conflicts can be aborted with backups, then edited and continued', async t => {
      const f = await fixture(t);
      await f.change('branchCreate', { name: 'feature/button', switchTo: true });
      await f.commit('main.c', 'int pin = 1;\n', 'feature change');
      await f.change('branchSwitch', { name: 'main' }); await f.commit('main.c', 'int pin = 2;\n', 'main change');
      let result = await f.change('merge', { source: 'feature/button' }); assert.equal(result.conflicted, true);
      const conflict = await f.call('conflictFile', { path: 'main.c' }); assert.match(conflict.ours.text, /pin = 2/); assert.match(conflict.theirs.text, /pin = 1/);
      await f.change('abortOperation'); assert.equal(await fs.readFile(path.join(f.root, 'main.c'), 'utf8'), 'int pin = 2;\n');
      assert.ok((await f.call('backups')).backups.some(item => item.reason === 'abortOperation'));
      result = await f.change('merge', { source: 'feature/button' }); assert.equal(result.conflicted, true);
      await f.change('resolveConflict', { path: 'main.c', choice: 'edited', text: 'int pin = 3;\n' });
      await f.change('continueOperation'); assert.equal((await f.call('state')).operation, null);
      assert.equal(await fs.readFile(path.join(f.root, 'main.c'), 'utf8'), 'int pin = 3;\n');
    }),
    t.test('cherry-pick, annotated labels, detached worktree and ZIP export use committed versions', async t => {
      const f = await fixture(t);
      await f.change('branchCreate', { name: 'feature/sensor', switchTo: true });
      const selected = await f.commit('sensor.c', 'void sensor(void) {}\n', 'sensor support');
      await f.change('branchSwitch', { name: 'main' }); await f.change('cherryPick', { hash: selected });
      const head = (await f.call('state')).head;
      await f.change('tagCreate', { name: 'v1.0-demo', message: '传感器演示版本', hash: head });
      assert.equal((await f.call('tags')).items[0].hash, head);
      const worktree = path.join(f.directory, '旧版 目录');
      await f.change('worktreeAdd', { destination: worktree, hash: head });
      assert.equal(await fs.readFile(path.join(worktree, 'sensor.c'), 'utf8'), 'void sensor(void) {}\n');
      assert.equal((await f.call('worktrees')).items.length, 2);
      const archive = path.join(f.directory, 'source.zip');
      const exported = await f.change('exportArchive', { hash: head, destination: archive });
      assert.ok(exported.bytes > 100); assert.equal((await fs.readFile(archive)).subarray(0, 2).toString(), 'PK');
      await assert.rejects(f.change('exportArchive', { hash: head, destination: archive }), /已经存在/);
      await fs.writeFile(path.join(worktree, 'pending.c'), 'do not delete');
      await assert.rejects(f.change('worktreeRemove', { worktreePath: worktree }), /未跟踪/);
      await fs.unlink(path.join(worktree, 'pending.c'));
      await f.change('worktreeRemove', { worktreePath: worktree }); assert.equal(await fs.stat(worktree).then(() => true, () => false), false);
      await f.change('tagDelete', { name: 'v1.0-demo' }); assert.equal((await f.call('tags')).items.length, 0);
    }),
    t.test('remote fetch/push/fast-forward pull work with a local bare repository and reject divergence', async t => {
      const f = await fixture(t); const bare = path.join(f.directory, 'remote.git'); await fs.mkdir(bare);
      await git(bare, ['init', '--bare', '-b', 'main']);
      await f.change('remoteSave', { name: 'origin', url: bare });
      await f.change('push', { remote: 'origin', url: bare });
      assert.equal((await f.call('remotes')).ahead, 0);
      const peer = path.join(f.directory, 'peer');
      await git(f.root, ['-c', `safe.directory=${bare}`, 'clone', '--', bare, peer]);
      await git(peer, ['config', 'user.name', 'Peer']); await git(peer, ['config', 'user.email', 'peer@example.invalid']);
      await fs.writeFile(path.join(peer, 'main.c'), 'int pin = 4;\n'); await git(peer, ['add', 'main.c']); await git(peer, ['commit', '-m', 'peer update']); await git(peer, ['push']);
      await f.change('fetch', { remote: 'origin', url: bare }); assert.equal((await f.call('remotes')).behind, 1);
      await f.change('pull', { remote: 'origin', url: bare }); assert.equal(await fs.readFile(path.join(f.root, 'main.c'), 'utf8'), 'int pin = 4;\n');
      const localHead = await f.commit('local.c', 'int local;\n', 'local update');
      await fs.writeFile(path.join(peer, 'peer.c'), 'int peer;\n'); await git(peer, ['add', 'peer.c']); await git(peer, ['commit', '-m', 'diverge']); await git(peer, ['push']);
      await assert.rejects(f.change('pull', { remote: 'origin', url: bare }), /无法直接快进/);
      assert.equal((await f.call('state')).head, localHead);
      await assert.rejects(f.change('push', { remote: 'origin', url: bare }), /上传未完成/);
    }),
    t.test('stale state, unsafe addresses and branch names cannot trigger unintended actions', async t => {
      const f = await fixture(t); const before = await f.call('state');
      await fs.writeFile(path.join(f.root, 'main.c'), 'int external;\n');
      await assert.rejects(f.call('branchCreate', { name: 'stale', token: before.token }), /刷新/);
      await assert.rejects(f.change('branchCreate', { name: '--force' }));
      await assert.rejects(f.change('remoteSave', { name: 'origin', url: 'ext::malicious command' }));
      await assert.rejects(f.change('remoteSave', { name: 'origin', url: 'https://token@example.com/repo.git' }));
      assert.equal((await f.call('branches')).local.length, 1);
      assert.equal((await f.call('remotes')).items.length, 0);
    }),
  ]);
});
