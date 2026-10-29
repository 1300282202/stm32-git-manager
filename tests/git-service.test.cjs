'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);

const testRoot = path.join(os.tmpdir(), 'stm32-public-tests', 'stm32-manager-qa');
// Isolate subprocess Git configuration from the user's global hooks, signing and identity.
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = path.join(testRoot, 'nonexistent-global-config');
process.env.GIT_TERMINAL_PROMPT = '0';

const { GitService } = require('../src/git-service.cjs');

test('successful commit survives operation-log failure without losing its commit result', async (t) => {
  const f = await fixture(t);
  await f.stage(['User/main.c']);
  f.service.log = async () => { throw new Error('simulated log storage failure'); };
  const result = await f.commit('版本保存成功，日志不可写');
  assert.match(result.hash, /^[0-9a-f]{40,64}$/);
  assert.match(result.warning, /操作已经完成/);
  assert.equal(await git(f.projectPath, ['rev-parse', 'HEAD']), result.hash);
  assert.equal((await f.call('history')).commits.length, 1);
});

test('backup remains actionable if another Git client changes the index after file restoration', async (t) => {
  const f = await fixture(t);
  await f.stage(['User/main.c']);
  const first = await f.commit('初始版本');
  const modified = Buffer.from('int pending_work = 42;\n');
  await f.write('User/main.c', modified);
  const preview = await f.call('restorePreview', { path: 'User/main.c', hash: first.hash });
  const originalGit = f.service.git.bind(f.service);
  f.service.git = async (root, args, options) => {
    const result = await originalGit(root, args, options);
    if (args[0] === 'restore' && args.includes('--worktree')) await git(f.projectPath, ['add', '--', 'Project.uvprojx']);
    return result;
  };
  await assert.rejects(f.call('restore', { path: 'User/main.c', hash: first.hash, token: preview.token }), /外部程序改变了暂存区/);
  const records = (await f.call('backups')).backups;
  const backup = records.find(record => record.reason === 'restore');
  assert.ok(backup?.canUndo);
  f.service.git = originalGit;
  await f.call('undoRestore', { backupId: backup.id });
  assert.deepEqual(await fs.readFile(path.join(f.projectPath, 'User/main.c')), modified);
  assert.match(await git(f.projectPath, ['diff', '--cached', '--name-only']), /Project\.uvprojx/);
});

async function git(cwd, args, options = {}) {
  const result = await execFileAsync('git', ['-c', 'core.quotepath=false', '-c', `safe.directory=${cwd}`, ...args], {
    cwd, windowsHide: true, encoding: options.raw ? 'buffer' : 'utf8',
    maxBuffer: 10 * 1024 * 1024, env: process.env,
  });
  return options.raw ? result.stdout : result.stdout.trim();
}

