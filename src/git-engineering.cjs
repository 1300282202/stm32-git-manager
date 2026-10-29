'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { constants } = require('node:fs');
const { error, digest, keyFor, samePath, within, exists, shaFile, atomicJson, jsonRead } = require('./git-utils.cjs');
const keil = require('./keil-build.cjs');
const READ = ['engineeringOverview','engineeringBuildPoll','engineeringBuildCancel','engineeringNotes','engineeringNoteRead','engineeringNoteImage','engineeringLfs','engineeringSummary','engineeringAutoTick'];
const WRITE = ['engineeringSettings','engineeringBuildStart','engineeringVerification','engineeringArchive','engineeringArchiveExport','engineeringNoteSave','engineeringCheckpoint','engineeringCheckpointExport','engineeringCheckpointDelete','engineeringReport'];
const D_ACTIONS = [...READ, ...WRITE];
const idNew = () => Date.now() + '-' + crypto.randomUUID();
function idCheck(id) { if (typeof id !== 'string' || !/^\d+-[a-f0-9-]+$/.test(id)) throw error('记录编号无效。'); return id; }
function limited(value, max = 500) { if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw error('文字内容无效或过长。'); return value; }

const METHODS = {
  dBase(root) { return path.join(this.dataDir, 'engineering', keyFor(root)); },
  dNow() { return this.engineeringClock ? this.engineeringClock() : Date.now(); },
  async dSettings(root) {
    const saved = await jsonRead(path.join(this.dBase(root), 'settings.json'), {});
    if (!saved.keilPath) for (const candidate of ['C:\\Keil_v5\\UV4\\UV4.exe','C:\\Keil\\UV4\\UV4.exe']) if (await exists(candidate)) { saved.keilPath = candidate; break; }
    return { checkpointEnabled: false, intervalMinutes: 5, lastTick: 0, ...saved };
  },
  async engineeringSettings({ projectPath: root, keilPath, checkpointEnabled, intervalMinutes }) {
    const settings = await this.dSettings(root);
    if (keilPath !== undefined) { if (typeof keilPath !== 'string' || !path.isAbsolute(keilPath) || path.basename(keilPath).toLowerCase() !== 'uv4.exe' || !(await fs.stat(keilPath)).isFile()) throw error('请选择本机已安装的 Keil UV4.exe。'); settings.keilPath = await fs.realpath(keilPath); }
    if (checkpointEnabled !== undefined) { if (typeof checkpointEnabled !== 'boolean') throw error('检查点开关无效。'); settings.checkpointEnabled = checkpointEnabled; settings.lastTick = this.dNow(); }
    if (intervalMinutes !== undefined) { if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 60) throw error('检查点间隔应为 1—60 分钟。'); settings.intervalMinutes = intervalMinutes; }
    await atomicJson(path.join(this.dBase(root), 'settings.json'), settings); return { settings };
  },
  async dProjects(root) {
    const found = (await this.scan(root)).filter(file => /\.uvprojx$/i.test(file)).slice(0,30), projects = [];
    for (const relative of found) { try { projects.push(await keil.parseProject(this, root, relative)); } catch (e) { projects.push({ project: relative, targets: [], error: e.message }); } }
    return projects;
  },
  async dBuild(root, id) {
    const dir = path.join(this.dBase(root), 'builds', idCheck(id)), record = await jsonRead(path.join(dir, 'record.json'), null);
    if (!record || !samePath(record.projectPath, root)) throw error('找不到本工程的构建记录。');
    return { dir, record };
  },
  async dCurrent(root, record) {
    try { const state = await this.state({ projectPath: root }), current = await keil.snapshot(this, root, record.outputs); return state.token === record.source.stateToken && current.hash === record.source.hash; } catch { return false; }
  },
  async engineeringOverview({ projectPath: root }) {
    await this.assertRepo(root); const base = this.dBase(root), projects = await this.dProjects(root), settings = await this.dSettings(root);
    const currentState = await this.state({ projectPath: root }), snapshots = new Map();
    const builds = []; const dirs = await fs.readdir(path.join(base, 'builds'), { withFileTypes: true }).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
    for (const entry of dirs.filter(entry => entry.isDirectory() && !entry.isSymbolicLink()).sort((a,b) => b.name.localeCompare(a.name)).slice(0,30)) {
      const record = await jsonRead(path.join(base, 'builds', entry.name, 'record.json'), null).catch(() => null); if (!record || !samePath(record.projectPath, root)) continue;
      if (['preparing','running'].includes(record.phase) && !this.dJobs?.has(record.id)) { record.phase = 'interrupted'; record.result = { passed: false, status: 'unconfirmed' }; }
      const snapshotKey = JSON.stringify(record.outputs);
      if (!snapshots.has(snapshotKey)) snapshots.set(snapshotKey, keil.snapshot(this, root, record.outputs).catch(() => null));
      const current = await snapshots.get(snapshotKey);
      builds.push({ ...record, currentMatches: Boolean(current && currentState.token === record.source.stateToken && current.hash === record.source.hash) });
    }
    const archives = await jsonRead(path.join(base, 'archives.json'), []), checkpoints = await jsonRead(path.join(base, 'checkpoints.json'), []);
    return { projects, settings, builds, archives, checkpoints, checkpointLimit: 20, activeBuild: builds.find(item => ['running','preparing'].includes(item.phase))?.id || null };
  },
  async engineeringBuildStart({ projectPath: root, project, target, mode = 'rebuild', token }) {
    const state = await this.bReady(root, { token, head: false });
    if (!['build','rebuild'].includes(mode)) throw error('编译模式无效。');
    const projects = await this.dProjects(root), selected = projects.find(item => item.project === project)?.targets.find(item => item.name === target);
    if (!selected || selected.blocked.length) throw error(selected?.blocked.join('\n') || '请选择已识别的工程及 Target。');
    const settings = await this.dSettings(root);
    if (!this.engineeringRunner && (!settings.keilPath || path.basename(settings.keilPath).toLowerCase() !== 'uv4.exe' || !(await fs.stat(settings.keilPath)).isFile())) throw error('未找到 Keil UV4.exe，请先选择安装位置。');
    if (within(root, this.dataDir)) throw error('应用数据位于工程内部，不能创建隔离构建快照。');
    const outputs = [...new Set(projects.flatMap(item => item.targets.flatMap(item => item.outputs)))];
    const source = await keil.snapshot(this, root, outputs);
    for (const parsed of projects.filter(item => item.hash)) if (source.files.find(file => file.path === parsed.project)?.sha256 !== parsed.hash) throw error('工程配置在预检查后发生变化，请重新编译。');
    const tracked = new Set((await this.git(root, ['ls-files','-z'])).stdout.toString('utf8').split('\0'));
    const id = idNew(), dir = path.join(this.dBase(root), 'builds', id), workspace = path.join(dir, 'workspace'); await fs.mkdir(workspace, { recursive: true });
    for (const file of source.files) {
      const safe = await this.safePath(root, file.path, { allowMissing: false }), destination = path.join(workspace, file.path); await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.copyFile(safe.absolute, destination, constants.COPYFILE_EXCL);
      if (await shaFile(destination) !== file.sha256) throw error('构建快照校验失败，尚未启动编译。');
    }
    if ((await keil.snapshot(this, root, outputs)).hash !== source.hash || (await this.state({ projectPath: root })).token !== state.token) throw error('创建快照期间工程发生变化，请刷新后重新编译。');
    const record = { id, projectPath: root, project, target, device: selected.device, compiler: selected.compiler, executable: settings.keilPath || 'injected-test-runner', execution: this.engineeringRunner ? 'test-simulation' : 'keil', mode, outputs, output: selected.outputs[0], outputName: selected.outputName, createHex: selected.createHex, phase: 'preparing', date: new Date().toISOString(), source: { ...source, head: state.head, branch: state.branch, stateToken: state.token, commitBound: Boolean(state.head && !state.files.length && source.files.every(file => tracked.has(file.path))) }, artifacts: [], verification: null };
    await atomicJson(path.join(dir, 'record.json'), record);
    this.dJobs ||= new Map(); this.longOperations ||= new Set(); const controller = new AbortController(); this.dJobs.set(id, { root, controller }); this.longOperations.add(keyFor(root));
    setImmediate(() => this.dRunBuild(root, dir, workspace, record, controller).catch(() => {}));
    return { buildId: id, phase: record.phase };
  },
  async dRunBuild(root, dir, workspace, record, controller) {
    const timer = setTimeout(() => controller.abort('timeout'), this.engineeringTimeout || 10 * 60000);
    let shortBase, tempRoot;
    try {
      tempRoot = await fs.realpath(os.tmpdir()); shortBase = await fs.mkdtemp(path.join(tempRoot, 's32-'));
      const compilerWorkspace = path.join(shortBase, 'w'); await fs.mkdir(compilerWorkspace);
      for (const file of record.source.files) { const target = path.join(compilerWorkspace, file.path); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.copyFile(path.join(workspace, file.path), target, constants.COPYFILE_EXCL); if (await shaFile(target) !== file.sha256) throw error('短路径编译快照校验失败。'); }
      record.compilerLogPath = path.join(shortBase, 'build.log');
      record.phase = 'running'; await atomicJson(path.join(dir, 'record.json'), record);
      const runner = this.engineeringRunner || keil.runKeil;
      const result = await runner({ executable: record.executable, workspace: compilerWorkspace, project: record.project, target: record.target, mode: record.mode, logPath: record.compilerLogPath, signal: controller.signal });
      const log = ((await keil.readLog(record.compilerLogPath)) + '\n' + (result.output || '')).trim().slice(0, 1024 * 1024); await fs.writeFile(path.join(dir, 'build.log'), log);
      record.result = keil.parseBuildResult(result.code, log); record.exitCode = result.code;
      record.compilerObserved = /\*\*\* Using Compiler '([^']+)'/i.exec(log)?.[1] || null;
      record.sourceVerified = (await keil.snapshot(this, compilerWorkspace, record.outputs)).hash === record.source.hash;
      record.currentMatchesAtEnd = await this.dCurrent(root, record);
      if (controller.signal.aborted) { record.phase = controller.signal.reason === 'timeout' ? 'timed-out' : 'cancelled'; record.result.passed = false; record.result.status = record.phase; }
      else {
        record.phase = 'completed';
        if (record.result.passed && record.sourceVerified) {
          const output = path.join(compilerWorkspace, record.output); const entries = await fs.readdir(output, { withFileTypes: true }).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
          for (const entry of entries) if (entry.isFile() && /\.(hex|bin|axf|elf)$/i.test(entry.name) && path.parse(entry.name).name.toLowerCase() === path.parse(record.outputName).name.toLowerCase() && (record.createHex || !/\.hex$/i.test(entry.name))) {
            const relative = path.relative(compilerWorkspace, path.join(output, entry.name)).replace(/\\/g, '/'), safe = await this.safePath(compilerWorkspace, relative, { allowMissing: false }), stat = await fs.stat(safe.absolute);
            if (stat.size > 64 * 1024 * 1024) continue;
            const preserved = path.join(workspace, relative); await fs.mkdir(path.dirname(preserved), { recursive: true }); await fs.copyFile(safe.absolute, preserved, constants.COPYFILE_EXCL);
            record.artifacts.push({ id: digest(relative).slice(0,16), path: relative, name: entry.name, format: path.extname(entry.name).slice(1).toUpperCase(), bytes: stat.size, sha256: await shaFile(safe.absolute) });
          }
        }
      }
    } catch (e) { record.phase = controller.signal.aborted ? 'cancelled' : 'failed'; record.result = { passed: false, status: record.phase }; record.error = String(e.message).slice(0,2000); }
    finally {
      clearTimeout(timer); record.finishedAt = new Date().toISOString(); await atomicJson(path.join(dir, 'record.json'), record).catch(() => {}); this.dJobs.delete(record.id); this.longOperations.delete(keyFor(root));
      if (shortBase && !controller.signal.aborted && path.dirname(shortBase) === tempRoot && /^s32-[a-zA-Z0-9]+$/.test(path.basename(shortBase))) await fs.rm(shortBase, { recursive: true, force: true }).catch(() => {});
    }
  },
  async engineeringBuildPoll({ projectPath: root, buildId }) {
    const { dir, record } = await this.dBuild(root, buildId);
    if (['preparing','running'].includes(record.phase) && !this.dJobs?.has(buildId)) { record.phase = 'interrupted'; record.result = { passed: false, status: 'unconfirmed' }; }
    const log = await keil.readLog(['preparing','running'].includes(record.phase) ? record.compilerLogPath || path.join(dir,'tool.log') : path.join(dir, 'build.log'));
    return { ...record, currentMatches: ['preparing','running'].includes(record.phase) ? null : await this.dCurrent(root, record), log: log.slice(-100000) };
  },
  async engineeringBuildCancel({ projectPath: root, buildId }) { await this.dBuild(root, buildId); const job = this.dJobs?.get(buildId); if (!job || !samePath(job.root, root)) throw error('当前构建已结束或不属于本次进程。'); job.controller.abort('cancelled'); return { cancelling: true }; },
  async engineeringVerification({ projectPath: root, buildId, verdict, board, notes }) {
    if (!['passed','failed','untested'].includes(verdict)) throw error('验证结果无效。'); const { dir, record } = await this.dBuild(root, buildId);
    if (['preparing','running'].includes(record.phase)) throw error('请先等待编译结束。');
    if (verdict === 'passed' && (!record.result?.passed || !record.sourceVerified)) throw error('该构建未通过编译或输入校验，不能为它记录上板通过；可以记录失败或未测试。');
    if (!limited(board,200).trim()) throw error('请填写板卡或测试对象。');
    record.verification = { kind: 'manual-board', verdict, board: board.trim(), notes: limited(notes || '',4000), date: new Date().toISOString(), sourceHash: record.source.hash, artifacts: record.artifacts.map(item => item.sha256) };
    await atomicJson(path.join(dir, 'record.json'), record); return { verification: record.verification, currentMatches: await this.dCurrent(root, record) };
  },
  async engineeringArchive({ projectPath: root, buildId, artifactIds, includeSource = true }) {
    if (typeof includeSource !== 'boolean') throw error('是否包含工程快照的选项无效。');
    const { dir, record } = await this.dBuild(root, buildId), workspace = path.join(dir, 'workspace');
    if (record.phase !== 'completed' || !record.result?.passed || !record.sourceVerified) throw error('只有成功且输入快照校验通过的构建可以归档。');
    if (!Array.isArray(artifactIds) || !artifactIds.length || artifactIds.some(id => !record.artifacts.some(item => item.id === id))) throw error('请选择该构建记录中的产物。');
    const selected = record.artifacts.filter(item => artifactIds.includes(item.id));
    const checked = [...selected.map(item => ({ ...item, destination: 'firmware/' + item.name })), ...(includeSource ? record.source.files.map(item => ({ ...item, destination: 'source/' + item.path })) : [])];
    for (const file of checked) { const safe = await this.safePath(workspace, file.path, { allowMissing: false }); if (await shaFile(safe.absolute) !== file.sha256) throw error('构建文件或产物在生成后已变化，拒绝归档。'); }
    const id = idNew(), destination = path.join(this.dBase(root), 'archives', id); await fs.mkdir(destination, { recursive: true }); const files = [];
    for (const file of checked) { const target = path.join(destination, file.destination); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.copyFile(path.join(workspace, file.path), target, constants.COPYFILE_EXCL); if (await shaFile(target) !== file.sha256) throw error('归档文件校验失败。'); files.push({ path: file.destination, sha256: file.sha256, bytes: (await fs.stat(target)).size }); }
    const log = await keil.readLog(path.join(dir, 'build.log')); await fs.writeFile(path.join(destination, 'build.log'), log); files.push({ path: 'build.log', sha256: await shaFile(path.join(destination, 'build.log')), bytes: Buffer.byteLength(log) });
    const manifest = { format: 'stm32-git-firmware-v1', id, buildId, execution: record.execution, project: path.basename(root), target: record.target, device: record.device, compilerRequested: record.compiler, compilerObserved: record.compilerObserved, date: new Date().toISOString(), source: { hash: record.source.hash, head: record.source.head, commitBound: record.source.commitBound, includeSource: Boolean(includeSource) }, compile: record.result, verification: record.verification, files, containsGitHistory: false };
    await atomicJson(path.join(destination, 'manifest.json'), manifest);
    const item = { id, buildId, projectPath: root, date: manifest.date, sourceHash: record.source.hash, manifestHash: await shaFile(path.join(destination, 'manifest.json')), files, artifacts: selected.map(item => item.name), includeSource: Boolean(includeSource) };
    const index = path.join(this.dBase(root), 'archives.json'), old = await jsonRead(index, []); await atomicJson(index, [item, ...old]); return item;
  },
  async engineeringArchiveExport({ projectPath: root, id, destination }) {
    const item = (await jsonRead(path.join(this.dBase(root), 'archives.json'), [])).find(item => item.id === idCheck(id)); if (!item || !samePath(item.projectPath, root)) throw error('归档不存在。');
    const source = path.join(this.dBase(root), 'archives', id), target = await this.cEmptyDestination(root, destination);
    if (await shaFile(path.join(source, 'manifest.json')) !== item.manifestHash) throw error('归档清单校验失败。');
    for (const file of item.files) { const safe = await this.safePath(source, file.path, { allowMissing: false }); if (await shaFile(safe.absolute) !== file.sha256) throw error('归档内容校验失败。'); }
    for (const file of [...item.files, { path: 'manifest.json' }]) { const out = path.join(target, file.path); await fs.mkdir(path.dirname(out), { recursive: true }); await fs.copyFile(path.join(source, file.path), out, constants.COPYFILE_EXCL); }
    return { destination: target, files: item.files.length + 1 };
  },
  async engineeringNotes({ projectPath: root }) { return { items: (await this.scan(root)).filter(file => /\.md$/i.test(file)).slice(0,100) }; },
  async engineeringNoteRead({ projectPath: root, notePath }) {
    if (typeof notePath !== 'string' || !/\.md$/i.test(notePath)) throw error('笔记路径必须以 .md 结尾。'); const safe = await this.safePath(root, notePath), fingerprint = await this.fileFingerprint(root, notePath);
    if (fingerprint.bytes > 1024 * 1024) throw error('笔记超过 1 MB，请使用外部编辑器。');
    const raw = fingerprint.exists ? await fs.readFile(safe.absolute) : Buffer.alloc(0); let content;
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(raw); } catch { throw error('笔记不是 UTF-8，保留原文件，请先在外部编辑器另存为 UTF-8。'); }
    return { notePath, content, version: fingerprint.hash, exists: fingerprint.exists, bom: raw.subarray(0,3).equals(Buffer.from([239,187,191])) };
  },
  async engineeringNoteSave({ projectPath: root, notePath, content, version }) {
    await this.assertRepo(root, { write: true }); limited(content,1024 * 1024); if (Buffer.byteLength(content) > 1024 * 1024) throw error('UTF-8 笔记内容超过 1 MB。'); const current = await this.engineeringNoteRead({ projectPath: root, notePath });
    if (current.version !== version) throw error('笔记已被其他程序修改，请重新读取；你的编辑草稿仍保留。', 'STALE_NOTE');
    const backup = await this.makeBackup(root, notePath, 'engineeringNoteSave'), safe = await this.safePath(root, notePath);
    await fs.mkdir(path.dirname(safe.absolute), { recursive: true });
    if ((await this.fileFingerprint(root, notePath)).hash !== version) throw error('保存前笔记发生变化，已停止覆盖。');
    const temp = safe.absolute + '.' + crypto.randomUUID() + '.tmp';
    try { await fs.writeFile(temp, (current.bom ? '\uFEFF' : '') + content, { flag: 'wx' }); await fs.rename(temp, safe.absolute); } finally { await fs.unlink(temp).catch(() => {}); }
    await this.finishBackup(root, backup.id); return { ...(await this.engineeringNoteRead({ projectPath: root, notePath })), backupId: backup.id };
  },
  async engineeringNoteImage({ projectPath: root, notePath, imagePath }) {
    if (typeof imagePath !== 'string' || /^(?:[a-z][a-z0-9+.-]*:|\/|\\)/i.test(imagePath)) throw error('只预览工程内的相对图片，不加载远程图片。');
    const note = await this.safePath(root, notePath), absolute = path.resolve(path.dirname(note.absolute), imagePath.replace(/\\/g, '/')), relative = path.relative(root, absolute).replace(/\\/g, '/'), safe = await this.safePath(root, relative, { allowMissing: false });
    const stat = await fs.stat(safe.absolute); if (!stat.isFile() || stat.size > 3 * 1024 * 1024) throw error('图片不是普通文件或超过 3 MB。'); const data = await fs.readFile(safe.absolute); let type;
    if (data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) type = 'image/png'; else if (data[0] === 255 && data[1] === 216 && data[2] === 255) type = 'image/jpeg'; else if (/^GIF8[79]a/.test(data.subarray(0,6).toString())) type = 'image/gif'; else if (data.subarray(0,4).toString() === 'RIFF' && data.subarray(8,12).toString() === 'WEBP') type = 'image/webp';
    if (!type) throw error('只支持 PNG、JPEG、GIF 和 WebP，不执行 SVG 或 HTML。'); return { dataUrl: `data:${type};base64,${data.toString('base64')}` };
  },
  async engineeringCheckpoint({ projectPath: root, automatic = false }) {
    const state = await this.bReady(root, { head: false }), file = path.join(this.dBase(root), 'checkpoints.json'), old = await jsonRead(file, []);
    if (old.length >= 20) throw error('检查点已达 20 个，请先把不需要的检查点移到回收站。');
    const inventory = await this.cInventory(root), record = await this.cSnapshot(root, 'checkpoint', state, inventory, { rescue: false }); await this.cFinishSnapshot(root, record, 'completed');
    const index = await this.indexFingerprint(root), fingerprint = digest(JSON.stringify([inventory.fingerprint,index.hash,state.head])), item = { id: record.id, projectPath: root, date: record.date, bytes: inventory.bytes, files: inventory.files.length, head: state.head, automatic: Boolean(automatic), fingerprint };
    await atomicJson(file, [item,...old]); const settings = await this.dSettings(root); settings.lastTick = this.dNow(); settings.lastFingerprint = fingerprint; await atomicJson(path.join(this.dBase(root), 'settings.json'), settings); return item;
  },
  async engineeringCheckpointExport({ projectPath: root, id, destination }) { if (!(await jsonRead(path.join(this.dBase(root), 'checkpoints.json'), [])).some(item => item.id === idCheck(id))) throw error('检查点不存在。'); return this.expertBackupExport({ projectPath: root, id, destination }); },
  async engineeringCheckpointDelete({ projectPath: root, id }) {
    const file = path.join(this.dBase(root), 'checkpoints.json'), items = await jsonRead(file, []), item = items.find(item => item.id === idCheck(id)); if (!item) throw error('检查点不存在。');
    const base = path.join(this.dataDir, 'expert-backups', keyFor(root)), folder = path.join(base, id), manifest = await jsonRead(path.join(folder, 'manifest.json'), null);
    if (!manifest || manifest.reason !== 'checkpoint' || !samePath(manifest.projectPath, root) || (await fs.lstat(folder)).isSymbolicLink() || !within(base, await fs.realpath(folder))) throw error('检查点目录校验失败。');
    if (!this.engineeringTrash) throw error('当前环境不提供系统回收站，请通过桌面程序操作。'); await this.engineeringTrash(folder); await atomicJson(file, items.filter(item => item.id !== id)); return { trashed: true };
  },
  async engineeringAutoTick({ projectPath: root }) {
    const settings = await this.dSettings(root), now = this.dNow(); if (!settings.checkpointEnabled || now - settings.lastTick < settings.intervalMinutes * 60000) return { skipped: 'not-due-or-disabled' };
    const lock = keyFor(root); if (this.busy.has(lock) || this.longOperations?.has(lock)) return { skipped: 'busy' }; this.busy.add(lock);
    try {
      const state = await this.bReady(root, { head: false }), inventory = await this.cInventory(root), index = await this.indexFingerprint(root), fingerprint = digest(JSON.stringify([inventory.fingerprint,index.hash,state.head]));
      if (fingerprint === settings.lastFingerprint) { settings.lastTick = now; await atomicJson(path.join(this.dBase(root), 'settings.json'), settings); return { skipped: 'unchanged' }; }
      if ((await jsonRead(path.join(this.dBase(root), 'checkpoints.json'), [])).length >= 20) return { skipped: 'limit-reached' };
      const item = await this.engineeringCheckpoint({ projectPath: root, automatic: true }); await this.log(root, 'engineeringCheckpoint', '自动保存本地检查点', true); return item;
    } finally { this.busy.delete(lock); }
  },
  async engineeringLfs({ projectPath: root }) {
    if (await this.rawConfig(root, 'alias.lfs')) throw error('检测到自定义 lfs 别名，本版不执行该别名。'); const result = await this.git(root, ['lfs','version'], { allowFailure: true, timeout: 10000 });
    return { installed: result.code === 0, version: result.code === 0 ? result.stdout.toString().trim() : '未检测到可用 Git LFS', scope: '本版仅检测组件，不安装、跟踪、下载、上传或迁移大文件；既有 LFS 过滤器仓库的写入尚待适配。' };
  },
  async engineeringSummary({ projectPath: root }) {
    const state = await this.state({ projectPath: root }), groups = { '源码':0,'工程配置':0,'文档与资料':0 };
    for (const file of state.files) groups[/\.(c|h|s|asm|cpp|hpp)$/i.test(file.path) ? '源码' : /\.(uvprojx|uvoptx|ioc|sct)$/i.test(file.path) ? '工程配置' : '文档与资料']++;
    return { text: '记录本次工程修改\n\n' + Object.entries(groups).filter(([,n]) => n).map(([name,n]) => `- ${name}：${n} 个文件`).join('\n') + '\n\n验证情况：请填写实际编译和上板结果。', source: '按文件类型生成的规则草稿，不是 AI 语义分析' };
  },
  async engineeringReport({ projectPath: root, destination }) {
    const report = { format: 'stm32-migration-checklist-v1', project: path.basename(root), date: new Date().toISOString(), projects: await this.dProjects(root), git: await this.repoInfo(root), scope: '仅迁移检查清单，不含完整源码、Git 历史、固件、Keil 安装或外部依赖。', extensions: { lfs: '仅支持版本检测', hosting: '沿用 GitHub 连接', ai: '未启用在线模型；规则草稿不上传源码' } };
    delete report.git.repoRoot; return this.cExportFile(root, destination, '.json', temp => fs.writeFile(temp, JSON.stringify(report,null,2)));
  },
};
function installEngineering(GitService, sets) { Object.assign(GitService.prototype, METHODS); for (const action of D_ACTIONS) sets.ACTIONS.add(action); for (const action of WRITE) sets.WRITES.add(action); }
module.exports = { installEngineering, D_ACTIONS };
