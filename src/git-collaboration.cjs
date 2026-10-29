'use strict';
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { error, keyFor, within, samePath, exists, atomicJson, jsonRead, displayBuffer, LIMIT } = require('./git-utils.cjs');

const READ = ['branches', 'mergePreview', 'conflicts', 'conflictFile', 'stashes', 'tags', 'worktrees', 'remotes', 'syncPreview'];
const WRITE = ['branchCreate', 'branchSwitch', 'branchRename', 'branchDelete', 'merge', 'resolveConflict', 'continueOperation', 'abortOperation', 'stashCreate', 'stashApply', 'stashDrop', 'stashRecover', 'cherryPick', 'tagCreate', 'tagDelete', 'worktreeAdd', 'worktreeRemove', 'remoteSave', 'remoteRemove', 'fetch', 'pull', 'push', 'exportArchive'];
const ACTIONS = [...READ, ...WRITE];
const labels = {
  branchCreate: '创建分支', branchSwitch: '切换分支', branchRename: '重命名分支', branchDelete: '删除已合并分支',
  merge: '合并分支', resolveConflict: '解决文件冲突', continueOperation: '完成合并或提交移植', abortOperation: '中止进行中的操作',
  stashCreate: '收起临时草稿', stashApply: '恢复临时草稿', stashDrop: '归档并移除草稿', stashRecover: '找回归档草稿',
  cherryPick: '移植历史提交', tagCreate: '创建版本标签', tagDelete: '删除本地标签', worktreeAdd: '创建独立工作目录',
  worktreeRemove: '移除干净工作目录', remoteSave: '设置远程地址', remoteRemove: '移除远程地址', fetch: '获取远程历史',
  pull: '快进更新当前分支', push: '上传已提交版本', exportArchive: '导出源码快照',
};

