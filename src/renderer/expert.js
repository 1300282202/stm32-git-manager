'use strict';
const E = { tab: 'history', root: null, overview: { commits: [], bisect: {} }, catalog: { items: [] }, reflog: { items: [] }, backups: { items: [] }, report: null };
Object.assign(actionWords, { expertExecute: '执行专家向导', expertRescue: '创建救援分支', expertBackupExport: '导出工作区备份', expertBisectStart: '开始二分排错', expertBisectMark: '标记候选版本', expertBisectStop: '结束二分排错', expertBisectWorktree: '检出候选版本', expertBundleExport: '导出离线历史包', expertBundleVerify: '验证离线历史包' });

async function loadExpert() {
  const root = S.current.path;
  const [overview, catalog, reflog, backups] = await Promise.all(['expertOverview', 'expertCatalog', 'expertReflog', 'expertBackups'].map(action => invoke(action, { projectPath: root })));
  if (root !== S.current.path) return;
  if (E.root !== root) E.report = null;
  Object.assign(E, { root, overview, catalog, reflog, backups });
}
function cTab(tab) { E.tab = tab; render(); }
function cField(label, control) { control.setAttribute('aria-label', label); return append(el('div', 'form-field'), el('label', 'field-label', label), control); }
function cCommitSelect(label, index = 0) {
  const input = el('select'); E.overview.commits.forEach((commit, i) => { const option = el('option', '', `${commit.hash.slice(0, 8)} · ${commit.subject}`); option.value = commit.hash; option.selected = i === index; input.append(option); });
  return { input, wrap: cField(label, input) };
}
function cOutput(title, text) {
  const d = modal(title, 'C1 · 操作结果', true); d.body.append(el('pre', 'c-output', text)); d.actions.append(button('知道了', closeModal, 'primary'));
}
async function cAct(action, payload = {}, success = '操作已完成。') {
  const result = await run('正在' + (actionWords[action] || '处理') + '…', async () => {
    const result = await invoke(action, params({ token: S.current.token, ...payload }));
    if (result.state) S.current = result.state;
    if (result.conflicted) { S.view = 'collaboration'; B.tab = 'conflicts'; }
    await loadViewData(); forceCloseModal(); render(); toast(result.conflicted ? '反向提交遇到冲突，请处理后继续或中止。' : success); return result;
  });
  return result;
}
function cConfirm(title, detail, action, payload, success) {
  const d = modal(title, 'C1 · 确认操作'); d.body.append(el('p', '', detail));
  append(d.actions, button('取消', closeModal, 'ghost'), button('确认' + title, () => cAct(action, payload, success), 'primary'));
}
function renderExpert() {
  $('content').append(pageHeading('专家工具箱', 'C1 起步版：预览、备份、执行，再核对结果。B 版的日常按钮仍可使用。'));
  $('content').append(note('本次可用范围', '重置与清理向导、修改未共享提交说明、反向提交、reflog 救援、手动二分排错、只读诊断、离线历史包。完整交互式变基、子模块管理、签名、维护写入、补丁应用及服务端工具仍待后续实现；命令目录会明确标注。'));
  const tabs = [['history', '历史与清理'], ['reflog', '找回版本'], ['bisect', '二分排错'], ['backups', '操作前备份'], ['diagnose', '仓库诊断'], ['bundle', '离线历史包'], ['catalog', '全部命令目录']];
  $('content').append(append(el('div', 'b-tabs c-tabs'), segmented(tabs, E.tab, cTab)));
  if (E.root !== S.current.path) { $('content').append(loading()); return; }
  if (E.tab === 'history') renderCHistory();
  else if (E.tab === 'reflog') renderCReflog();
  else if (E.tab === 'bisect') renderCBisect();
  else if (E.tab === 'backups') renderCBackups();
  else if (E.tab === 'diagnose') renderCDiagnose();
  else if (E.tab === 'bundle') renderCBundle();
  else renderCCatalog();
}
function renderCHistory() {
  if (!S.current.head) { $('content').append(empty('先保存第一个版本', '历史操作需要至少一个正式版本。命令目录和帮助仍可查看。')); return; }
  const blocked = writeBlocked();
  const reset = card('移动分支与重置'); const target = cCommitSelect('重置目标版本'); const mode = el('select');
  for (const [value, label] of [['soft', 'soft：只移动分支，保留暂存与磁盘'], ['mixed', 'mixed：重建暂存区，保留磁盘'], ['hard', 'hard：同时覆盖暂存区与磁盘文件']]) { const option = el('option', '', label); option.value = value; mode.append(option); }
  append(reset, target.wrap, cField('重置模式', mode), el('p', '', '执行前保存全部磁盘普通文件、原始索引，并建立 rescue/ 救援分支。远程不会随重置自动改变，也不会强制上传。'), button('预览重置', () => cPreview({ kind: 'reset', target: target.input.value, mode: mode.value }), 'soft', blocked));
  const clean = card('清理未跟踪文件'); const ignored = el('input'); ignored.type = 'checkbox';
  const ignoredLabel = append(el('label', 'c-checkbox'), ignored, el('span', '', '同时列出已忽略的文件（可能包含编译输出）'));
  append(clean, el('p', '', '已被 Git 跟踪的源码不在清理列表中。预览后逐项勾选；本版保留空目录。'), ignoredLabel, button('预览清理文件', () => cPreview({ kind: 'clean', includeIgnored: ignored.checked }), 'soft', blocked));
  const amend = card('修改末次提交说明'); const description = el('textarea'); description.rows = 3; description.placeholder = '为末次版本填写新的说明';
  append(amend, cField('新的末次提交说明', description), el('p', '', '要求工作区干净，且末次提交尚未出现在远程跟踪历史中；不带入代码变化。'), button('预览修改说明', () => cPreview({ kind: 'amend', message: description.value }), 'soft', blocked));
  const revert = card('撤销一个提交的改动'); const selected = cCommitSelect('反向提交的目标版本');
  append(revert, selected.wrap, el('p', '', '以新的反向提交撤销改动，适合保留已经共享的历史。本版支持普通提交；冲突进入现有解决页面。'), button('预览反向提交', () => cPreview({ kind: 'revert', target: selected.input.value }), 'soft', blocked));
  $('content').append(append(el('div', 'c-grid'), reset, clean, amend, revert));
}
async function cPreview(payload) {
  await run('正在计算影响与备份范围…', async () => {
    const preview = await invoke('expertPreview', params(payload));
    const titles = { reset: '重置', clean: '清理', amend: '修改说明', revert: '反向提交' };
    const d = modal(titles[preview.kind] + '预览', 'C1 · 执行前检查', true);
    append(d.body, el('p', '', preview.explanation), el('pre', 'small-pre', `当前分支：${preview.branch}\n当前版本：${preview.head}\n目标版本：${preview.revision || '选择的未跟踪文件'}\n工作区普通文件备份：${preview.files} 个文件，${bytesText(preview.bytes)}\n备份还包含原始暂存区，并建立救援分支。`));
    if (preview.shared) d.body.append(note('当前版本出现在远程历史中', `相关远程引用：${preview.shared}。本地重置后可能与远程分叉；后续需要检查合并，工具不会强推。`));
    if (preview.commitMessage) d.body.append(el('pre', 'small-pre', preview.commitMessage));
    const selections = new Map();
    if (preview.kind === 'clean') {
      const list = el('div', 'c-file-list');
      for (const file of preview.candidates) { const checkbox = el('input'); checkbox.type = 'checkbox'; checkbox.setAttribute('aria-label', '清理 ' + file.path); selections.set(file.path, checkbox); list.append(append(el('label', 'c-checkbox'), checkbox, el('span', '', `${file.path} · ${bytesText(file.bytes)}${file.ignored ? ' · 已忽略' : ''}`))); }
      append(d.body, el('p', '', `共 ${preview.candidates.length} 个候选文件；仅清理勾选项。`), button('选择全部列出的文件', () => selections.forEach(input => { input.checked = true; }), 'small ghost'), list);
    }
    const confirm = bInput(`确认文字（输入 ${preview.confirmText}）`, '', preview.confirmText); d.body.append(confirm.wrap);
    append(d.actions, button('取消', closeModal, 'ghost'), button('备份并执行' + titles[preview.kind], async () => {
      const result = await cAct('expertExecute', { previewToken: preview.token, confirmation: confirm.input.value, paths: [...selections].filter(([, input]) => input.checked).map(([name]) => name) });
      if (result && !result.conflicted) cOutput('操作完成，原内容已保留', `备份编号：${result.backupId}\n救援分支：${result.rescueBranch}\n\n可以在“操作前备份”导出原磁盘文件到空目录；救援分支保留原提交历史。备份中的索引证据不会自动覆盖当前暂存区。`);
    }, 'primary', preview.kind === 'clean' && !preview.candidates.length));
  });
}
function renderCReflog() {
  $('content').append(note('找回版本，不覆盖当前工程', 'reflog 是本机引用变动记录，受 Git 保留期限和对象清理影响。先建立救援分支，再到“分支与草稿”检查；创建救援分支不会切换当前工作区。'));
  if (!E.reflog.items.length) { $('content').append(empty('暂无引用变动记录', '第一次保存或切换版本后，Git 才会留下相应记录。')); return; }
  E.reflog.items.forEach(item => $('content').append(bRow(item.subject, `${item.hash}\n${item.ref}`, [button('建立救援分支', () => {
    const d = modal('建立救援分支'); const name = bInput('救援分支名称', `rescue/recovered-${item.hash.slice(0, 8)}-${Date.now().toString().slice(-5)}`);
    append(d.body, el('pre', 'small-pre', item.hash), name.wrap, el('p', '', '只创建分支，不切换、不覆盖磁盘内容。'));
    append(d.actions, button('取消', closeModal, 'ghost'), button('创建救援分支', () => cAct('expertRescue', { hash: item.hash, name: name.input.value }, '救援分支已建立，当前工程保持原样。'), 'primary'));
  }, 'small soft', writeBlocked())], '本地 reflog')));
}
function renderCBisect() {
  const status = E.overview.bisect;
  $('content').append(note('测试候选版本，保留当前工作区', '本工具采用 Git 的 no-checkout 模式。候选版本在你选择的独立空目录中检出，手工用 Keil 编译或上板测试，再回此处标记结果；不会自动运行测试脚本。'));
  if (status.active) {
    if (!status.managed) { $('content').append(note('检测到其他工具启动的二分任务', '本版只管理自己启动的 no-checkout 任务。请在原工具中完成或中止。')); return; }
    if (status.found) $('content').append(note('找到首个异常提交', status.found + '。这表示你本次正常/异常标记所对应的定位结果；请进一步复核该修改。'));
    else if (status.ambiguous) $('content').append(note('无法唯一定位异常提交', '部分版本被标记为无法测试，Git 目前只能给出候选范围。下方记录包含详细结果；请结束排错并在具备测试条件后重试。'));
    else $('content').append(bRow('待测试候选版本', status.candidate || '暂无候选', [button('在独立目录检出候选', async () => {
      const destination = await run('选择候选工程的空目录…', () => invoke('chooseCloneDestination'));
      if (destination?.path) { const result = await cAct('expertBisectWorktree', { destination: destination.path, candidate: status.candidate, logToken: status.logToken }, '候选版本已在独立目录检出。'); if (result) cOutput('候选工程已就绪', `目录：${result.destination}\n版本：${status.candidate}\n\n在这个目录打开 Keil 工程进行测试；完成后回此处标记结果。此目录与原工程共享 Git 历史，测试中的编辑不会修改原目录。`); }
    }, 'small soft')]));
    if (!status.found && !status.ambiguous) {
      const actions = el('div', 'inline-actions');
      for (const [verdict, label] of [['good', '标记正常'], ['bad', '标记异常'], ['skip', '无法测试，跳过']]) actions.append(button(label, () => cConfirm(label, `请确认已经测试候选 ${status.candidate?.slice(0, 8)}。当前主工程内容不会用于判断测试结果。`, 'expertBisectMark', { verdict, candidate: status.candidate, logToken: status.logToken }), verdict === 'bad' ? 'soft' : ''));
      $('content').append(actions);
    }
    $('content').append(append(card('排错记录'), el('pre', 'c-output', status.log || '暂无记录')), button('结束二分排错', () => cConfirm('结束二分排错', '结束本次 no-checkout 排错；原工程的分支、磁盘文件与独立测试目录继续保留。', 'expertBisectStop', {}), 'soft'));
    return;
  }
  if (E.overview.commits.length < 2) { $('content').append(empty('至少需要两个版本', '选择一个已知正常版本和一个后续异常版本。')); return; }
  const form = card('定义排错范围'), good = cCommitSelect('已知正常版本', E.overview.commits.length - 1), bad = cCommitSelect('已知异常版本');
  append(form, good.wrap, bad.wrap, button('开始手动二分排错', () => cConfirm('开始二分排错', '已知正常：' + good.input.value.slice(0, 8) + '；已知异常：' + bad.input.value.slice(0, 8) + '。启动后当前主工程保持原样。', 'expertBisectStart', { good: good.input.value, bad: bad.input.value }), 'primary', writeBlocked())); $('content').append(form);
}
function renderCBackups() {
  $('content').append(note('磁盘文件和提交历史分别保留', '本页备份包含操作前的普通文件及原始索引证据；rescue/ 分支保留原提交。导出磁盘备份到空目录后可在 Keil 查看和比较；它不包含 .git 历史，也不会自动覆盖当前工程。单文件恢复备份仍在左侧“恢复中心”。'));
  if (!E.backups.items.length) { $('content').append(empty('还没有专家操作备份', '执行重置、清理、修改说明或反向提交时，会先创建备份。')); return; }
  const reasons = { reset: '重置前备份', clean: '清理前备份', amend: '修改说明前备份', revert: '反向提交前备份' }, phases = { prepared: '备份已就绪，尚未确认执行结果', completed: '操作已完成', 'failed-or-partial': '操作未完成或部分完成，请检查' };
  for (const item of E.backups.items) $('content').append(bRow(`${reasons[item.reason] || item.reason} · ${dateText(item.date)}`, `${item.files} 个文件 · ${bytesText(item.bytes)}\n状态：${phases[item.phase] || item.phase}\n原提交：${item.head}\n救援分支：${item.rescueBranch || '无'}`, [button('导出到空目录', async () => {
    const destination = await run('选择备份导出目录…', () => invoke('chooseCloneDestination'));
    if (destination?.path) { const result = await cAct('expertBackupExport', { id: item.id, destination: destination.path }, '备份已导出。'); if (result) cOutput('备份已导出', `${result.files} 个文件\n目录：${result.destination}\n当前工程保持原样。`); }
  }, 'small soft')], item.id));
}
function renderCDiagnose() {
  $('content').append(append(card('只读仓库检查'), el('p', '', '运行 fsck 完整性检查和对象占用统计。不会清理、修复对象，不联网获取依赖，也不判断 STM32 代码是否正确。'), button('开始只读诊断', () => run('正在检查 Git 对象…', async () => { E.report = await invoke('expertDiagnose', params()); render(); }), 'primary')));
  if (E.report) $('content').append(append(card(E.report.passed ? '检查未报告错误' : '发现需要检查的 Git 错误'), el('pre', 'c-output', E.report.statistics + '\n\n' + E.report.output), el('p', '', E.report.scope)));
}
function renderCBundle() {
  $('content').append(note('离线保存整个 Git 历史', '历史包包含所有本地引用可达的提交，也可能包含草稿、远程跟踪及救援历史。它不包含未提交编辑、忽略文件和子模块内容。导出在本机完成，不自动上传或发送。'));
  $('content').append(append(card('导出与验证'), button('导出 .bundle 历史包', async () => {
    const destination = await run('选择离线历史包位置…', () => invoke('chooseExpertBundleSave', params()));
    if (destination?.path) { const result = await cAct('expertBundleExport', { destination: destination.path }, '离线历史包已导出并验证。'); if (result) cOutput('离线历史包已导出', `文件：${result.filePath}\n大小：${bytesText(result.bytes)}\nSHA-256：${result.sha256}\n\n${result.includes}`); }
  }, 'primary', !S.current.head || writeBlocked()), button('验证已有历史包', async () => {
    const file = await run('选择历史包…', () => invoke('chooseExpertBundleOpen', params()));
    if (file?.path) await run('正在验证历史包…', async () => { const result = await invoke('expertBundleVerify', params({ filePath: file.path })); cOutput(result.valid ? '历史包验证通过' : '历史包未通过验证', `${result.output}\n\nSHA-256：${result.sha256}`); });
  }, 'soft')));
}
function renderCCatalog() {
  const box = card(`本机命令目录 · ${E.catalog.items.length} 个条目`); box.append(el('p', '', E.catalog.version + '。目录收录不代表执行功能已实现；未适配条目只能查看说明与帮助。外部组件不自动运行。'));
  const search = el('input'); search.placeholder = '搜索命令、用途或分类'; search.setAttribute('aria-label', '搜索 Git 命令'); box.append(search);
  const list = el('div', 'c-catalog'); box.append(list); const draw = () => {
    const query = search.value.trim().toLowerCase(); list.replaceChildren();
    for (const item of E.catalog.items.filter(item => [item.name, item.description, item.group, item.status].join(' ').toLowerCase().includes(query))) list.append(bRow(item.name, `${item.description}\n${item.group}\n入口：${item.entry}\n范围：${item.scope}\n依赖：${item.dependency}\n影响：${item.risk}`, [button('查看帮助', () => run('正在读取命令帮助…', async () => {
      const result = await invoke('expertHelp', params({ command: item.name })); const d = modal('git ' + item.name, item.status, true);
      append(d.body, el('p', '', item.scope), el('pre', 'c-output', result.text)); append(d.actions, button('关闭', closeModal, 'ghost'), button('打开官方文档', () => run('正在打开官方帮助…', () => invoke('openExpertHelp', params({ command: item.name }))), 'soft', item.kind === 'external'));
    }), 'small ghost')], item.status));
  };
  search.addEventListener('input', draw); draw(); $('content').append(box);
}
