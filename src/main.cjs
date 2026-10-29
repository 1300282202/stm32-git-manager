'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, session } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { spawn } = require('node:child_process');
const { GitService } = require('./git-service.cjs');
const { GITHUB_ACTIONS, GitHubConnection } = require('./github-connection.cjs');

const appRoot = path.resolve(__dirname, '..');
const portableRoot = app.isPackaged ? path.dirname(process.execPath) : appRoot;
const dataDir = path.resolve(process.env.STM32_DATA_DIR || path.join(portableRoot, 'data'));
app.setName('STM32 Git 工程管家');
app.setPath('userData', path.join(dataDir, 'desktop'));
app.setPath('sessionData', path.join(dataDir, 'desktop', 'session'));

let mainWindow;
let service;
let githubConnection;
let activeProjectPath;
const registeredProjects = new Set();
const cloning = new Set();
const rendererEntry = path.join(__dirname, 'renderer', 'index.html');
const serviceActions = new Set(['projects', 'inspect', 'state', 'init', 'identity', 'stage', 'unstage', 'commit', 'diff', 'history', 'historyFiles', 'readFile', 'ignorePreview', 'ignoreApply', 'restorePreview', 'restore', 'backups', 'undoRestore', 'logs']);
for (const action of require('./git-collaboration.cjs').B_ACTIONS) serviceActions.add(action);
for (const action of require('./git-expert.cjs').C_ACTIONS) serviceActions.add(action);
for (const action of require('./git-engineering.cjs').D_ACTIONS) serviceActions.add(action);
const desktopActions = new Set(['chooseProject', 'openKeil', 'openFolder', 'chooseCloneDestination', 'chooseArchiveDestination', 'clone', 'appInfo', ...GITHUB_ACTIONS]);
for (const action of ['chooseExpertBundleSave', 'chooseExpertBundleOpen', 'openExpertHelp']) desktopActions.add(action);
for (const action of ['chooseKeilExecutable', 'chooseEngineeringReportSave', 'openEngineeringLink']) desktopActions.add(action);
const key = value => path.resolve(value).toLowerCase();

async function discoverProjects() {
  // Explicit seeds are for isolated tests. Public builds start with no preselected project.
  if (process.env.STM32_SEED_PROJECTS) return JSON.parse(process.env.STM32_SEED_PROJECTS);
  return [];
}

function assertProject(projectPath) {
  if (typeof projectPath !== 'string' || !registeredProjects.has(key(projectPath))) {
    throw new Error('请先使用“选择工程”打开这个文件夹。');
  }
}

function assertSender(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== event.sender.mainFrame) {
    throw new Error('无法识别的应用窗口。');
  }
  const frameUrl = event.senderFrame.url;
  if (!frameUrl.startsWith('file:') || key(fileURLToPath(frameUrl)) !== key(rendererEntry)) {
    throw new Error('请求来源无效。');
  }
}

async function pickFolder(title) {
  const result = await dialog.showOpenDialog(mainWindow, { title, properties: ['openDirectory', 'createDirectory'] });
  const folder = result.canceled ? null : result.filePaths[0];
  if (folder) registeredProjects.add(key(folder));
  return { path: folder };
}