const METHODS = {
  async bReady(root, { token, clean = false, operation = false, conflicts = false, head = true } = {}) {
    const state = token ? await this.checkToken(root, token) : await this.state({ projectPath: root });
    if (!state.isRepo || state.parentRepo || state.bare) throw error('请打开普通 Git 仓库的根目录。');
    if (head && !state.head) throw error('请先保存工程的第一个版本。', 'NO_COMMITS');
    if (state.operation && !operation) throw error('工程正在进行' + state.operation + '，请先完成或中止。', 'OPERATION_IN_PROGRESS');
    if (state.files.some(file => file.conflict) && !conflicts) throw error('请先解决当前文件冲突。', 'CONFLICT');
    if (clean && state.files.length) throw error('工程有未提交的文件变化。请先保存版本、收起草稿或处理未跟踪文件。', 'DIRTY_WORKTREE');
    for (const file of state.files) {
      const safe = await this.safePath(root, file.path);
      if (await exists(safe.absolute)) {
        const stat = await fs.lstat(safe.absolute);
        if (!stat.isFile()) throw error('试用版不处理符号链接、子模块或目录形式的变更。', 'UNSUPPORTED_TREE');
      }
    }
    await this.ensureNoHooks(root);
    const custom = await this.git(root, ['config', '--get-regexp', '^merge\\..*\\.driver$'], { allowFailure: true });
    if (!custom.code && custom.stdout.length) throw error('检测到自定义合并驱动。试用版暂不执行这些外部脚本，请使用原 Git 客户端。', 'UNSUPPORTED_DRIVER');
    return state;
  },
  async bBranchName(root, name) {
    if (typeof name !== 'string' || !name || name.length > 200 || name.startsWith('-') || name.includes('@{') || /[\r\n\0]/.test(name)) throw error('分支名称无效。');
    const result = await this.git(root, ['check-ref-format', '--branch', name], { allowFailure: true });
    if (result.code) throw error('分支名称不能含空格、连续点或 Git 保留字符。');
    return name;
  },
  async bRefs(root) {
    const result = await this.git(root, ['for-each-ref', '--format=%(refname)%00%(refname:short)%00%(objectname)%00%(HEAD)%00%(upstream:short)%00%(upstream:track)', 'refs/heads', 'refs/remotes']);
    return result.stdout.toString('utf8').trim().split('\n').filter(Boolean).map(line => {
      const [ref, name, hash, current, upstream, tracking] = line.split('\0');
      return { ref, name, hash, current: current === '*', upstream, tracking, remote: ref.startsWith('refs/remotes/') };
    }).filter(item => !item.name.endsWith('/HEAD'));
  },
  async bRef(root, ref, expectedHash) {
    const found = (await this.bRefs(root)).find(item => item.ref === ref || (!item.remote && item.name === ref));
    if (!found) throw error('所选分支已不存在，请刷新。', 'STALE_REF');
    if (expectedHash && found.hash !== expectedHash) throw error('所选分支已更新，请刷新后重新确认。', 'STALE_REF');
    return found;
  },
  async bSafeTree(root, hash) {
    const tree = await this.git(root, ['ls-tree', '-r', '-z', hash]);
    const names = [];
    for (const line of tree.stdout.toString('utf8').split('\0').filter(Boolean)) {
      const match = line.match(/^(\d+) (\w+) [a-f0-9]+\t([\s\S]+)$/);
      if (!match || !/^100[0-7]{3}$/.test(match[1]) || match[2] !== 'blob') throw error('目标版本含符号链接或子模块，试用版暂不切换这类工程。', 'UNSUPPORTED_TREE');
      await this.safePath(root, match[3]); names.push(match[3]);
    }
    await this.ensureSafeFilters(root, names, hash);
    return names;
  },
  async bSigned(root) {
    if (await this.rawConfig(root, 'commit.gpgsign') === 'true') throw error('当前工程要求提交签名，请使用支持签名的 Git 客户端完成本次操作。', 'UNSUPPORTED_SIGNING');
  },
  async bBackups(root, state, reason) {
    const records = [];
    for (const file of state.files) records.push(await this.makeBackup(root, file.path, reason));
    return records;
  },
  async bFinish(root, records) { for (const record of records) await this.finishBackup(root, record.id); },
  async branches({ projectPath: root }) {
    const info = await this.assertRepo(root);
    const refs = await this.bRefs(root);
    const graph = info.head ? (await this.git(root, ['log', '--graph', '--decorate', '--oneline', '--all', '-60'])).stdout.toString('utf8') : '';
    return { current: info.branch, local: refs.filter(item => !item.remote), remote: refs.filter(item => item.remote), graph };
  },
  async branchCreate({ projectPath: root, name, switchTo = false, token }) {
    await this.bReady(root, { token, clean: Boolean(switchTo) }); await this.bBranchName(root, name);
    await this.git(root, switchTo ? ['switch', '-c', name] : ['branch', '--', name]);
    return this.state({ projectPath: root });
  },
  async branchSwitch({ projectPath: root, name, expectedHash, token }) {
    await this.bReady(root, { token, clean: true });
    const ref = await this.bRef(root, name, expectedHash);
    if (ref.remote) throw error('请先从远程分支创建本地分支，再切换。');
    await this.bSafeTree(root, ref.hash); await this.git(root, ['switch', '--', ref.name]);
    return this.state({ projectPath: root });
  },
  async branchRename({ projectPath: root, name, newName, token }) {
    await this.bReady(root, { token }); const ref = await this.bRef(root, name);
    if (ref.remote) throw error('只能重命名本地分支。');
    await this.bBranchName(root, newName); await this.git(root, ['branch', '--move', '--', ref.name, newName]);
    return this.state({ projectPath: root });
  },
  async branchDelete({ projectPath: root, name, token }) {
    await this.bReady(root, { token }); const ref = await this.bRef(root, name);
    if (ref.remote || ref.current) throw error('不能在这里删除远程分支或当前分支。');
    if (['main', 'master'].includes(ref.name)) throw error('试用版保护主分支，请在专家工具中另行处理。');
    await this.git(root, ['branch', '--delete', '--', ref.name]); return this.state({ projectPath: root });
  },
  async mergePreview({ projectPath: root, source, expectedHash }) {
    const state = await this.bReady(root); const ref = await this.bRef(root, source, expectedHash);
    const base = await this.git(root, ['merge-base', 'HEAD', ref.hash], { allowFailure: true });
    if (base.code) throw error('两个分支没有共同历史，试用版不合并无关工程。');
    const commits = (await this.git(root, ['log', '--oneline', `HEAD..${ref.hash}`, '-60'])).stdout.toString('utf8');
    const diff = (await this.git(root, ['diff', '--stat', `HEAD...${ref.hash}`])).stdout.toString('utf8');
    return { source: ref.ref, sourceHash: ref.hash, sourceName: ref.name, token: state.token, commits, diff, fastForward: base.stdout.toString().trim() === state.head };
  },
  async merge({ projectPath: root, source, sourceHash, token }) {
    await this.bReady(root, { token, clean: true }); const ref = await this.bRef(root, source, sourceHash);
    await this.bSafeTree(root, ref.hash); await this.bSigned(root);
    const result = await this.git(root, ['-c', 'merge.autoStash=false', '-c', 'core.editor=true', 'merge', '--no-edit', ref.hash], { allowFailure: true, timeout: 120000 });
    const state = await this.state({ projectPath: root });
    if (result.code && !state.operation && !state.files.some(file => file.conflict)) throw error(result.stderr || '合并未完成。', 'MERGE_FAILED');
    return { state, conflicted: state.files.some(file => file.conflict), output: result.stdout.toString('utf8') + result.stderr };
  },
  async cherryPick({ projectPath: root, hash, token }) {
    await this.bReady(root, { token, clean: true }); const revision = await this.validateHash(root, hash);
    const parents = (await this.git(root, ['rev-list', '--parents', '-n', '1', revision])).stdout.toString().trim().split(' ');
    if (parents.length > 2) throw error('试用版只移植普通提交，合并提交需要选择主线父版本。');
    await this.bSafeTree(root, revision); await this.bSigned(root);
    const result = await this.git(root, ['-c', 'core.editor=true', 'cherry-pick', revision], { allowFailure: true, timeout: 120000 });
    const state = await this.state({ projectPath: root });
    if (result.code && !state.operation) throw error(result.stderr || '提交移植未完成，请检查是否已经包含相同修改。');
    return { state, conflicted: state.files.some(file => file.conflict), output: result.stdout.toString('utf8') + result.stderr };
  },
  async conflicts({ projectPath: root }) {
    const state = await this.state({ projectPath: root });
    return { files: state.files.filter(file => file.conflict), operation: state.operation, token: state.token };
  },
  async conflictFile({ projectPath: root, path: relative }) {
    await this.assertRepo(root); const safe = await this.safePath(root, relative);
    const state = await this.state({ projectPath: root });
    if (!state.files.some(file => file.path === relative && file.conflict)) throw error('此文件当前没有未解决冲突。');
    const versions = {};
    for (const [label, number] of [['base', 1], ['ours', 2], ['theirs', 3]]) {
      const result = await this.git(root, ['show', `:${number}:${safe.relative}`], { allowFailure: true, maxBuffer: 4 * LIMIT });
      versions[label] = result.code ? { missing: true, text: '', binary: false, bytes: 0 } : displayBuffer(result.stdout);
    }
    return { ...versions, current: await this.blob(root, relative, 'working'), token: state.token, path: relative };
  },
  async resolveConflict({ projectPath: root, path: relative, choice, text, token }) {
    const state = await this.bReady(root, { token, operation: true, conflicts: true });
    if (state.operation && !['合并', '挑选提交'].includes(state.operation)) throw error('当前操作需要在原 Git 客户端中解决。');
    if (!state.files.some(file => file.path === relative && file.conflict)) throw error('此文件的冲突状态已变化，请刷新。');
    const safe = await this.safePath(root, relative), before = await this.makeBackup(root, relative, 'resolveConflict');
    const unchanged = await this.fileFingerprint(root, relative);
    if (unchanged.hash !== before.before.hash || unchanged.exists !== before.before.exists || (await this.indexFingerprint(root)).hash !== before.indexHash) throw error('备份期间文件或暂存区发生变化，请刷新后重新处理。', 'STALE_STATE');
    if (choice === 'ours' || choice === 'theirs') {
      const selected = await this.git(root, ['show', choice === 'ours' ? `:2:${relative}` : `:3:${relative}`], { allowFailure: true, maxBuffer: 4 * LIMIT });
      if (selected.code) { if (await exists(safe.absolute)) await fs.unlink(safe.absolute); }
      else await this.git(root, ['checkout', `--${choice}`, '--', relative]);
    } else if (choice === 'edited') {
      const current = await fs.readFile(safe.absolute), displayed = displayBuffer(current);
      if (displayed.binary || displayed.encoding !== 'UTF-8' || typeof text !== 'string' || Buffer.byteLength(text) > LIMIT) throw error('在线编辑只支持 1 MB 内的 UTF-8 文件。请在 Keil 中编辑后选择“标记已解决”。');
      if (/^(<<<<<<< |=======|>>>>>>> )/m.test(text)) throw error('内容仍包含冲突标记，请整理后再保存。');
      const output = current.includes(Buffer.from('\r\n')) ? text.replace(/\r?\n/g, '\r\n') : text.replace(/\r\n/g, '\n');
      const bom = current.length >= 3 && current[0] === 0xef && current[1] === 0xbb && current[2] === 0xbf;
      await fs.writeFile(safe.absolute, (bom ? '\uFEFF' : '') + output, 'utf8');
    } else if (choice === 'working') {
      const current = await this.blob(root, relative, 'working');
      if (!current.binary && /^(<<<<<<< |=======|>>>>>>> )/m.test(current.text)) throw error('磁盘文件仍包含冲突标记，请先在编辑器中解决。');
    } else throw error('请选择一种冲突处理方式。');
    await this.git(root, ['add', '--', relative]); await this.finishBackup(root, before.id);
    return this.state({ projectPath: root });
  },
  async continueOperation({ projectPath: root, token }) {
    const state = await this.bReady(root, { token, operation: true }); await this.bSigned(root);
    if (state.files.some(file => file.unstaged && !file.untracked)) throw error('还有未加入暂存区的修改，请先检查并暂存。');
    if (state.operation === '合并') await this.git(root, ['-c', 'core.editor=true', 'commit', '--no-edit']);
    else if (state.operation === '挑选提交') await this.git(root, ['-c', 'core.editor=true', 'cherry-pick', '--continue']);
    else if (state.operation === '撤销提交') await this.git(root, ['-c', 'core.editor=true', 'revert', '--continue']);
    else throw error('当前没有可继续的合并、移植或反向提交任务。');
    return this.state({ projectPath: root });
  },
  async abortOperation({ projectPath: root, token }) {
    const state = await this.bReady(root, { token, operation: true, conflicts: true });
    const command = state.operation === '合并' ? 'merge' : state.operation === '挑选提交' ? 'cherry-pick' : state.operation === '撤销提交' ? 'revert' : null;
    if (!command) throw error('当前没有可中止的合并或提交移植任务。');
    const backups = await this.bBackups(root, state, 'abortOperation');
    await this.git(root, [command, '--abort']); await this.bFinish(root, backups);
    return this.state({ projectPath: root });
  },
  async stashes({ projectPath: root }) {
    await this.assertRepo(root);
    const result = await this.git(root, ['stash', 'list', '--format=%H%x00%gd%x00%gs%x00%aI']);
    const items = result.stdout.toString('utf8').trim().split('\n').filter(Boolean).map(line => { const [hash, ref, subject, date] = line.split('\0'); return { hash, ref, subject, date }; });
    const archives = await jsonRead(path.join(this.dataDir, 'stash-archives', keyFor(root) + '.json'), []);
    return { items, archives };
  },
  async stashCreate({ projectPath: root, message, includeUntracked = true, token }) {
    const state = await this.bReady(root, { token });
    if (!state.files.some(file => includeUntracked || !file.untracked)) throw error('当前没有可以收起的修改。');
    if (typeof message !== 'string' || !message.trim() || message.length > 500) throw error('请给草稿填写一句说明。');
    const args = ['stash', 'push', '--message', message.trim()]; if (includeUntracked) args.push('--include-untracked');
    await this.git(root, args, { timeout: 120000, literalPaths: false });
    const after = await this.state({ projectPath: root });
    if (after.files.some(file => includeUntracked || !file.untracked)) after.warning = '草稿已保存，但部分文件仍留在工作区，请检查文件状态后再切换分支。';
    return after;
  },
  async bStash(root, hash) {
    const list = await this.stashes({ projectPath: root });
    const item = list.items.find(value => value.hash === hash);
    if (!item) throw error('草稿列表已经变化，请刷新。', 'STALE_STASH');
    return item;
  },
  async stashApply({ projectPath: root, hash, reinstateIndex = true, token }) {
    await this.bReady(root, { token, clean: true }); const item = await this.bStash(root, hash); await this.bSafeTree(root, item.hash);
    const parents = (await this.git(root, ['rev-list', '--parents', '-n', '1', item.hash])).stdout.toString().trim().split(' ');
    if (parents.length > 3) await this.bSafeTree(root, parents[3]);
    const args = ['stash', 'apply']; if (reinstateIndex) args.push('--index'); args.push(item.hash);
    const result = await this.git(root, args, { allowFailure: true, timeout: 120000, literalPaths: false });
    const state = await this.state({ projectPath: root });
    if (result.code && !state.files.some(file => file.conflict)) throw error(result.stderr || '草稿恢复未完成，原草稿仍然保留。');
    return { state, conflicted: state.files.some(file => file.conflict) };
  },
  async stashDrop({ projectPath: root, hash, token }) {
    await this.bReady(root, { token }); const item = await this.bStash(root, hash);
    const id = crypto.randomUUID(), ref = `refs/stm32-manager/stash-archives/${id}`;
    await this.git(root, ['update-ref', ref, item.hash]);
    const file = path.join(this.dataDir, 'stash-archives', keyFor(root) + '.json');
    const list = await jsonRead(file, []); list.unshift({ id, hash: item.hash, subject: item.subject, date: new Date().toISOString(), ref });
    await atomicJson(file, list); await this.git(root, ['stash', 'drop', item.ref]);
    return this.state({ projectPath: root });
  },
  async stashRecover({ projectPath: root, id, token }) {
    await this.bReady(root, { token }); const archives = (await this.stashes({ projectPath: root })).archives;
    const item = archives.find(value => value.id === id); if (!item) throw error('归档草稿不存在。');
    await this.git(root, ['stash', 'store', '-m', item.subject || '找回的草稿', item.hash]);
    return this.state({ projectPath: root });
  },
  async tags({ projectPath: root }) {
    await this.assertRepo(root);
    const result = await this.git(root, ['for-each-ref', '--format=%(refname:short)%00%(objectname)%00%(*objectname)%00%(subject)', 'refs/tags']);
    return { items: result.stdout.toString('utf8').trim().split('\n').filter(Boolean).map(line => { const [name, objectHash, peeled, subject] = line.split('\0'); return { name, objectHash, hash: peeled || objectHash, subject }; }) };
  },
  async tagCreate({ projectPath: root, name, message, hash, token }) {
    await this.bReady(root, { token });
    if (await this.rawConfig(root, 'tag.gpgsign') === 'true') throw error('当前工程要求签名标签，请使用支持签名的 Git 客户端创建。');
    if (typeof name !== 'string' || !name || name.startsWith('-') || /[\r\n\0]/.test(name)) throw error('标签名称无效。');
    const check = await this.git(root, ['check-ref-format', 'refs/tags/' + name], { allowFailure: true }); if (check.code) throw error('标签名称包含保留字符。');
    const revision = await this.validateHash(root, hash || '');
    if (typeof message !== 'string' || !message.trim() || message.length > 2000) throw error('请填写标签说明。');
    await this.git(root, ['-c', 'tag.gpgsign=false', 'tag', '-a', '-m', message.trim(), '--', name, revision]);
    return this.state({ projectPath: root });
  },
  async tagDelete({ projectPath: root, name, token }) {
    await this.bReady(root, { token }); const tag = (await this.tags({ projectPath: root })).items.find(item => item.name === name);
    if (!tag) throw error('标签不存在，请刷新。');
    await this.git(root, ['tag', '-d', '--', name]); return this.state({ projectPath: root });
  },
  async worktrees({ projectPath: root }) {
    await this.assertRepo(root); const result = await this.git(root, ['worktree', 'list', '--porcelain', '-z']);
    const items = [];
    for (const block of result.stdout.toString('utf8').split('\0\0').filter(Boolean)) {
      const item = {};
      for (const field of block.split('\0')) {
        const i = field.indexOf(' '), name = i < 0 ? field : field.slice(0, i), value = i < 0 ? true : field.slice(i + 1);
        if (name === 'worktree') item.path = value;
        else if (name === 'HEAD') item.hash = value;
        else if (name === 'branch') item.branch = String(value).replace(/^refs\/heads\//, '');
        else item[name] = value;
      }
      if (item.path) { item.current = samePath(root, item.path); items.push(item); }
    }
    return { items };
  },
  async worktreeAdd({ projectPath: root, destination, hash, token }) {
    await this.bReady(root, { token }); const revision = await this.validateHash(root, hash); await this.bSafeTree(root, revision);
    if (typeof destination !== 'string' || !path.isAbsolute(destination)) throw error('请选择新工作目录的完整路径。');
    const parent = await fs.realpath(path.dirname(destination)); const target = path.join(parent, path.basename(destination));
    if (within(root, target) || within(target, root) || within(this.dataDir, target)) throw error('新工作目录应位于当前工程及应用数据目录之外。');
    if (await exists(target)) {
      if ((await fs.lstat(target)).isSymbolicLink() || (await fs.readdir(target)).length) throw error('工作目录必须是普通空文件夹。');
    }
    await this.git(root, ['worktree', 'add', '--detach', '--', target, revision], { timeout: 120000 });
    return { path: target, state: await this.state({ projectPath: root }) };
  },
  async worktreeRemove({ projectPath: root, worktreePath, token }) {
    await this.bReady(root, { token }); const item = (await this.worktrees({ projectPath: root })).items.find(value => samePath(value.path, worktreePath));
    if (!item || item.current) throw error('只能移除列表中的其他工作目录。');
    const status = await this.git(item.path, ['status', '--porcelain', '--ignored', '-z']);
    if (status.stdout.length) throw error('这个目录中存在修改、未跟踪文件或编译输出。请先处理这些文件；试用版不强制删除目录。');
    const actualHead = (await this.git(item.path, ['rev-parse', '--verify', 'HEAD'])).stdout.toString().trim();
    const retained = await this.git(root, ['for-each-ref', '--format=%(refname)', '--contains=' + actualHead, 'refs/heads', 'refs/tags', 'refs/remotes']);
    if (!retained.stdout.toString().trim()) throw error('这个目录有尚未被分支或标签保留的提交，请先创建分支或标签再移除。');
    await this.git(root, ['worktree', 'remove', '--', item.path]); return this.state({ projectPath: root });
  },
  async bRemoteUrl(url) {
    if (typeof url !== 'string' || !url.trim() || url.length > 2048 || /[\r\n\0]/.test(url) || url.startsWith('-')) throw error('远程地址无效。');
    if (/^(https|ssh):\/\//.test(url)) {
      const parsed = new URL(url);
      if (parsed.password || (parsed.protocol === 'https:' && parsed.username)) throw error('请使用系统凭据助手，不要把密码或令牌写在地址中。');
      return url;
    }
    if (/^[\w.-]+@[\w.-]+:[^\s]+$/.test(url)) return url;
    if (path.isAbsolute(url) && (await fs.stat(url)).isDirectory()) return fs.realpath(url);
    throw error('只支持 HTTPS、SSH 或本机仓库目录，不支持自定义命令协议。');
  },
  async remotes({ projectPath: root }) {
    const state = await this.state({ projectPath: root }); await this.assertRepo(root);
    const names = (await this.git(root, ['remote'])).stdout.toString('utf8').trim().split('\n').filter(Boolean), items = [];
    for (const name of names) {
      const url = (await this.git(root, ['remote', 'get-url', name])).stdout.toString('utf8').trim();
      const pushUrl = (await this.git(root, ['remote', 'get-url', '--push', name])).stdout.toString('utf8').trim();
      items.push({ name, url, pushUrl });
    }
    const upstreamResult = await this.git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { allowFailure: true });
    let ahead = null, behind = null;
    if (!upstreamResult.code && state.head) { const counts = (await this.git(root, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'])).stdout.toString().trim().split(/\s+/); ahead = Number(counts[0]); behind = Number(counts[1]); }
    return { items, current: state.branch, upstream: upstreamResult.code ? null : upstreamResult.stdout.toString().trim(), ahead, behind };
  },
  async bRemote(root, name, expectedUrl, push = false) {
    if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) throw error('远程名称应由字母、数字、点、横线或下划线组成。');
    const item = (await this.remotes({ projectPath: root })).items.find(value => value.name === name);
    if (!item) throw error('远程地址已不存在，请刷新。');
    const url = push ? item.pushUrl : item.url; await this.bRemoteUrl(url);
    if (expectedUrl && expectedUrl !== url) throw error('远程地址已经变化，请重新预览。', 'STALE_REMOTE');
    for (const config of ['core.sshCommand', `remote.${name}.uploadpack`, `remote.${name}.receivepack`]) if (await this.rawConfig(root, config)) throw error('远程使用了自定义传输命令，试用版暂不执行。');
    return item;
  },
  async remoteSave({ projectPath: root, name, url, token }) {
    await this.bReady(root, { token, head: false });
    if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) throw error('远程名称无效，例如 origin。');
    const checkedUrl = await this.bRemoteUrl(url.trim());
    const old = (await this.remotes({ projectPath: root })).items.find(item => item.name === name);
    await this.git(root, old ? ['remote', 'set-url', name, checkedUrl] : ['remote', 'add', name, checkedUrl]);
    return this.state({ projectPath: root });
  },
  async remoteRemove({ projectPath: root, name, token }) {
    await this.bReady(root, { token, head: false }); await this.bRemote(root, name);
    const refs = (await this.bRefs(root)).filter(ref => ref.ref.startsWith(`refs/remotes/${name}/`));
    const archive = crypto.randomUUID();
    for (let i = 0; i < refs.length; i++) await this.git(root, ['update-ref', `refs/stm32-manager/removed-remotes/${archive}/${i}`, refs[i].hash]);
    await this.git(root, ['remote', 'remove', name]); return this.state({ projectPath: root });
  },
  bNetworkArgs() { return ['-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'protocol.ssh.allow=always', '-c', 'protocol.file.allow=always', '-c', 'submodule.recurse=false']; },
  async syncPreview({ projectPath: root, remote, direction = 'fetch' }) {
    const state = await this.state({ projectPath: root }); const item = await this.bRemote(root, remote, null, direction === 'push');
    const branch = state.branch;
    if (!branch || branch === '分离的 HEAD') throw error('请先切换到一个本地分支。');
    const tracking = `refs/remotes/${remote}/${branch}`;
    const found = await this.git(root, ['rev-parse', '--verify', tracking], { allowFailure: true });
    const commits = state.head ? (await this.git(root, ['log', '--oneline', ...(found.code ? ['HEAD'] : [`${tracking}..HEAD`]), '-30'])).stdout.toString('utf8') : '';
    return { token: state.token, remote, branch, url: direction === 'push' ? item.pushUrl : item.url, direction, commits, clean: !state.files.length };
  },
  async fetch({ projectPath: root, remote, url, token }) {
    await this.bReady(root, { token, head: false }); await this.bRemote(root, remote, url);
    await this.git(root, [...this.bNetworkArgs(), 'fetch', '--no-tags', '--no-recurse-submodules', '--', remote], { timeout: 180000 });
    return this.state({ projectPath: root });
  },
  async pull({ projectPath: root, remote, url, token }) {
    const initial = await this.bReady(root, { token, clean: true }); await this.bRemote(root, remote, url);
    await this.git(root, [...this.bNetworkArgs(), 'fetch', '--no-tags', '--no-recurse-submodules', '--', remote], { timeout: 180000 });
    const state = await this.state({ projectPath: root });
    if (state.head !== initial.head || state.files.length) throw error('获取期间本地工程发生变化，请重新检查后更新。');
    const ref = await this.bRef(root, `refs/remotes/${remote}/${initial.branch}`); await this.bSafeTree(root, ref.hash);
    const result = await this.git(root, ['merge', '--ff-only', ref.hash], { allowFailure: true });
    if (result.code) throw error('远程历史已经获取，但当前分支无法直接快进。请到“分支与草稿”预览并合并对应的远程分支。', 'DIVERGED');
    return this.state({ projectPath: root });
  },
  async push({ projectPath: root, remote, url, token }) {
    const state = await this.bReady(root, { token }); await this.bRemote(root, remote, url, true);
    if (state.branch === '分离的 HEAD') throw error('请先切换到本地分支。');
    const result = await this.git(root, [...this.bNetworkArgs(), 'push', '--porcelain', '--set-upstream', '--', remote, `${state.branch}:refs/heads/${state.branch}`], { allowFailure: true, timeout: 180000 });
    if (result.code && /Authentication failed|could not read Username|terminal prompts disabled|interactive.*disabled|Repository not found/i.test(result.stderr)) throw error('上传未获授权，或仓库地址不可访问。GitHub HTTPS 仓库请点击“登录 GitHub”，并核对仓库地址和账号权限；其他服务请检查本机 Git 凭据。', 'AUTH_REQUIRED');
    if (result.code) throw error('上传未完成。若远程包含新提交，请先获取并整合；试用版不会强制覆盖远程历史。\n' + result.stderr.slice(0, 1500), 'PUSH_REJECTED');
    return this.state({ projectPath: root });
  },
  async exportArchive({ projectPath: root, hash, destination, token }) {
    await this.bReady(root, { token }); const revision = await this.validateHash(root, hash);
    if (await this.rawConfig(root, 'tar.zip.command')) throw error('当前配置使用自定义 ZIP 导出命令，试用版不执行该脚本。');
    if (typeof destination !== 'string' || !path.isAbsolute(destination) || !/\.zip$/i.test(destination)) throw error('请选择 .zip 格式的导出文件。');
    const parent = await fs.realpath(path.dirname(destination)), target = path.join(parent, path.basename(destination));
    if (await exists(target)) throw error('目标文件已经存在，请选择新的文件名。');
    if (within(root, target) && path.relative(root, target).split(path.sep).some(part => part.toLowerCase() === '.git')) throw error('不能向 Git 内部目录导出文件。');
    const temp = path.join(parent, `.stm32-export-${crypto.randomUUID()}.tmp`);
    const handle = await fs.open(temp, 'wx'); await handle.close();
    try {
      await this.git(root, ['archive', '--format=zip', '--output=' + temp, revision], { timeout: 120000 });
      await fs.copyFile(temp, target, constants.COPYFILE_EXCL);
      return { filePath: target, hash: revision, bytes: (await fs.stat(target)).size };
    } finally { await fs.unlink(temp).catch(() => {}); }
  },
};

function installCollaboration(GitService, sets) {
  for (const action of ACTIONS) sets.ACTIONS.add(action);
  for (const action of WRITE) sets.WRITES.add(action);
  Object.assign(GitService.prototype, METHODS);
  const original = GitService.prototype.summary;
  GitService.prototype.summary = function (action, payload, result) {
    return labels[action] ? labels[action] + (result?.conflicted ? '（需要解决冲突）' : '') : original.call(this, action, payload, result);
  };
}
module.exports = { installCollaboration, B_ACTIONS: ACTIONS };
