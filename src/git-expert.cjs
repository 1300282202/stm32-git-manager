'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { constants } = require('node:fs');
const { error, digest, keyFor, samePath, within, exists, shaFile, atomicJson, jsonRead } = require('./git-utils.cjs');

const READ = ['expertOverview', 'expertCatalog', 'expertHelp', 'expertReflog', 'expertPreview', 'expertBackups', 'expertBisectStatus', 'expertDiagnose'];
const WRITE = ['expertExecute', 'expertRescue', 'expertBackupExport', 'expertBisectStart', 'expertBisectMark', 'expertBisectStop', 'expertBisectWorktree', 'expertBundleExport', 'expertBundleVerify'];
const C_ACTIONS = [...READ, ...WRITE];
const MAX_BYTES = 256 * 1024 * 1024, MAX_FILES = 12000;
const STATUS = {
  reset: ['重置向导', 'soft / mixed / hard；先完整备份磁盘文件、索引并建立救援分支'],
  clean: ['清理向导', '逐个选择未跟踪文件，可选忽略文件；先备份，保留空目录'],
  reflog: ['引用找回', '查看本地引用变动，从现存提交创建救援分支'],
  bisect: ['二分排错', '不切换当前工作区；在独立目录测试候选版本后手工标记'],
  fsck: ['仓库诊断', '只读完整性检查，不修复或删除对象'],
  'count-objects': ['仓库诊断', '只读对象占用统计'],
  bundle: ['离线历史包', '导出全部引用的历史并验证；不包含未提交文件'],
  commit: ['版本历史 / 历史向导', '基础提交；C 新增未共享末次提交的说明修改'],
  revert: ['历史向导', '反向提交，保留原历史；支持冲突继续和中止'],
};
const BASE = new Set(['add', 'archive', 'branch', 'cherry-pick', 'clone', 'config', 'diff', 'fetch', 'init', 'log', 'merge', 'push', 'remote', 'restore', 'show', 'stash', 'status', 'switch', 'tag', 'worktree']);
const SHORT_HELP = new Set([...Object.keys(STATUS), 'rebase', 'submodule', 'sparse-checkout', 'notes', 'cat-file', 'maintenance', 'verify-commit', 'verify-tag']);
function textResult(result) { return (result.stdout.toString('utf8') + '\n' + result.stderr).trim().slice(0, 100000); }
function backupId(value) { if (typeof value !== 'string' || !/^\d+-[a-f0-9-]+$/.test(value)) throw error('备份编号无效。'); return value; }
function message(value) { if (typeof value !== 'string' || !value.trim() || value.length > 10000 || value.includes('\0')) throw error('请填写不超过 10000 字的提交说明。'); return value.trim(); }