function runProcess(executable, args, timeoutMs = 180000, { interactive = false } = {}) {
  return new Promise((resolve, reject) => {
    const childEnv = { ...process.env };
    for (const name of Object.keys(childEnv)) if (name.startsWith('GIT_') && !['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'].includes(name)) delete childEnv[name];
    const child = spawn(executable, args, {
      windowsHide: true, shell: false,
      env: { ...childEnv, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GCM_INTERACTIVE: interactive ? 'always' : 'never' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = ''; let closed = false;
    const timer = setTimeout(() => { child.kill(); }, timeoutMs);
    const append = data => { output = (output + data.toString('utf8')).slice(-20000); };
    child.stdout.on('data', append); child.stderr.on('data', append);
    child.on('error', error => { if (closed) return; closed = true; clearTimeout(timer); reject(error); });
    child.on('close', code => {
      if (closed) return; closed = true; clearTimeout(timer);
      if (code === 0) resolve(output);
      else {
        const error = new Error(output.trim() || '操作未完成。请检查 Git 安装、网络和访问权限。');
        error.commandExitCode = code;
        reject(error);
      }
    });
  });
}

async function cloneRepository(payload) {
  const { url, destination } = payload;
  if (typeof url !== 'string' || url.length > 2048 || !/^(https:\/\/[^\s]+|ssh:\/\/[^\s]+|[\w.-]+@[\w.-]+:[^\s]+)$/.test(url)) {
    throw new Error('请输入 HTTPS 或 SSH 仓库地址。');
  }
  if (/^(https|ssh):/i.test(url)) {
    const parsed = new URL(url);
    if (parsed.password || (parsed.protocol === 'https:' && parsed.username)) throw new Error('地址中不能包含密码或令牌，请通过系统 Git 凭据助手登录。');
  }
  assertProject(destination);
  if ((await fs.lstat(destination)).isSymbolicLink()) throw new Error('克隆目标不能是目录链接，请选择普通空文件夹。');
  if ((await fs.readdir(destination)).length) throw new Error('请选择一个空文件夹作为克隆目标。');
  if (cloning.has(key(destination))) throw new Error('此目录正在克隆，请等待完成。');
  cloning.add(key(destination));
  try {
    const hooksPath = path.join(dataDir, 'disabled-clone-hooks');
    const options = ['-c', `safe.directory=${destination}`, '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'protocol.ssh.allow=always', '-c', `core.hooksPath=${hooksPath}`, '-c', 'core.fsmonitor=false'];
    await runProcess('git', [...options, 'clone', '--no-checkout', '--no-recurse-submodules', '--', url, destination]);
    const customFilters = await runProcess('git', [...options, '-C', destination, 'config', '--get-regexp', '^filter\\..*\\.(clean|smudge|process)$']).catch(error => {
      if (error.commandExitCode === 1) return '';
      throw error;
    });
    if (customFilters.trim()) throw new Error('仓库已下载，但检测到自定义文件过滤器（可能包含 Git LFS）。A 阶段已暂停首次检出，请使用支持该过滤器的 Git 客户端完成检出后再导入。下载内容保留在所选目录。');
    const headExists = await runProcess('git', [...options, '-C', destination, 'rev-parse', '--verify', 'HEAD']).then(() => true).catch(error => {
      if (error.commandExitCode === 128) return false;
      throw error;
    });
    if (headExists) await runProcess('git', [...options, '-C', destination, 'read-tree', '-m', '-u', 'HEAD']);
    return await service.execute('inspect', { projectPath: destination });
  } finally { cloning.delete(key(destination)); }
}

async function desktopAction(action, payload) {
  if (action === 'chooseProject') return pickFolder('选择 STM32 / Keil 工程文件夹');
  if (action === 'chooseCloneDestination') return pickFolder('选择空文件夹，用于保存下载的仓库');
  if (action === 'chooseArchiveDestination') {
    assertProject(payload.projectPath);
    const result = await dialog.showSaveDialog(mainWindow, { title: '导出已提交版本的源码快照', defaultPath: `${path.basename(payload.projectPath)}-${String(payload.hash || '').slice(0, 7)}.zip`, filters: [{ name: '源码 ZIP 快照', extensions: ['zip'] }] });
    return { path: result.canceled ? null : result.filePath };
  }
  if (action === 'appInfo') {
    const info = await service.execute('projects', {});
    return { version: app.getVersion(), dataDir, gitVersion: info.gitVersion };
  }
  if (action === 'clone') return cloneRepository(payload);
  assertProject(payload.projectPath);
  if (action === 'openEngineeringLink') {
    const url = new URL(payload.url);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('笔记链接只支持不含账号密码的 HTTPS 地址。');
    await shell.openExternal(url.href); return { opened: true };
  }
  if (action === 'chooseKeilExecutable') {
    const result = await dialog.showOpenDialog(mainWindow, { title: '选择本机已安装的 Keil UV4.exe', properties: ['openFile'], filters: [{ name: 'Keil UV4', extensions: ['exe'] }] });
    return { path: result.canceled ? null : result.filePaths[0] };
  }
  if (action === 'chooseEngineeringReportSave') {
    const result = await dialog.showSaveDialog(mainWindow, { title: '导出迁移检查清单', defaultPath: 'STM32迁移检查清单.json', filters: [{ name: 'JSON 清单', extensions: ['json'] }] });
    return { path: result.canceled ? null : result.filePath };
  }
  if (action === 'chooseExpertBundleSave') {
    const result = await dialog.showSaveDialog(mainWindow, { title: '导出离线 Git 历史包', defaultPath: path.basename(payload.projectPath) + '-history.bundle', filters: [{ name: 'Git 历史包', extensions: ['bundle'] }] });
    return { path: result.canceled ? null : result.filePath };
  }
  if (action === 'chooseExpertBundleOpen') {
    const result = await dialog.showOpenDialog(mainWindow, { title: '验证 Git 历史包', properties: ['openFile'], filters: [{ name: 'Git 历史包', extensions: ['bundle'] }] });
    return { path: result.canceled ? null : result.filePaths[0] };
  }
  if (action === 'openExpertHelp') {
    const item = (await service.execute('expertHelp', payload));
    if (item.kind === 'external') throw new Error('外部组件的帮助请查阅该组件的官方文档；本工具不自动运行组件。');
    const page = item.kind === 'document' ? 'git' + item.name : 'git-' + item.name;
    await shell.openExternal('https://git-scm.com/docs/' + page);
    return { opened: true };
  }
  if (GITHUB_ACTIONS.includes(action)) return githubConnection.execute(action, payload);
  if (action === 'openFolder') {
    if (!(await fs.stat(payload.projectPath)).isDirectory()) throw new Error('工程目录已不存在，请重新选择。');
    const error = await shell.openPath(payload.projectPath);
    if (error) throw new Error(error);
    return { opened: true };
  }
  if (action === 'openKeil') {
    const state = await service.execute('state', { projectPath: payload.projectPath });
    const projects = state.keil?.projects || [];
    const selected = payload.keilProjectPath || projects[0]?.path;
    if (!selected || !projects.some(project => key(project.path) === key(selected))) throw new Error('此目录没有可打开的 Keil 工程文件。');
    const executable = ['C:\\Keil_v5\\UV4\\UV4.exe', 'C:\\Keil\\UV4\\UV4.exe'];
    let keil;
    for (const candidate of executable) {
      try { await fs.access(candidate); keil = candidate; break; } catch { /* Try file association below. */ }
    }
    if (keil) {
      await new Promise((resolve, reject) => {
        const child = spawn(keil, [selected], { shell: false, detached: true, stdio: 'ignore', windowsHide: false });
        child.once('error', reject); child.once('spawn', () => { child.unref(); resolve(); });
      });
    } else {
      const error = await shell.openPath(selected);
      if (error) throw new Error('未找到 Keil。请安装 Keil 并设置 .uvprojx 文件关联。');
    }
    return { opened: true };
  }
  throw new Error('不支持的桌面操作。');
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1460, height: 940, minWidth: 1000, minHeight: 700,
    title: 'STM32 Git 工程管家', backgroundColor: '#f5f7f6', show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true,
      nodeIntegration: false, sandbox: true, webSecurity: true,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => { if (url !== mainWindow.webContents.getURL()) event.preventDefault(); });
  mainWindow.webContents.on('will-attach-webview', event => event.preventDefault());
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  mainWindow.once('ready-to-show', () => mainWindow.show());
  await mainWindow.loadFile(rendererEntry);
}

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();
else {
  app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); } });
  app.whenReady().then(async () => {
    await fs.mkdir(dataDir, { recursive: true });
    const seeds = await discoverProjects();
    const practice = path.join(dataDir, 'C版练习工程');
    if (!process.env.STM32_SEED_PROJECTS && await fs.access(path.join(practice, '.git')).then(() => true, () => false)) seeds.unshift(practice);
    for (const seed of seeds) registeredProjects.add(key(seed));
    service = new GitService({ dataDir, seedProjects: seeds });
    service.engineeringTrash = file => shell.trashItem(file);
    const checkpointTimer = setInterval(() => { if (activeProjectPath) service.execute('engineeringAutoTick', { projectPath: activeProjectPath }).catch(() => {}); }, 30000); checkpointTimer.unref();
    githubConnection = new GitHubConnection({ service, openExternal: url => shell.openExternal(url), login: args => runProcess('git', args, 300000, { interactive: true }) });
    const projectList = await service.execute('projects', {});
    for (const project of [...(projectList.recents || []), ...(projectList.discovered || [])]) registeredProjects.add(key(project.path));
    ipcMain.handle('stm32:invoke', async (event, action, payload = {}) => {
      try {
        assertSender(event);
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('操作参数无效。');
        let data;
        if (desktopActions.has(action)) data = await desktopAction(action, payload);
        else if (serviceActions.has(action)) {
          if (action !== 'projects' && action !== 'inspect') assertProject(payload.projectPath);
          if (action === 'inspect' && (typeof payload.projectPath !== 'string' || !path.isAbsolute(payload.projectPath))) throw new Error('请输入工程文件夹的完整路径。');
          data = await service.execute(action, payload);
          if (action === 'inspect') { registeredProjects.add(key(data.path)); activeProjectPath = data.path; }
        } else throw new Error('此操作不属于当前版本支持的功能。');
        return { ok: true, data };
      } catch (error) {
        return { ok: false, error: { message: error.message || '操作失败，请重试。', code: error.code || 'APP_ERROR' } };
      }
    });
    await createWindow();
  }).catch(error => { dialog.showErrorBox('启动失败', error.message); app.quit(); });
}
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { for (const job of service?.dJobs?.values() || []) job.controller.abort('app-exit'); });
