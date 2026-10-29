'use strict';
const B = { tab: 'branches', root: null, branches: { local: [], remote: [], graph: '' }, stashes: { items: [], archives: [] }, tags: { items: [] }, worktrees: { items: [] }, conflicts: { files: [] }, remotes: { items: [] } };
Object.assign(actionWords, { branchCreate: '创建分支', branchSwitch: '切换分支', branchRename: '重命名分支', branchDelete: '删除已合并分支', merge: '合并分支', resolveConflict: '解决冲突', continueOperation: '完成进行中操作', abortOperation: '中止操作', stashCreate: '收起草稿', stashApply: '恢复草稿', stashDrop: '归档草稿', stashRecover: '找回草稿', tagCreate: '创建标签', tagDelete: '删除标签', worktreeAdd: '创建工作目录', worktreeRemove: '移除工作目录', remoteSave: '设置远程', remoteRemove: '移除远程', fetch: '获取远程', pull: '更新当前分支', push: '上传版本', cherryPick: '移植提交', exportArchive: '导出源码', resolveConflict: '冲突解决前备份' });

async function loadCollaboration() {
  const projectPath = S.current.path;
  const values = await Promise.all(['branches', 'stashes', 'tags', 'worktrees', 'conflicts'].map(action => invoke(action, { projectPath })));
  if (S.current.path !== projectPath) return;
  [B.branches, B.stashes, B.tags, B.worktrees, B.conflicts] = values;
  B.root = projectPath;
}
async function loadRemotes() { B.remotes = await invoke('remotes', params()); B.remoteRoot = S.current.path; }
async function bAct(action, payload, message) {
  return run('正在' + (actionWords[action] || '处理工程') + '…', async () => {
    const result = await invoke(action, params({ token: S.current.token, ...payload }));
    S.current = result.state || result;
    if (result.conflicted) { S.view = 'collaboration'; B.tab = 'conflicts'; }
    await loadViewData(); forceCloseModal(); render();
    toast(result.conflicted ? '操作遇到冲突，请在“解决冲突”中检查并处理。原草稿或原分支历史仍保留。' : message || '操作已完成。');
    return result;
  });
}
function bConfirm(title, description, action, payload = {}, detail = '') {
  const d = modal(title, 'B 阶段 · 操作预览');
  d.body.append(el('p', '', description));
  if (detail) d.body.append(el('pre', 'small-pre', detail));
  const token = payload.token || S.current.token;
  append(d.actions, button('取消', closeModal, 'ghost'), button('确认' + title, () => bAct(action, { ...payload, token }, title + '已完成。'), 'primary'));
}
function bInput(label, value = '', placeholder = '') {
  const input = el('input'); input.value = value; input.placeholder = placeholder; input.setAttribute('aria-label', label);
  const wrap = append(el('div', 'form-field'), el('label', 'field-label', label), input);
  return { input, wrap };
}
function bRow(title, subtitle, actions = [], pill = '') {
  const main = append(el('div', 'record-main'), el('h3', '', title), el('p', '', subtitle));
  if (pill) main.append(el('span', 'pill', pill));
  return append(el('section', 'card list-card b-record'), main, append(el('div', 'inline-actions'), actions));
}
function bSwitchTab(tab) { B.tab = tab; render(); }
function renderCollaboration() {
  $('content').append(pageHeading('分支与草稿', '为新功能建立分支，收起未完成的工作，再把验证后的修改合回来。'));
  if (!S.current.head) { $('content').append(empty('先保存第一个版本', '有了工程基线，才能创建分支、草稿和独立工作目录。')); return; }
  const tabs = [['branches', '分支'], ['stashes', '临时草稿'], ['tags', '版本标签'], ['worktrees', '独立目录'], ['conflicts', `解决冲突${S.current.files.some(file => file.conflict) ? ' · 待处理' : ''}`]];
  $('content').append(append(el('div', 'b-tabs'), segmented(tabs, B.tab, bSwitchTab)));
  if (B.root !== S.current.path) { $('content').append(loading()); return; }
  if (B.tab === 'branches') renderBBranches();
  else if (B.tab === 'stashes') renderBStashes();
  else if (B.tab === 'tags') renderBTags();
  else if (B.tab === 'worktrees') renderBWorktrees();
  else renderBConflicts();
}
function renderBBranches() {
  const blocked = writeBlocked();
  $('content').append(note('当前分支：' + S.current.branch, S.current.files.length ? `当前有 ${S.current.files.length} 个文件变化。切换和合并前，请先保存版本或把工作收起为临时草稿。` : '工作区干净，可以切换分支或预览合并。切换后请在 Keil 中重新加载文件。'));
  $('content').append(append(el('div', 'inline-actions b-toolbar'), button('新建功能分支', bBranchDialog, 'primary', blocked), button('收起临时草稿', bStashDialog, '', blocked || !S.current.files.length)));
  for (const item of B.branches.local) {
    const actions = [];
    if (!item.current) actions.push(button('切换', () => bConfirm('切换分支', `切换到 ${item.name}。磁盘文件将更新为该分支的已提交内容，请先保存 Keil 编辑。`, 'branchSwitch', { name: item.name, expectedHash: item.hash }), 'small', blocked));
    if (!item.current) actions.push(button('预览合并', () => bMergeDialog(item), 'small soft', blocked));
    actions.push(button('改名', () => bRenameDialog(item), 'small ghost', blocked));
    if (!item.current && !['main', 'master'].includes(item.name)) actions.push(button('删除', () => bConfirm('删除已合并分支', `仅删除本地分支 ${item.name}。尚未合并的工作会被 Git 拦截；试用版不强制删除。`, 'branchDelete', { name: item.name }), 'small ghost', blocked));
    $('content').append(bRow(item.name, `${item.hash.slice(0, 8)}${item.upstream ? ' · 上游 ' + item.upstream : ' · 尚无上游关联'}`, actions, item.current ? '当前分支' : '本地分支'));
  }
  for (const item of B.branches.remote) $('content').append(bRow(item.name, item.hash.slice(0, 8), [button('预览合并到当前分支', () => bMergeDialog(item), 'small soft', blocked)], '远程跟踪分支'));
  if (B.branches.graph) { const box = card('提交关系'); box.append(el('pre', 'b-graph', B.branches.graph)); $('content').append(box); }
}
function bBranchDialog() {
  const d = modal('新建功能分支', '从当前已提交版本开始');
  const name = bInput('分支名称', '', '例如 feature/key-debounce'); d.body.append(name.wrap);
  const check = el('input'); check.type = 'checkbox'; check.checked = true;
  d.body.append(append(el('label', 'restore-confirm'), check, el('span', '', '创建后立即切换（需要工作区干净）')));
  append(d.actions, button('取消', closeModal, 'ghost'), button('创建分支', () => bAct('branchCreate', { name: name.input.value.trim(), switchTo: check.checked }, '功能分支已创建。'), 'primary'));
}
function bRenameDialog(item) {
  const d = modal('重命名本地分支'); const field = bInput('新的分支名称', item.name); d.body.append(field.wrap);
  append(d.actions, button('取消', closeModal, 'ghost'), button('保存名称', () => bAct('branchRename', { name: item.name, newName: field.input.value.trim() }, '分支名称已更新。'), 'primary'));
}
async function bMergeDialog(item) {
  await run('正在计算合并预览…', async () => {
    const preview = await invoke('mergePreview', params({ source: item.ref, expectedHash: item.hash }));
    bConfirm('合并分支', `把 ${preview.sourceName} 合入当前的 ${S.current.branch}。${preview.fastForward ? '本次可以直接快进。' : 'Git 会整合两条历史；发生冲突时请在界面中解决。'}`, 'merge', { source: preview.source, sourceHash: preview.sourceHash, token: preview.token }, `${preview.commits || '当前分支已包含这些提交。'}\n${preview.diff}`);
  });
}
function bStashDialog() {
  const d = modal('收起临时草稿', 'Git stash · 保留正式历史');
  const message = bInput('草稿说明', '', '例如 串口功能写到一半'); d.body.append(message.wrap);
  const include = el('input'); include.type = 'checkbox'; include.checked = true;
  d.body.append(append(el('label', 'restore-confirm'), include, el('span', '', '同时收起未跟踪的新文件；已忽略的编译输出会留在磁盘上。')));
  append(d.actions, button('取消', closeModal, 'ghost'), button('收起草稿', () => bAct('stashCreate', { message: message.input.value.trim(), includeUntracked: include.checked }, '当前工作已收起，可在临时草稿中恢复。'), 'primary'));
}
function renderBStashes() {
  $('content').append(append(el('div', 'inline-actions b-toolbar'), button('收起当前工作', bStashDialog, 'primary', writeBlocked() || !S.current.files.length)));
  $('content').append(note('恢复草稿会保留原草稿', '先处理当前修改，再恢复草稿。恢复时会尝试还原原先的暂存选择；冲突可以在“解决冲突”中处理。'));
  if (!B.stashes.items.length) $('content').append(append(el('section', 'card'), empty('当前没有临时草稿', '开发到一半需要切换任务时，可以先收起当前工作。', '◌', 'compact')));
  for (const item of B.stashes.items) $('content').append(bRow(item.subject, `${item.ref} · ${item.hash.slice(0, 8)} · ${dateText(item.date)}`, [
    button('恢复到工作区', () => bConfirm('恢复草稿', '把这份草稿应用到当前分支，并尝试恢复暂存选择。原草稿保留，当前工作区需要干净。', 'stashApply', { hash: item.hash, reinstateIndex: true }, item.subject), 'small soft', writeBlocked()),
    button('归档移除', () => bConfirm('归档草稿', '从当前草稿列表移除，并保留一个本地救援引用。可以在下面的归档列表找回。', 'stashDrop', { hash: item.hash }, item.subject), 'small ghost', writeBlocked()),
  ]));
  if (B.stashes.archives.length) $('content').append(el('h3', 'b-section-title', '已归档的草稿'));
  for (const item of B.stashes.archives) $('content').append(bRow(item.subject, dateText(item.date), [button('找回到草稿列表', () => bConfirm('找回草稿', '恢复到临时草稿列表，不直接改动工程文件。', 'stashRecover', { id: item.id }), 'small', writeBlocked())], '本地归档'));
}
function renderBTags() {
  $('content').append(append(el('div', 'inline-actions b-toolbar'), button('标记当前版本', () => bTagDialog(S.current.head), 'primary', writeBlocked())));
  $('content').append(note('给一个明确的提交命名', '标签指向已提交版本，例如 v1.0-led。编译通过和上板通过仍需实际验证；此处创建的是本地未签名标签。'));
  if (!B.tags.items.length) $('content').append(empty('还没有版本标签', '可以给一个重要节点留下容易记住的名字。'));
  for (const item of B.tags.items) $('content').append(bRow(item.name, `${item.hash.slice(0, 8)} · ${item.subject}`, [button('导出源码 ZIP', () => bExportDialog(item.hash), 'small soft'), button('删除本地标签', () => bConfirm('删除标签', `移除本地标签 ${item.name}，不删除提交，也不会删除远程标签。`, 'tagDelete', { name: item.name }), 'small ghost', writeBlocked())]));
}
function bTagDialog(hash) {
  const d = modal('给这个版本添加标签'); const name = bInput('标签名称', '', '例如 v1.0-led'); const message = bInput('标签说明', '', '实际完成的功能和验证情况');
  append(d.body, el('p', '', `目标版本：${hash.slice(0, 8)}`), name.wrap, message.wrap);
  append(d.actions, button('取消', closeModal, 'ghost'), button('创建标签', () => bAct('tagCreate', { name: name.input.value.trim(), message: message.input.value.trim(), hash }, '版本标签已创建。'), 'primary'));
}
function renderBWorktrees() {
  $('content').append(append(el('div', 'inline-actions b-toolbar'), button('在新目录打开当前版本', () => bWorktreeDialog(S.current.head), 'primary', writeBlocked())));
  $('content').append(note('另开一份已提交工程', '新目录使用独立工作文件，共享 Git 历史。当前未提交修改不会复制过去；打开后需要重新编译。'));
  for (const item of B.worktrees.items) $('content').append(bRow(item.branch || '历史版本 · 分离 HEAD', `${item.path} · ${(item.hash || '').slice(0, 8)}`, item.current ? [] : [button('在工具中打开', () => run('正在打开独立目录…', () => loadProject(item.path)), 'small soft'), button('移除干净目录', () => bConfirm('移除工作目录', '将移除下面的整个独立目录。存在修改、未跟踪文件或编译输出时会停止，不会强制删除。Git 提交历史继续保留。', 'worktreeRemove', { worktreePath: item.path }, item.path), 'small ghost', writeBlocked())], item.current ? '当前目录' : '独立目录'));
}
async function bWorktreeDialog(hash) {
  const d = modal('创建独立工作目录'); const destination = bInput('新工作目录', '', '请选择工程之外的空文件夹'); destination.input.readOnly = true;
  append(d.body, el('p', '', `使用已提交版本 ${hash.slice(0, 8)}，以只读历史起点建立一份可编辑的独立工程。`), destination.wrap, button('选择空文件夹', () => run('选择工作目录…', async () => { const result = await invoke('chooseCloneDestination'); if (result.path) destination.input.value = result.path; })));
  append(d.actions, button('取消', closeModal, 'ghost'), button('创建独立目录', () => bAct('worktreeAdd', { destination: destination.input.value, hash }, '独立目录已创建，可在列表中打开。'), 'primary'));
}
function renderBConflicts() {
  const conflicts = S.current.files.filter(file => file.conflict);
  if (S.current.operation) {
    $('content').append(note(`正在进行：${S.current.operation}`, conflicts.length ? `还有 ${conflicts.length} 个文件需要处理。先比较双方内容，再标记解决。` : '文件冲突已处理。检查结果后，完成本次操作；若有额外未暂存编辑，请先处理。'));
    $('content').append(append(el('div', 'inline-actions b-toolbar'), button('完成当前操作', () => bConfirm('完成当前操作', '使用已经暂存的解决结果完成本次操作。之后请重新编译并验证。', 'continueOperation'), 'primary', conflicts.length > 0), button('中止当前操作', () => bConfirm('中止当前操作', '工具会先备份磁盘上的变化文件，再回到本次操作开始前的状态。正在处理的冲突和解决结果可能被撤回。', 'abortOperation'), '', false)));
  }
  if (!conflicts.length) { $('content').append(append(el('section', 'card'), empty('当前没有未解决的文件冲突', S.current.operation ? '可以检查后完成当前操作。' : '发生合并、移植或草稿冲突时，文件会出现在这里。', '✓'))); return; }
  for (const file of conflicts) $('content').append(bRow(file.path, '请选择保留双方的哪些内容，处理前会备份当前磁盘文件。', [button('查看并解决', () => bConflictDialog(file.path), 'small soft')]));
}
async function bConflictDialog(path) {
  await run('正在读取冲突内容…', async () => {
    const info = await invoke('conflictFile', params({ path })); const d = modal('解决文件冲突', path, true);
    d.body.append(el('p', '', '下方展示双方内容。可以选择一方，也可以编辑结果。保存后会自动加入暂存区；文件处理前会备份。'));
    const sides = el('div', 'restore-columns');
    append(sides, append(el('section', 'restore-column'), el('h4', '', '当前分支内容'), renderCode(info.ours, false)), append(el('section', 'restore-column'), el('h4', '', '并入的内容'), renderCode(info.theirs, false))); d.body.append(sides);
    const base = el('details', 'b-base'); base.append(el('summary', '', '查看公共基线')); base.append(renderCode(info.base, false)); d.body.append(base);
    const editor = el('textarea', 'b-conflict-editor'); editor.setAttribute('aria-label', '合并后的内容'); editor.value = info.current.text || '';
    const editable = !info.current.binary && info.current.encoding === 'UTF-8' && !info.current.truncated; editor.disabled = !editable;
    append(d.body, el('label', 'field-label', '编辑最终结果（UTF-8 文件）'), editor);
    if (!editable) d.body.append(el('div', 'warning-box', '此文件不适合在这里编辑。请在 Keil/外部编辑器中处理后重新读取，再标记已解决。'));
    append(d.body, append(el('div', 'inline-actions b-toolbar'), button('采用当前分支', () => bAct('resolveConflict', { path, choice: 'ours', token: info.token }, '已采用当前分支内容并标记解决。'), 'small'), button('采用并入内容', () => bAct('resolveConflict', { path, choice: 'theirs', token: info.token }, '已采用并入内容并标记解决。'), 'small'), button('重新读取磁盘', () => bConflictDialog(path), 'small ghost')));
    append(d.actions, button('取消', closeModal, 'ghost'), button('标记磁盘文件已解决', () => bAct('resolveConflict', { path, choice: 'working', token: info.token }, '磁盘内容已加入暂存区。'), ''), button('保存编辑并标记解决', () => bAct('resolveConflict', { path, choice: 'edited', text: editor.value, token: info.token }, '解决结果已保存并加入暂存区。'), 'primary', !editable));
  });
}
function bCherryPickDialog(hash) { bConfirm('移植这个提交', '把这个普通提交的修改应用到当前分支。需要工作区干净；如遇冲突，可在“解决冲突”处理。原分支继续保留。', 'cherryPick', { hash }, hash); }
async function bExportDialog(hash) {
  await run('准备导出源码快照…', async () => {
    const result = await invoke('chooseArchiveDestination', params({ hash })); if (!result.path) return;
    const output = await invoke('exportArchive', params({ hash, destination: result.path, token: S.current.token }));
    toast(`源码快照已导出：${output.filePath}。不含 Git 历史、未提交编辑或外部依赖。`);
  });
}
function renderRemote() {
  $('content').append(pageHeading('远程同步', '获取远程历史、快进更新当前分支，或上传已提交的版本。', [button('网页新建 GitHub 仓库', () => bGitHubOpen('githubOpenNew'), 'soft'), button('添加远程地址', () => bRemoteDialog(), 'primary', writeBlocked())]));
  if (B.remoteRoot !== S.current.path) { $('content').append(loading()); return; }
  const remote = B.remotes;
  $('content').append(note(remote.upstream ? `上游：${remote.upstream}` : '当前分支尚未关联上游', remote.ahead === null ? '首次上传时会设置上游关联。远程状态以最近一次“获取”的结果为准。' : `本地领先 ${remote.ahead} 个提交，落后 ${remote.behind} 个提交。状态以最近一次获取为准。`));
  if (!remote.items.length) $('content').append(append(el('section', 'card'), empty('先连接一个远程仓库', '可以填写 HTTPS、SSH 地址，或选择本机的裸仓库目录。无需联网也可以继续管理本地版本。', '⇄')));
  for (const item of remote.items) {
    const github = /^(https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)/.test(item.url);
    $('content').append(bRow(item.name, item.url + (item.pushUrl !== item.url ? '\n上传地址：' + item.pushUrl : ''), [
      ...(github ? [button('打开在线仓库', () => bGitHubOpen('githubOpenRepository', item), 'small ghost'), ...(item.url.startsWith('https:') ? [button('登录 GitHub', () => bGitHubLogin(item), 'small ghost', writeBlocked())] : [])] : []),
      button('获取', () => bSyncDialog(item, 'fetch'), 'small', writeBlocked()), button('快进更新', () => bSyncDialog(item, 'pull'), 'small', writeBlocked()), button('上传当前分支', () => bSyncDialog(item, 'push'), 'small soft', writeBlocked() || !S.current.head),
      button('编辑', () => bRemoteDialog(item), 'small ghost', writeBlocked()), button('移除', () => bConfirm('移除远程地址', '删除此工程中的远程配置和跟踪引用，不会删除服务器上的仓库。本地会保留跟踪提交的救援引用。', 'remoteRemove', { name: item.name }, item.url), 'small ghost', writeBlocked()),
    ]));
  }
  $('content').append(note('第一次连接 GitHub', '① 网页创建空仓库，学习工程可设为 Private；已有本地历史时不要勾选 README。② 添加 HTTPS 地址。③ 点击“登录 GitHub”，在浏览器完成本机 Git 授权。④ 上传当前分支。网页或 Codex 已登录不代表本机 Git 已登录；凭据由系统 Git Credential Manager 保存。'));
  $('content').append(note('上传与更新都需要明确确认', '上传只发送已经提交的当前分支；快进更新不会自动创建合并提交，历史分叉时会停下。需要共享新修改时，先在“当前修改”保存版本，再回来上传。'));
}
async function bGitHubOpen(action, item) {
  await run('正在打开 GitHub…', async () => { await invoke(action, params(item ? { remote: item.name, url: item.url } : {})); toast('已在系统浏览器打开 GitHub。'); });
}
function bGitHubLogin(item) {
  const d = modal('登录本机 Git 的 GitHub 账号');
  append(d.body, el('p', '', '将启动 Git for Windows 自带的 Git Credential Manager，并打开系统浏览器。请核对 GitHub 账号和授权页面中的权限，亲自完成授权。最多等待 5 分钟。'), el('p', '', `当前仓库：${item.url}`), el('p', '', '工具不接收或保存密码、验证码和访问令牌。若使用 SSH 地址，请通过已有 SSH 密钥同步。'));
  append(d.actions, button('取消', closeModal, 'ghost'), button('打开浏览器登录', () => run('等待浏览器中的 GitHub 登录授权…', async () => {
    await invoke('githubLogin', params({ remote: item.name, url: item.url })); forceCloseModal(); toast('本机 Git 登录已完成，可以上传或获取。');
  }), 'primary'));
}
function bRemoteDialog(item) {
  const d = modal(item ? '编辑远程地址' : '添加远程地址'); const name = bInput('远程名称', item?.name || 'origin'); name.input.readOnly = Boolean(item);
  const url = bInput('远程仓库地址', item?.url || '', 'HTTPS / SSH / 本机仓库目录'); append(d.body, name.wrap, url.wrap);
  d.body.append(el('p', '', '请使用本机 Git 凭据助手，不要在地址中填写密码或访问令牌。编辑此处只修改下载地址；已有独立上传地址会保留并显示。'));
  append(d.actions, button('取消', closeModal, 'ghost'), button('保存远程地址', () => bAct('remoteSave', { name: name.input.value.trim(), url: url.input.value.trim() }, '远程地址已保存。'), 'primary'));
}
async function bSyncDialog(item, direction) {
  await run('正在准备同步预览…', async () => {
    const preview = await invoke('syncPreview', params({ remote: item.name, direction }));
    const title = direction === 'push' ? '上传当前分支' : direction === 'pull' ? '快进更新' : '获取远程历史';
    const description = direction === 'push' ? '将当前分支的已提交版本发送到下面的仓库，不包含未提交编辑。' : direction === 'pull' ? '先获取远程历史，再尝试快进到远程同名分支。当前工作区必须干净，历史分叉时会停止。' : '只下载远程历史并更新跟踪信息，当前工作区代码保持现状。';
    bConfirm(title, description, direction, { remote: item.name, url: preview.url, token: preview.token }, `${preview.url}\n分支：${preview.branch}${direction === 'push' ? '\n\n待上传提交（最多展示 30 条）：\n' + preview.commits : ''}`);
  });
}