const xmlEscape = (value) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
function keilXml(outputDir = '.\\Objects\\', listingDir = '.\\Listings\\') {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Project><SchemaVersion>2.1</SchemaVersion><Targets><Target><TargetName>Target 1</TargetName>
<TargetOption><TargetCommonOption><Device>STM32F103C8</Device><pCCUsed>5060061::V5.06 update 1 (build 61)::ARMCC</pCCUsed>
<OutputDirectory>${xmlEscape(outputDir)}</OutputDirectory><ListingPath>${xmlEscape(listingDir)}</ListingPath><OutputName>Project</OutputName>
</TargetCommonOption><TargetArmAds><Cads><VariousControls><IncludePath>.\\User</IncludePath></VariousControls></Cads></TargetArmAds></TargetOption>
<Groups><Group><GroupName>User</GroupName><Files><File><FileName>main.c</FileName><FileType>1</FileType><FilePath>.\\User\\main.c</FilePath></File></Files></Group></Groups>
</Target></Targets></Project>`;
}

async function fixture(t, options = {}) {
  await fs.mkdir(testRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(testRoot, 'case-'));
  const projectPath = path.join(root, '工程 & spaces');
  const dataDir = path.join(root, 'app-data');
  await fs.mkdir(path.join(projectPath, 'User'), { recursive: true });
  await fs.writeFile(path.join(projectPath, 'User/main.c'), 'int main(void) { return 0; }\n');
  await fs.writeFile(path.join(projectPath, 'Project.uvprojx'), keilXml());
  const service = new GitService({ dataDir, seedProjects: [projectPath] });
  t.after(async () => {
    const relative = path.relative(testRoot, root);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'cleanup remains inside dedicated test directory');
    await fs.rm(root, { recursive: true, force: true });
  });
  const call = (action, args = {}) => service.execute(action, { projectPath, ...args });
  if (options.initialize !== false) {
    await call('init');
    await call('identity', { name: 'Fixture Author', email: 'fixture@example.invalid' });
    await git(projectPath, ['config', 'commit.gpgsign', 'false']);
  }
  const state = () => call('state');
  const stage = async (paths) => call('stage', { paths, token: (await state()).token });
  const commit = async (message = '记录测试版本') => call('commit', { message, token: (await state()).token });
  const write = async (relative, data) => {
    const destination = path.join(projectPath, relative);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, data);
  };
  return { root, projectPath, dataDir, service, call, state, stage, commit, write };
}

test('first-time project: init, empty history, Keil recognition, stage and unstage before first commit', async (t) => {
  const f = await fixture(t, { initialize: false });
  const initial = await f.call('inspect');
  assert.equal(initial.isRepo, false);
  assert.ok(initial.keil.projects.some((p) => p.targets.some((target) => target.device === 'STM32F103C8')));
  const initialized = await f.call('init');
  assert.equal(initialized.isRepo, true);
  assert.equal(initialized.branch, 'main');
  assert.equal(initialized.head, null);
  assert.deepEqual((await f.call('history')).commits, []);
  await f.stage(['User/main.c']);
  assert.equal((await f.state()).files.find((x) => x.path === 'User/main.c').staged, true);
  await f.call('unstage', { paths: ['User/main.c'], token: (await f.state()).token });
  assert.equal(await git(f.projectPath, ['ls-files']), '');
  assert.equal((await f.state()).files.find((x) => x.path === 'User/main.c').untracked, true);
});

test('commit records only staged bytes, retaining later working edits and unselected files', async (t) => {
  const f = await fixture(t);
  const stagedText = 'int main(void) { return 1; }\n';
  const workingText = 'int main(void) { return 2; }\n';
  await f.write('User/main.c', stagedText);
  await f.stage(['User/main.c']);
  await f.write('User/main.c', workingText);
  const state = await f.state();
  const item = state.files.find((x) => x.path === 'User/main.c');
  assert.equal(item.staged, true);
  assert.equal(item.unstaged, true);
  const stagedDiff = await f.call('diff', { path: 'User/main.c', mode: 'staged' });
  assert.match(stagedDiff.text, /return 1/);
  const workingDiff = await f.call('diff', { path: 'User/main.c', mode: 'working' });
  assert.match(workingDiff.text, /return 2/);
  const committed = await f.commit('只保存已选中的代码');
  assert.match(committed.hash, /^[0-9a-f]{40,64}$/);
  assert.equal((await git(f.projectPath, ['show', 'HEAD:User/main.c'], { raw: true })).toString(), stagedText);
  assert.equal(await fs.readFile(path.join(f.projectPath, 'User/main.c'), 'utf8'), workingText);
  assert.equal(await git(f.projectPath, ['ls-tree', '-r', '--name-only', 'HEAD']), 'User/main.c');
  assert.equal((await f.call('history')).commits[0].subject, '只保存已选中的代码');
  const rootDiff = await f.call('diff', { path: 'User/main.c', mode: 'commit', hash: committed.hash });
  assert.match(rootDiff.text, /return 1/);
});

test('history, historical tree and file viewing return the selected revision rather than current bytes', async (t) => {
  const f = await fixture(t);
  await f.stage(['User/main.c']);
  const first = await f.commit('第一版 LED');
  await f.write('User/main.c', 'int main(void) { return 5; }\n');
  await f.stage(['User/main.c']);
  await f.commit('第二版 按键');
  const history = await f.call('history', { limit: 1 });
  assert.equal(history.commits.length, 1);
  assert.equal(history.hasMore, true);
  const next = await f.call('history', { skip: 1, limit: 1 });
  assert.equal(next.commits[0].hash, first.hash);
  const files = await f.call('historyFiles', { hash: first.hash });
  assert.ok(files.files.some((x) => x.path === 'User/main.c'));
  const content = await f.call('readFile', { path: 'User/main.c', source: 'commit', hash: first.hash });
  assert.match(content.text, /return 0/);
  assert.doesNotMatch(content.text, /return 5/);
});

test('rename detection and commits preserve Chinese and spaced file paths', async (t) => {
  const f = await fixture(t);
  const oldPath = 'User/按键 文件.c';
  const newPath = 'User/按键 新名称.c';
  await f.write(oldPath, 'void button(void) {}\n');
  await f.stage([oldPath]);
  await f.commit('新增按键文件');
  await fs.rename(path.join(f.projectPath, oldPath), path.join(f.projectPath, newPath));
  await f.stage([oldPath, newPath]);
  const renamed = (await f.state()).files.find((x) => x.path === newPath);
  assert.equal(renamed.kind, 'renamed');
  assert.equal(renamed.originalPath, oldPath);
  await f.commit('重命名按键文件');
  assert.equal(await git(f.projectPath, ['ls-tree', '-r', '--name-only', 'HEAD']), newPath);
});

test('stale state cannot stage files after their working contents changed', async (t) => {
  const f = await fixture(t);
  const stale = await f.state();
  await f.write('User/main.c', 'int changed_after_preview = 1;\n');
  await assert.rejects(f.call('stage', { paths: ['User/main.c'], token: stale.token }));
  assert.equal(await git(f.projectPath, ['ls-files']), '');
});

test('stale commit token cannot silently include a new externally staged file', async (t) => {
  const f = await fixture(t);
  await f.stage(['User/main.c']);
  const stale = await f.state();
  await git(f.projectPath, ['add', '--', 'Project.uvprojx']);
  await assert.rejects(f.call('commit', { message: 'outdated preview', token: stale.token }));
  assert.deepEqual((await f.call('history')).commits, []);
  assert.match(await git(f.projectPath, ['ls-files']), /Project\.uvprojx/);
});

test('empty commit message is rejected without losing the staged selection', async (t) => {
  const f = await fixture(t);
  await f.stage(['User/main.c']);
  await assert.rejects(f.call('commit', { message: '   ', token: (await f.state()).token }));
  assert.equal(await git(f.projectPath, ['ls-files']), 'User/main.c');
  const committed = await f.commit('有效提交');
  assert.ok(committed.hash);
});

test('metadata paths and traversal are rejected; file names cannot become Git options', async (t) => {
  const f = await fixture(t);
  const outside = path.join(f.root, 'outside.txt');
  await fs.writeFile(outside, 'outside sentinel');
  for (const badPath of ['../outside.txt', 'User/../../outside.txt', '.git/config', '.git/HEAD', outside]) {
    await assert.rejects(f.call('readFile', { path: badPath, source: 'working' }), badPath);
    await assert.rejects(f.call('stage', { paths: [badPath], token: (await f.state()).token }), badPath);
  }
  const literalName = '--not-a-git-option.c';
  await f.write(literalName, 'int safe_name;\n');
  await f.stage([literalName]);
  assert.equal(await git(f.projectPath, ['ls-files']), literalName);
  assert.equal(await fs.readFile(outside, 'utf8'), 'outside sentinel');
});

test('directory junctions cannot provide a path out of the selected project', async (t) => {
  const f = await fixture(t);
  const outside = path.join(f.root, 'outside-source');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'secret.c'), 'int outside_secret;');
  const link = path.join(f.projectPath, 'linked-source');
  try {
    await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) { t.skip('OS does not allow test symlink creation'); return; }
    throw error;
  }
  await assert.rejects(f.call('readFile', { path: 'linked-source/secret.c', source: 'working' }));
  await assert.rejects(f.call('stage', { paths: ['linked-source/secret.c'], token: (await f.state()).token }));
});

test('binary restore and undo are byte-exact and preserve the staged version and HEAD', async (t) => {
  const f = await fixture(t);
  const file = 'assets/校准数据.bin';
  const oldBytes = Buffer.from([0, 1, 2, 255, 13, 10]);
  const stagedBytes = Buffer.from([0, 3, 4, 254, 10]);
  const workingBytes = Buffer.from([0, 9, 8, 253, 13, 10, 77]);
  await f.write(file, oldBytes);
  await f.stage([file]);
  const first = await f.commit('初始校准数据');
  await f.write(file, stagedBytes);
  await f.stage([file]);
  await f.write(file, workingBytes);
  const indexBefore = await git(f.projectPath, ['show', `:${file}`], { raw: true });
  const preview = await f.call('restorePreview', { path: file, hash: first.hash });
  assert.equal(preview.indexWillChange, false);
  assert.equal(preview.current.binary, true);
  const restored = await f.call('restore', { path: file, hash: first.hash, token: preview.token });
  assert.ok(restored.backupId);
  assert.deepEqual(await fs.readFile(path.join(f.projectPath, file)), oldBytes);
  assert.deepEqual(await git(f.projectPath, ['show', `:${file}`], { raw: true }), indexBefore);
  assert.equal(await git(f.projectPath, ['rev-parse', 'HEAD']), first.hash);
  const backups = await f.call('backups');
  assert.ok(backups.backups.some((x) => x.id === restored.backupId && x.canUndo));
  await f.call('undoRestore', { backupId: restored.backupId });
  assert.deepEqual(await fs.readFile(path.join(f.projectPath, file)), workingBytes);
  assert.deepEqual(await git(f.projectPath, ['show', `:${file}`], { raw: true }), stagedBytes);
});

test('restore rejects a stale preview after the file was edited again', async (t) => {
  const f = await fixture(t);
  await f.stage(['User/main.c']);
  const first = await f.commit();
  await f.write('User/main.c', 'int before_preview;\n');
  const preview = await f.call('restorePreview', { path: 'User/main.c', hash: first.hash });
  await f.write('User/main.c', 'int edited_after_preview;\n');
  await assert.rejects(f.call('restore', { path: 'User/main.c', hash: first.hash, token: preview.token }));
  assert.equal(await fs.readFile(path.join(f.projectPath, 'User/main.c'), 'utf8'), 'int edited_after_preview;\n');
});

test('undo refuses to overwrite edits made after a restore', async (t) => {
  const f = await fixture(t);
  await f.stage(['User/main.c']);
  const first = await f.commit();
  await f.write('User/main.c', 'int need_backup;\n');
  const preview = await f.call('restorePreview', { path: 'User/main.c', hash: first.hash });
  const restored = await f.call('restore', { path: 'User/main.c', hash: first.hash, token: preview.token });
  await f.write('User/main.c', 'int keep_this_new_edit;\n');
  await assert.rejects(f.call('undoRestore', { backupId: restored.backupId }));
  assert.equal(await fs.readFile(path.join(f.projectPath, 'User/main.c'), 'utf8'), 'int keep_this_new_edit;\n');
});

test('Keil ignore preview is read-only, preserves custom rules and excludes only generated paths', async (t) => {
  const f = await fixture(t);
  await f.write('.gitignore', '# my existing rule\nlocal-private/\n');
  await f.write('Objects/main.o', Buffer.from([0, 7, 8]));
  await f.write('Listings/main.lst', 'compiler listing');
  await f.write('Project.uvguix.fixture', 'personal layout');
  const original = await fs.readFile(path.join(f.projectPath, '.gitignore'));
  const preview = await f.call('ignorePreview');
  assert.deepEqual(await fs.readFile(path.join(f.projectPath, '.gitignore')), original);
  assert.ok(preview.rules.includes('/Objects/'));
  assert.ok(preview.rules.includes('/Listings/'));
  assert.ok(preview.matchedFiles.some((x) => x === 'Objects/main.o'));
  await f.call('ignoreApply', { rules: preview.rules, token: preview.token });
  const saved = await fs.readFile(path.join(f.projectPath, '.gitignore'), 'utf8');
  assert.ok(saved.startsWith(original.toString()));
  assert.equal(await git(f.projectPath, ['check-ignore', 'Objects/main.o']), 'Objects/main.o');
  assert.equal(await git(f.projectPath, ['check-ignore', 'Listings/main.lst']), 'Listings/main.lst');
  await assert.rejects(git(f.projectPath, ['check-ignore', 'User/main.c']));
  await assert.rejects(git(f.projectPath, ['check-ignore', 'Project.uvprojx']));
  const again = await f.call('ignorePreview');
  await f.call('ignoreApply', { rules: again.rules, token: again.token });
  const repeated = await fs.readFile(path.join(f.projectPath, '.gitignore'), 'utf8');
  assert.equal(repeated.split(/\r?\n/).filter((line) => line === '/Objects/').length, 1);
});

test('ignore rules never hide project root or a directory containing referenced source', async (t) => {
  const f = await fixture(t);
  await f.write('Project.uvprojx', keilXml('.\\User\\', '.\\'));
  const preview = await f.call('ignorePreview');
  assert.ok(!preview.rules.includes('/User/'));
  assert.ok(!preview.rules.includes('/'));
  assert.ok(preview.warnings.length > 0);
});

test('ignore apply rejects rules that were not part of the preview', async (t) => {
  const f = await fixture(t);
  const preview = await f.call('ignorePreview');
  await assert.rejects(f.call('ignoreApply', { rules: [...preview.rules, '/User/'], token: preview.token }));
  const present = await fs.readFile(path.join(f.projectPath, '.gitignore'), 'utf8').catch(() => '');
  assert.ok(!present.includes('/User/'));
});

test('nested project detects parent repository and refuses to initialize a nested .git', async (t) => {
  const f = await fixture(t);
  const child = path.join(f.projectPath, 'User');
  const nested = await f.service.execute('inspect', { projectPath: child });
  assert.ok(nested.parentRepo);
  await assert.rejects(f.service.execute('init', { projectPath: child }));
  await assert.rejects(fs.stat(path.join(child, '.git')));
});

test('operation logs persist between service instances and do not include file contents', async (t) => {
  const f = await fixture(t);
  await f.write('User/main.c', 'SECRET_BODY_DO_NOT_LOG_8791\n');
  await f.stage(['User/main.c']);
  await f.commit('保存测试版本');
  const secondService = new GitService({ dataDir: f.dataDir, seedProjects: [f.projectPath] });
  const logs = await secondService.execute('logs', { projectPath: f.projectPath });
  assert.ok(logs.logs.length >= 2);
  assert.ok(logs.logs.some((x) => x.action === 'commit' && x.success));
  assert.ok(logs.logs.every((x) => x.id && x.date && x.summary));
  assert.ok(!JSON.stringify(logs).includes('SECRET_BODY_DO_NOT_LOG_8791'));
});

test('custom commit hooks are detected without being executed and staged changes are retained', async (t) => {
  const f = await fixture(t);
  await f.stage(['User/main.c']);
  const hookPath = path.join(f.projectPath, '.git/hooks/pre-commit');
  await fs.writeFile(hookPath, '#!/bin/sh\necho HOOK_RAN > hook-ran.txt\n');
  await fs.chmod(hookPath, 0o755);
  await assert.rejects(f.commit('should not run custom hooks'));
  await assert.rejects(fs.stat(path.join(f.projectPath, 'hook-ran.txt')));
  assert.equal(await git(f.projectPath, ['ls-files']), 'User/main.c');
  assert.deepEqual((await f.call('history')).commits, []);
});

test('diff preview does not run custom textconv commands', async (t) => {
  const f = await fixture(t);
  await f.write('.gitattributes', 'User/main.c diff=fixture\n');
  await f.stage(['User/main.c', '.gitattributes']);
  await f.commit();
  const scriptPath = path.join(f.projectPath, '.git/textconv.sh');
  await fs.writeFile(scriptPath, '#!/bin/sh\necho TEXTCONV_RAN > textconv-ran.txt\ncat "$1"\n');
  await fs.chmod(scriptPath, 0o755);
  await git(f.projectPath, ['config', 'diff.fixture.textconv', 'sh .git/textconv.sh']);
  await f.write('User/main.c', 'int changed_safely;\n');
  const diff = await f.call('diff', { path: 'User/main.c', mode: 'working' });
  assert.match(diff.text, /changed_safely/);
  await assert.rejects(fs.stat(path.join(f.projectPath, 'textconv-ran.txt')));
});

test('text preview decodes UTF-16 and legacy Chinese without modifying file bytes', async (t) => {
  const f = await fixture(t);
  const utf16Bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('// 中文注释\r\n', 'utf16le')]);
  await f.write('User/utf16.c', utf16Bytes);
  const utf16 = await f.call('readFile', { path: 'User/utf16.c', source: 'working' });
  assert.equal(utf16.binary, false);
  assert.match(utf16.text, /中文注释/);
  assert.deepEqual(await fs.readFile(path.join(f.projectPath, 'User/utf16.c')), utf16Bytes);
  const gbkBytes = Buffer.from([0x2f, 0x2f, 0x20, 0xd6, 0xd0, 0xce, 0xc4, 0x0d, 0x0a]);
  await f.write('User/gbk.c', gbkBytes);
  const gbk = await f.call('readFile', { path: 'User/gbk.c', source: 'working' });
  assert.equal(gbk.binary, false);
  assert.match(gbk.text, /中文/);
  assert.deepEqual(await fs.readFile(path.join(f.projectPath, 'User/gbk.c')), gbkBytes);
});

test('restoring a deleted file can be undone back to its absent state', async (t) => {
  const f = await fixture(t);
  await f.stage(['User/main.c']);
  const first = await f.commit();
  await fs.unlink(path.join(f.projectPath, 'User/main.c'));
  const preview = await f.call('restorePreview', { path: 'User/main.c', hash: first.hash });
  const restored = await f.call('restore', { path: 'User/main.c', hash: first.hash, token: preview.token });
  assert.match(await fs.readFile(path.join(f.projectPath, 'User/main.c'), 'utf8'), /return 0/);
  await f.call('undoRestore', { backupId: restored.backupId });
  await assert.rejects(fs.stat(path.join(f.projectPath, 'User/main.c')));
  assert.equal(await git(f.projectPath, ['show', ':User/main.c']), 'int main(void) { return 0; }');
});

test('undo rechecks files changed by another editor while the safety backup is being made', async (t) => {
  const f = await fixture(t);
  await f.stage(['User/main.c']);
  const first = await f.commit();
  await f.write('User/main.c', 'int before_restore;\n');
  const preview = await f.call('restorePreview', { path: 'User/main.c', hash: first.hash });
  const restored = await f.call('restore', { path: 'User/main.c', hash: first.hash, token: preview.token });
  const originalBackup = f.service.makeBackup.bind(f.service);
  f.service.makeBackup = async (...args) => {
    const backup = await originalBackup(...args);
    if (args[2] === 'undoRestore') await f.write('User/main.c', 'int external_edit_during_backup;\n');
    return backup;
  };
  await assert.rejects(f.call('undoRestore', { backupId: restored.backupId }));
  assert.equal(await fs.readFile(path.join(f.projectPath, 'User/main.c'), 'utf8'), 'int external_edit_during_backup;\n');
});

test('a post-restore external index change leaves an actionable worktree backup', async (t) => {
  const f = await fixture(t);
  await f.stage(['User/main.c']);
  const first = await f.commit();
  await f.write('User/main.c', 'int before_restore;\n');
  const preview = await f.call('restorePreview', { path: 'User/main.c', hash: first.hash });
  const originalGit = f.service.git.bind(f.service);
  f.service.git = async (root, args, options) => {
    const result = await originalGit(root, args, options);
    if (args[0] === 'restore' && args.includes('--worktree')) {
      await f.write('User/external.c', 'int staged_by_another_client;\n');
      await git(f.projectPath, ['add', '--', 'User/external.c']);
    }
    return result;
  };
  await assert.rejects(f.call('restore', { path: 'User/main.c', hash: first.hash, token: preview.token }));
  const backups = await f.call('backups');
  const candidate = backups.backups.find((x) => x.reason === 'restore');
  assert.ok(candidate?.canUndo, 'backup remains usable after a post-write error');
  await f.call('undoRestore', { backupId: candidate.id });
  assert.equal(await fs.readFile(path.join(f.projectPath, 'User/main.c'), 'utf8'), 'int before_restore;\n');
  assert.match(await git(f.projectPath, ['ls-files']), /User\/external\.c/);
});

test('a log storage failure is not reported as a failed commit after Git succeeded', async (t) => {
  const f = await fixture(t);
  await f.stage(['User/main.c']);
  f.service.log = async () => { throw Object.assign(new Error('simulated log storage failure'), { code: 'EIO' }); };
  const committed = await f.commit('提交已成功，日志写入故障');
  assert.equal(committed.hash, await git(f.projectPath, ['rev-parse', 'HEAD']));
});