const METHODS = {
  async cInventory(root) {
    const files = []; let bytes = 0, entries = 0;
    const visit = async (dir, depth) => {
      if (depth > 40) throw error('目录层级过深，已停止备份。');
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (++entries > MAX_FILES) throw error('C 首版仅处理 12000 个目录项以内的工作区。');
        if (entry.name.toLowerCase() === '.git') { if (samePath(dir, root)) continue; throw error('工作区含嵌套仓库或子模块，暂不执行整版写入。'); }
        const full = path.join(dir, entry.name), relative = path.relative(root, full).replace(/\\/g, '/');
        await this.safePath(root, relative, { allowMissing: false });
        if (entry.isSymbolicLink()) throw error('工作区包含链接，C 首版不执行整版写入。');
        if (entry.isDirectory()) await visit(full, depth + 1);
        else if (entry.isFile()) {
          const stat = await fs.stat(full); bytes += stat.size;
          if (bytes > MAX_BYTES) throw error('工作区超过 256 MB 的完整备份上限，请先使用外部备份方案。');
          files.push({ path: relative, bytes: stat.size, hash: await shaFile(full) });
        } else throw error('工作区含特殊文件，已停止。');
      }
    };
    await visit(root, 0); files.sort((a, b) => a.path.localeCompare(b.path));
    return { files, bytes, fingerprint: digest(JSON.stringify(files)) };
  },
  async cSnapshot(root, reason, state, inventory, { rescue = true } = {}) {
    const base = path.join(this.dataDir, 'expert-backups', keyFor(root));
    if (within(root, base)) throw error('应用备份目录位于工程内部，无法创建独立备份。');
    const id = Date.now() + '-' + crypto.randomUUID(), dir = path.join(base, id);
    await fs.mkdir(path.join(dir, 'files'), { recursive: true });
    for (const item of inventory.files) {
      const source = await this.safePath(root, item.path, { allowMissing: false });
      const target = path.join(dir, 'files', item.path); await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(source.absolute, target, constants.COPYFILE_EXCL);
      if (await shaFile(target) !== item.hash) throw error('完整备份校验失败，写操作已停止。', 'BACKUP_FAILED');
    }
    const index = await this.indexFingerprint(root);
    if (index.hash) { await fs.copyFile(index.path, path.join(dir, 'index.bin')); if (await shaFile(path.join(dir, 'index.bin')) !== index.hash) throw error('索引备份校验失败。'); }
    if ((await this.cInventory(root)).fingerprint !== inventory.fingerprint || (await this.state({ projectPath: root })).token !== state.token) throw error('工程在备份过程中改变，已停止写入。', 'STALE_PREVIEW');
    const rescueBranch = rescue && state.head ? 'rescue/c-' + id : null;
    const record = { id, projectPath: root, reason, date: new Date().toISOString(), head: state.head, branch: state.branch, indexHash: index.hash, rescueBranch, files: inventory.files, bytes: inventory.bytes, phase: 'prepared' };
    await atomicJson(path.join(dir, 'manifest.json'), record);
    if (rescueBranch) await this.git(root, ['branch', '--', rescueBranch, state.head]);
    return record;
  },
  async cFinishSnapshot(root, record, phase) {
    record.phase = phase;
    await atomicJson(path.join(this.dataDir, 'expert-backups', keyFor(root), record.id, 'manifest.json'), record);
  },
  async expertOverview({ projectPath: root }) {
    const state = await this.state({ projectPath: root });
    const commits = state.head ? (await this.history({ projectPath: root, limit: 100 })).commits : [];
    return { commits, branch: state.branch, head: state.head, bisect: await this.expertBisectStatus({ projectPath: root }), release: 'C1 · 专家功能起步版' };
  },
  async expertCatalog() {
    const result = await this.git(null, ['help', '-a']); let group = '', kind = 'command'; const items = [];
    for (const line of result.stdout.toString('utf8').split(/\r?\n/)) {
      const match = /^\s{3}([a-z0-9][a-z0-9-]*)(?:\s{2,}(.+))?$/.exec(line);
      if (match) {
        const name = match[1], integrated = STATUS[name], base = BASE.has(name);
        items.push({ name, group, kind, description: match[2] || '本机已安装的外部条目', status: integrated ? '部分能力可用' : base ? 'A/B 已有部分能力' : '目录与帮助', entry: integrated?.[0] || (base ? '现有功能页面' : '待后续执行适配'), scope: integrated?.[1] || (base ? '具体支持范围见 A/B 使用说明；不代表全部参数已覆盖' : '本次仅提供分类、简述与帮助入口，不执行该命令'), risk: kind === 'external' ? '外部组件；不自动执行' : kind === 'document' ? '只读文档' : integrated ? '按具体向导预览影响' : '执行能力尚未适配', dependency: kind === 'external' ? '本机 help -a 中已列出；运行依赖及版本未验证' : kind === 'document' ? '浏览官方帮助需联网' : '本机 Git', shortHelp: kind === 'command' && SHORT_HELP.has(name) });
      } else if (line && !/^\s/.test(line) && !line.startsWith('See ')) {
        group = line; kind = /External commands/.test(line) ? 'external' : /interfaces|formats/.test(line) ? 'document' : 'command';
      }
    }
    return { items, version: (await this.git(null, ['--version'])).stdout.toString().trim() };
  },
  async expertHelp({ command }) {
    const item = (await this.expertCatalog()).items.find(item => item.name === command);
    if (!item) throw error('请选择本机命令目录中的条目。');
    const text = item.shortHelp ? textResult(await this.git(null, [command, '-h'], { allowFailure: true, timeout: 10000 })) : item.description + '\n\n' + item.scope;
    return { ...item, text };
  },
  async expertReflog({ projectPath: root }) {
    await this.assertRepo(root);
    const result = await this.git(root, ['reflog', 'show', '--all', '--date=iso-strict', '--format=%H%x00%gD%x00%gs', '-150']);
    return { items: result.stdout.toString('utf8').trim().split('\n').filter(Boolean).map(line => { const [hash, ref, subject] = line.split('\0'); return { hash, ref, subject }; }) };
  },
  async expertRescue({ projectPath: root, hash, name, token }) {
    await this.bReady(root, { token }); const revision = await this.validateHash(root, hash); await this.bBranchName(root, name);
    if (!name.startsWith('rescue/')) throw error('救援分支名称请以 rescue/ 开头。');
    await this.git(root, ['branch', '--', name, revision]);
    return { state: await this.state({ projectPath: root }), rescueBranch: name };
  },
  async cCleanCandidates(root, includeIgnored) {
    const normal = await this.git(root, ['ls-files', '--others', '--exclude-standard', '-z']);
    const ignored = includeIgnored ? await this.git(root, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z']) : { stdout: Buffer.alloc(0) };
    const ignoredNames = new Set(ignored.stdout.toString('utf8').split('\0').filter(Boolean));
    const names = [...new Set([...normal.stdout.toString('utf8').split('\0'), ...ignoredNames])].filter(Boolean), items = [];
    for (const name of names) {
      const relative = name.replace(/\/$/, ''), safe = await this.safePath(root, relative);
      const stat = await fs.lstat(safe.absolute);
      if (!stat.isFile()) throw error('未跟踪内容含目录仓库、链接或特殊文件，暂不执行清理。');
      items.push({ path: relative, bytes: stat.size, hash: await shaFile(safe.absolute), ignored: ignoredNames.has(name) });
    }
    return items;
  },
  async expertPreview({ projectPath: root, kind, target, mode = 'mixed', includeIgnored = false, message: newMessage }) {
    const state = await this.bReady(root, {});
    if (!['reset', 'clean', 'amend', 'revert'].includes(kind)) throw error('请选择受支持的历史或清理向导。');
    if (state.branch === '分离的 HEAD') throw error('请先切换到本地分支。');
    const inventory = await this.cInventory(root); let revision = null, candidates = [], shared = '', explanation = '', commitMessage = null;
    if (kind === 'reset') {
      if (!['soft', 'mixed', 'hard'].includes(mode)) throw error('重置模式无效。');
      revision = await this.validateHash(root, target); await this.bSafeTree(root, revision);
      explanation = { soft: '移动当前分支；暂存区和磁盘文件保持原样。', mixed: '移动当前分支并重建暂存区；磁盘文件保持原样，原暂存选择会改变。', hard: '移动当前分支，重建暂存区并覆盖磁盘中的已跟踪文件；阻挡目标路径的未跟踪文件也可能被移除。' }[mode];
    } else if (kind === 'clean') {
      candidates = await this.cCleanCandidates(root, Boolean(includeIgnored));
      explanation = '只删除你勾选的未跟踪普通文件。勾选包含忽略文件时会列出编译输出；先备份，保留空目录。';
    } else {
      if (state.files.length) throw error('请先保存或收起当前修改，再执行提交操作。');
      await this.bSigned(root);
      if (!state.identity.name || !state.identity.email) throw error('请先设置本工程提交作者。');
      if (kind === 'amend') { revision = state.head; commitMessage = message(newMessage); explanation = '修改末次提交说明，不带入文件变化；原提交保留在救援分支。'; }
      else {
        revision = await this.validateHash(root, target);
        const parents = (await this.git(root, ['rev-list', '--parents', '-1', revision])).stdout.toString().trim().split(/\s+/);
        if (parents.length !== 2) throw error('C 首版仅反向撤销有一个父版本的普通提交。');
        await this.bSafeTree(root, state.head); explanation = '创建一个反向提交，保留已有历史；遇到冲突后到“分支与草稿”处理。';
      }
    }
    if (kind === 'amend' || kind === 'reset') {
      shared = (await this.git(root, ['for-each-ref', '--contains=' + state.head, '--format=%(refname:short)', 'refs/remotes'])).stdout.toString('utf8').trim();
      if (kind === 'amend' && shared) throw error('末次提交已出现在远程跟踪历史中，C 首版不改写已共享提交，请新建后续版本。');
    }
    const token = crypto.randomUUID(), confirmText = kind === 'clean' ? '清理' : state.branch;
    this.previews.set(token, { type: 'expert', root, kind, revision, mode, stateToken: state.token, inventory, candidates, commitMessage, confirmText, expires: Date.now() + 10 * 60000 });
    return { token, kind, revision, mode, branch: state.branch, head: state.head, explanation, shared, candidates, bytes: inventory.bytes, files: inventory.files.length, confirmText, commitMessage };
  },
  async expertExecute({ projectPath: root, previewToken, confirmation, paths }) {
    const preview = this.previews.get(previewToken);
    if (!preview || preview.type !== 'expert' || !samePath(preview.root, root) || preview.expires < Date.now()) throw error('预览已失效，请重新预览。', 'STALE_PREVIEW');
    if (confirmation !== preview.confirmText) throw error('请输入预览中要求的确认文字。');
    const state = await this.bReady(root, { token: preview.stateToken });
    if ((await this.cInventory(root)).fingerprint !== preview.inventory.fingerprint) throw error('磁盘文件在预览后改变，已停止。', 'STALE_PREVIEW');
    let selected = [];
    if (preview.kind === 'clean') {
      if (!Array.isArray(paths) || !paths.length || paths.length > MAX_FILES) throw error('请至少勾选一个文件。');
      const known = new Map(preview.candidates.map(item => [item.path, item]));
      if (paths.some(name => !known.has(name))) throw error('只能清理本次预览列出的文件。');
      selected = [...new Set(paths)].map(name => known.get(name));
    }
    // Recheck remote publication after preview; a fetch can change it without changing the worktree token.
    if (preview.kind === 'amend' && (await this.git(root, ['for-each-ref', '--contains=' + state.head, '--format=%(refname)', 'refs/remotes'])).stdout.length) throw error('预览后该提交已出现在远程历史中，停止修改。');
    const record = await this.cSnapshot(root, preview.kind, state, preview.inventory);
    this.previews.delete(previewToken);
    try {
      if (preview.kind === 'reset') await this.git(root, ['reset', '--' + preview.mode, preview.revision]);
      else if (preview.kind === 'amend') await this.git(root, ['-c', 'commit.gpgsign=false', 'commit', '--amend', '--only', '--file=-'], { input: Buffer.from(preview.commitMessage), timeout: 60000 });
      else if (preview.kind === 'revert') {
        const result = await this.git(root, ['-c', 'commit.gpgsign=false', 'revert', '--no-edit', preview.revision], { allowFailure: true, timeout: 60000 });
        if (result.code && (await this.operation(root)) !== '撤销提交') throw error(textResult(result));
      } else {
        for (const item of selected) {
          const safe = await this.safePath(root, item.path, { allowMissing: false });
          if (await shaFile(safe.absolute) !== item.hash) throw error('清理期间文件已变化，已停止；已清理内容可从备份导出。');
          await fs.unlink(safe.absolute);
        }
      }
      await this.cFinishSnapshot(root, record, 'completed');
    } catch (e) { await this.cFinishSnapshot(root, record, 'failed-or-partial').catch(() => {}); throw error(`操作未完成或仅部分完成。备份 ${record.id}，救援分支 ${record.rescueBranch}。\n${e.message}`, e.code || 'EXPERT_FAILED'); }
    const after = await this.state({ projectPath: root });
    return { state: after, backupId: record.id, rescueBranch: record.rescueBranch, conflicted: Boolean(after.operation) };
  },
  async expertBackups({ projectPath: root }) {
    const base = path.join(this.dataDir, 'expert-backups', keyFor(root)); let dirs = [];
    try { dirs = await fs.readdir(base, { withFileTypes: true }); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const items = [];
    for (const entry of dirs) if (entry.isDirectory() && !entry.isSymbolicLink()) {
      const record = await jsonRead(path.join(base, entry.name, 'manifest.json'), null).catch(() => null);
      if (record && samePath(record.projectPath, root)) items.push({ id: record.id, date: record.date, reason: record.reason, head: record.head, rescueBranch: record.rescueBranch, bytes: record.bytes, files: record.files.length, phase: record.phase });
    }
    return { items: items.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 100) };
  },
  async cEmptyDestination(root, destination) {
    if (typeof destination !== 'string' || !path.isAbsolute(destination)) throw error('请选择工程之外的普通空文件夹。');
    if ((await fs.lstat(destination)).isSymbolicLink()) throw error('目标不能是目录链接。');
    const real = await fs.realpath(destination);
    if (within(root, real) || within(real, root) || within(this.dataDir, real) || !(await fs.stat(real)).isDirectory() || (await fs.readdir(real)).length) throw error('请选择与工程及应用数据分开的普通空文件夹。');
    return real;
  },
  async expertBackupExport({ projectPath: root, id, destination }) {
    const dir = path.join(this.dataDir, 'expert-backups', keyFor(root), backupId(id));
    const record = await jsonRead(path.join(dir, 'manifest.json'), null);
    if (!record || !samePath(record.projectPath, root) || !Array.isArray(record.files)) throw error('备份记录无效。');
    const target = await this.cEmptyDestination(root, destination);
    // Validate every entry and checksum before copying anything into the destination.
    for (const item of record.files) {
      if ((await fs.lstat(dir)).isSymbolicLink() || (await fs.lstat(path.join(dir, 'files'))).isSymbolicLink()) throw error('备份目录不能是链接。');
      await this.safePath(path.join(dir, 'files'), item.path, { allowMissing: false });
      const source = path.resolve(dir, 'files', item.path);
      if (!within(path.join(dir, 'files'), source) || await shaFile(source) !== item.hash) throw error('备份文件校验失败，已停止导出。');
    }
    for (const item of record.files) {
      const out = path.join(target, item.path); await fs.mkdir(path.dirname(out), { recursive: true });
      await fs.copyFile(path.join(dir, 'files', item.path), out, constants.COPYFILE_EXCL);
    }
    return { destination: target, files: record.files.length, state: await this.state({ projectPath: root }) };
  },
  async expertDiagnose({ projectPath: root }) {
    await this.assertRepo(root);
    const count = await this.git(root, ['count-objects', '-vH']);
    const check = await this.git(root, ['fsck', '--full', '--no-dangling', '--no-progress'], { allowFailure: true, timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
    return { passed: check.code === 0, exitCode: check.code, statistics: textResult(count), output: textResult(check) || 'Git 完整性检查未报告错误。', scope: '检查本地 Git 对象及引用；不验证源码逻辑、外部依赖、编译或硬件。未删除或修复对象。' };
  },
  async cBisectRecord(root) { return jsonRead(path.join(this.dataDir, 'expert-bisect', keyFor(root) + '.json'), null); },
  async expertBisectStatus({ projectPath: root }) {
    await this.assertRepo(root);
    if ((await this.operation(root)) !== '二分排错') return { active: false };
    const record = await this.cBisectRecord(root), log = await this.git(root, ['bisect', 'log']);
    const candidate = await this.git(root, ['rev-parse', '--verify', 'BISECT_HEAD^{commit}'], { allowFailure: true });
    const output = log.stdout.toString('utf8'), found = /# first (?:'bad'|bad) commit: \[([a-f0-9]+)\]/.exec(output);
    const info = await this.repoInfo(root);
    const managed = Boolean(record && samePath(record.projectPath, root) && record.noCheckout && record.logPrefix && output.startsWith(record.logPrefix) && !candidate.code && info.head === record.head && info.branch === record.branch);
    return { active: true, managed, candidate: candidate.code ? null : candidate.stdout.toString().trim(), found: found?.[1] || null, ambiguous: /only.*skip|could be any/i.test(record?.lastOutput || ''), lastOutput: record?.lastOutput || '', log: output, originalBranch: record?.branch, logToken: digest(output) };
  },
  async expertBisectStart({ projectPath: root, good, bad, token }) {
    const state = await this.bReady(root, { token, clean: true });
    if (state.branch === '分离的 HEAD') throw error('请先切换到本地分支。');
    const goodHash = await this.validateHash(root, good), badHash = await this.validateHash(root, bad);
    const ancestor = await this.git(root, ['merge-base', '--is-ancestor', goodHash, badHash], { allowFailure: true });
    if (goodHash === badHash || ancestor.code) throw error('正常版本必须是异常版本之前的祖先提交。');
    const file = path.join(this.dataDir, 'expert-bisect', keyFor(root) + '.json');
    await atomicJson(file, { projectPath: root, head: state.head, branch: state.branch, noCheckout: true });
    try {
      await this.git(root, ['bisect', 'start', '--no-checkout', badHash, goodHash], { timeout: 60000 });
      const logPrefix = (await this.git(root, ['bisect', 'log'])).stdout.toString('utf8');
      await atomicJson(file, { projectPath: root, head: state.head, branch: state.branch, noCheckout: true, logPrefix });
    } catch (e) { await this.git(root, ['bisect', 'reset'], { allowFailure: true }).catch(() => {}); await fs.unlink(file).catch(() => {}); throw e; }
    return { state: await this.state({ projectPath: root }), bisect: await this.expertBisectStatus({ projectPath: root }) };
  },
  async cManagedBisect(root, token, candidate, logToken, clean = true) {
    await this.bReady(root, { token, clean, operation: true });
    const status = await this.expertBisectStatus({ projectPath: root });
    if (!status.active || !status.managed) throw error('这不是本工具启动的二分排错，请在原工具中处理。');
    if (candidate && (candidate !== status.candidate || logToken !== status.logToken)) throw error('候选版本已变化，请刷新后重新测试。', 'STALE_PREVIEW');
    return status;
  },
  async expertBisectMark({ projectPath: root, verdict, candidate, logToken, token }) {
    const status = await this.cManagedBisect(root, token, candidate, logToken);
    if (status.found) throw error('已经找到首个异常提交，请先查看结果或结束排错。');
    if (!candidate || !['good', 'bad', 'skip'].includes(verdict)) throw error('请选择正常、异常或无法测试。');
    const result = await this.git(root, ['bisect', verdict, candidate], { allowFailure: true, timeout: 60000 });
    const record = await this.cBisectRecord(root); record.lastOutput = textResult(result);
    await atomicJson(path.join(this.dataDir, 'expert-bisect', keyFor(root) + '.json'), record);
    const after = await this.expertBisectStatus({ projectPath: root });
    if (result.code && !/only.*skip|could be any|first bad commit/i.test(textResult(result))) throw error(textResult(result));
    return { state: await this.state({ projectPath: root }), bisect: after, output: textResult(result) };
  },
  async expertBisectStop({ projectPath: root, token }) {
    await this.cManagedBisect(root, token, null, null, false);
    await this.git(root, ['bisect', 'reset']);
    await fs.unlink(path.join(this.dataDir, 'expert-bisect', keyFor(root) + '.json')).catch(() => {});
    return { state: await this.state({ projectPath: root }) };
  },
  async expertBisectWorktree({ projectPath: root, candidate, logToken, destination, token }) {
    const status = await this.cManagedBisect(root, token, candidate, logToken);
    if (status.found || !candidate) throw error('当前没有待测试的候选版本。');
    await this.bSafeTree(root, candidate); const target = await this.cEmptyDestination(root, destination);
    await this.git(root, ['worktree', 'add', '--detach', '--', target, candidate], { timeout: 120000 });
    return { destination: target, state: await this.state({ projectPath: root }) };
  },
  async cExportFile(root, destination, suffix, writer) {
    if (typeof destination !== 'string' || !path.isAbsolute(destination) || !destination.toLowerCase().endsWith(suffix) || /[:<>"|?*\0]/.test(path.basename(destination))) throw error('请选择正确的导出文件名。');
    const parent = await fs.realpath(path.dirname(destination)), target = path.join(parent, path.basename(destination));
    if (within(root, target)) throw error('请选择工程之外的导出位置。');
    if (await exists(target)) throw error('文件已存在，请选择新文件名。');
    const temp = path.join(parent, '.stm32-c-' + crypto.randomUUID() + suffix);
    await fs.writeFile(temp, Buffer.alloc(0), { flag: 'wx' });
    try { await writer(temp); await fs.copyFile(temp, target, constants.COPYFILE_EXCL); return { filePath: target, bytes: (await fs.stat(target)).size, sha256: await shaFile(target) }; }
    finally { await fs.unlink(temp).catch(() => {}); }
  },
  async expertBundleExport({ projectPath: root, destination, token }) {
    const state = await this.bReady(root, { token });
    const result = await this.cExportFile(root, destination, '.bundle', async temp => {
      await this.git(root, ['bundle', 'create', temp, '--all'], { timeout: 120000 });
      await this.git(root, ['bundle', 'verify', temp], { timeout: 120000 });
    });
    return { ...result, state: await this.state({ projectPath: root }), includes: '所有本地引用可达的历史，含远程跟踪、草稿及救援引用；不含未提交文件、忽略文件或外部依赖。', sourceHead: state.head };
  },
  async expertBundleVerify({ projectPath: root, filePath }) {
    await this.assertRepo(root);
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || !filePath.toLowerCase().endsWith('.bundle') || !(await fs.lstat(filePath)).isFile()) throw error('请选择普通 .bundle 文件。');
    const result = await this.git(root, ['bundle', 'verify', filePath], { allowFailure: true, timeout: 120000 });
    return { valid: result.code === 0, output: textResult(result), sha256: await shaFile(filePath) };
  },
};

function installExpert(GitService, sets) {
  for (const name of READ) sets.ACTIONS.add(name);
  for (const name of WRITE) { sets.ACTIONS.add(name); sets.WRITES.add(name); }
  Object.assign(GitService.prototype, METHODS);
}
module.exports = { C_ACTIONS, installExpert };
