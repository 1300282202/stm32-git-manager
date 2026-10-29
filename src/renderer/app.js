'use strict';

const $ = id => document.getElementById(id);
const S = {
  current: null, projects: { recents: [], discovered: [] }, info: {}, view: 'changes', busy: false,
  selected: new Set(), selectedFile: null, fileFilter: 'all', diffMode: 'working', draft: '', diffRequest: 0,
  commits: [], historyMore: false, historySearch: '', historyHash: null, historyPaths: [], historyPath: null,
  historyMode: 'content', backups: [], logs: [], modalReturnFocus: null, modalError: null,
};
const statusWords = { added: '新增', modified: '修改', deleted: '删除', renamed: '改名', untracked: '新文件', conflict: '冲突' };
const actionWords = { init: '启用版本记录', stage: '加入本次版本', unstage: '移出本次版本', commit: '保存版本', restore: '恢复历史文件', undoRestore: '还原备份', ignoreApply: '更新忽略规则', identity: '设置提交署名', clone: '克隆工程' };

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}
function append(parent, ...children) { for (const child of children.flat()) if (child) parent.append(child); return parent; }
function button(text, fn, className = '', disabled = false) {
  const node = el('button', `button ${className}`, text);
  node.type = 'button'; node.dataset.baseDisabled = String(disabled); node.disabled = disabled || S.busy;
  node.addEventListener('click', fn); return node;
}
function baseDisabled(node, disabled) { node.dataset.baseDisabled = String(disabled); node.disabled = disabled || S.busy; }
function setBusy(busy, label = '') {
  S.busy = busy; $('progress').hidden = !busy; $('progress-label').textContent = label;
  document.querySelectorAll('button').forEach(node => { node.disabled = busy || node.dataset.baseDisabled === 'true'; });
  $('modal').querySelectorAll('input,textarea,select').forEach(node => { node.disabled = busy; });
  document.querySelectorAll('.file-row input,.selection-bar input').forEach(node => { node.disabled = busy; });
}
async function invoke(action, payload = {}) {
  if (!window.stm32?.invoke) throw new Error('本页需要通过“STM32 Git 工程管家”桌面程序打开。');
  const result = await window.stm32.invoke(action, payload);
  if (result?.warning) pendingOperationWarning = result.warning;
  return result;
}
function params(extra = {}) { return { projectPath: S.current?.path, ...extra }; }
function showError(error) {
  const message = error?.message || String(error);
  $('error-message').textContent = message; $('error-banner').hidden = false;
  if ($('modal').open) {
    if (!S.modalError) { S.modalError = el('div', 'error-box'); $('modal-body').append(S.modalError); }
    S.modalError.textContent = message; S.modalError.scrollIntoView({ block: 'nearest' });
  }
}
async function run(label, task) {
  if (S.busy) return;
  setBusy(true, label);
  try { return await task(); }
  catch (error) { showError(error); return undefined; }
  finally { setBusy(false); }
}
let toastTimer;
let pendingOperationWarning = '';
function toast(text) { clearTimeout(toastTimer); const warning = pendingOperationWarning; pendingOperationWarning = ''; $('toast').textContent = warning ? `${text} ${warning}` : text; $('toast').hidden = false; toastTimer = setTimeout(() => { $('toast').hidden = true; }, warning ? 12000 : 4800); }
function dateText(date) {
  if (!date) return '时间未记录';
  const value = new Date(date);
  return Number.isNaN(value.getTime()) ? String(date) : value.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}
function bytesText(bytes) { return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes || 0} B`; }
function splitPath(path) { const i = path.lastIndexOf('/'); return { name: path.slice(i + 1), dir: i >= 0 ? path.slice(0, i) : '工程根目录' }; }
function card(title, extra = null, className = '') {
  const node = el('section', `card ${className}`); const header = el('div', 'card-header');
  append(header, el('h3', '', title), extra); node.append(header); return node;
}
function empty(title, description, symbol = '◫', className = '') {
  const node = el('div', `empty-state ${className}`);
  return append(node, el('div', 'empty-symbol', symbol), el('h3', '', title), el('p', '', description));
}
function loading() { return append(el('div', 'loading-area'), el('span', 'spinner'), el('span', '', '正在读取…')); }
function note(title, description) { return append(el('div', 'workflow-note'), el('span', 'note-icon', '◌'), append(el('div'), el('strong', '', title), el('p', '', description))); }
function pageHeading(title, description, actions = []) {
  return append(el('div', 'page-heading'), append(el('div'), el('h2', '', title), el('p', '', description)), append(el('div', 'heading-actions'), actions));
}
function modal(title, kicker = '工程管家', wide = false) {
  S.modalReturnFocus = document.activeElement; S.modalError = null;
  $('modal-title').textContent = title; $('modal-kicker').textContent = kicker;
  $('modal-body').replaceChildren(); $('modal-actions').replaceChildren(); $('modal').classList.toggle('wide', wide);
  if (!$('modal').open) $('modal').showModal();
  return { body: $('modal-body'), actions: $('modal-actions') };
}
function closeModal() { if (S.busy) return; forceCloseModal(); }
function forceCloseModal() { $('modal').close(); S.modalError = null; S.modalReturnFocus?.focus?.(); }
function segmented(options, active, onChange) {
  const node = el('div', 'segmented');
  for (const [key, label] of options) {
    const b = button(label, () => onChange(key)); b.className = key === active ? 'active' : ''; b.setAttribute('aria-pressed', String(key === active)); node.append(b);
  }
  return node;
}

function updateHeader() {
  const c = S.current;
  $('project-title').textContent = c?.name || '开始记录你的工程';
  $('sidebar-project').textContent = c?.name || '选择工程';
  $('project-path').textContent = c?.path || '选择一个本地工程文件夹';
  $('project-path').title = c?.path ? `点击复制：${c.path}` : '选择工程';
  $('branch-name').textContent = c ? c.isRepo ? c.branch || '游离版本' : '未启用 Git' : '未选择工程';
  $('changes-count').textContent = String(c?.files?.length || 0);
  baseDisabled($('refresh'), !c); baseDisabled($('project-path'), !c);
  baseDisabled($('open-keil'), !c?.keil?.projects?.length);
  document.querySelectorAll('[data-view]').forEach(node => { node.classList.toggle('active', node.dataset.view === S.view); node.setAttribute('aria-current', node.dataset.view === S.view ? 'page' : 'false'); });
  $('status-left').textContent = c ? `${c.isRepo ? '本地仓库' : '本地工程'} · ${c.files?.length || 0} 个文件有变化` : '选择工程即可开始';
  $('status-right').textContent = S.projects.gitVersion || S.info.gitVersion || 'A 阶段 · 本地版本管理';
}
async function loadProject(projectPath) {
  const current = await invoke('inspect', { projectPath });
  S.current = current; S.selected.clear(); S.selectedFile = null; S.draft = ''; S.fileFilter = 'all';
  S.commits = []; S.historyHash = null; S.historyPath = null; S.historyPaths = []; S.backups = []; S.logs = [];
  S.view = 'changes'; $('error-banner').hidden = true;
  S.projects = await invoke('projects'); render();
}
async function refreshState() {
  if (!S.current) return;
  S.current = await invoke('state', params());
  S.selected = new Set([...S.selected].filter(path => S.current.files.some(file => file.path === path)));
  if (!S.current.files.some(file => file.path === S.selectedFile)) S.selectedFile = null;
  if (S.view !== 'changes' && S.view !== 'settings') await loadViewData();
  render();
}
async function chooseProject() { await run('选择工程文件夹…', async () => { const result = await invoke('chooseProject'); if (result.path) { forceCloseModal(); await loadProject(result.path); } }); }
function projectDialog() {
  const d = modal('选择一个工程', '你的本地工作空间');
  d.body.append(el('p', '', '打开已有 Keil 工程，或选择一个准备启用 Git 的文件夹。'));
  const seen = new Set();
  for (const [heading, items] of [['最近打开', S.projects.recents || []], ['发现的 Keil 工程', S.projects.discovered || []]]) {
    const list = items.filter(item => !seen.has(item.path)); if (!list.length) continue;
    d.body.append(el('div', 'modal-section-label', heading));
    for (const item of list) {
      seen.add(item.path); const b = button('', () => run('正在打开工程…', async () => { await loadProject(item.path); forceCloseModal(); })); b.className = 'project-option';
      append(b, el('span', 'project-option-icon', '▱'), append(el('div'), el('strong', '', item.name || item.path.split(/[\\/]/).pop()), el('small', '', item.path)));
      if (S.current?.path === item.path) b.append(el('span', 'pill', '当前')); d.body.append(b);
    }
  }
  const pathInput = el('input'); pathInput.placeholder = '也可以粘贴工程文件夹的完整路径'; pathInput.setAttribute('aria-label', '工程路径');
  const open = () => { const value = pathInput.value.trim().replace(/^"|"$/g, ''); if (value) run('正在打开工程…', async () => { await loadProject(value); forceCloseModal(); }); };
  pathInput.addEventListener('keydown', event => { if (event.key === 'Enter') open(); });
  d.body.append(append(el('div', 'project-path-form'), pathInput, button('打开', open)));
  append(d.actions, button('从远程克隆', cloneDialog, 'ghost'), button('浏览文件夹', chooseProject, 'primary'));
}
function cloneDialog() {
  const d = modal('从远程克隆工程', '下载已有 Git 仓库');
  d.body.append(el('p', '', '填写 HTTPS 或 SSH 仓库地址，选择一个空目录。访问私有仓库需要本机已配置的 Git 凭据。'));
  const url = el('input'); url.placeholder = 'https://example.com/your/project.git'; url.setAttribute('aria-label', '远程仓库地址');
  const dest = el('input'); dest.readOnly = true; dest.placeholder = '选择空文件夹'; dest.setAttribute('aria-label', '克隆目标目录');
  d.body.append(append(el('div', 'form-field'), el('label', 'field-label', '远程仓库地址'), url));
  const picker = button('选择目录', () => run('选择目标目录…', async () => { const result = await invoke('chooseCloneDestination'); if (result.path) dest.value = result.path; }));
  d.body.append(append(el('div', 'project-path-form'), dest, picker));
  append(d.actions, button('返回', projectDialog, 'ghost'), button('开始克隆', () => run('正在克隆工程，请稍候…', async () => {
    if (!url.value.trim() || !dest.value) throw new Error('请填写仓库地址并选择一个空目录。');
    const result = await invoke('clone', { url: url.value.trim(), destination: dest.value });
    await loadProject(result.path || dest.value); forceCloseModal(); toast('工程已下载，可以开始查看版本。');
  }), 'primary'));
}
function render() {
  updateHeader(); $('content').replaceChildren();
  if (!S.current) return renderWelcome();
  if (!S.current.isRepo && S.view !== 'settings') return renderInitialize();
  if ((S.current.parentRepo || S.current.bare) && S.view !== 'settings') return renderUnsupported();
  if (S.view === 'changes') renderChanges();
  else if (S.view === 'history') renderHistory();
  else if (S.view === 'recovery') renderRecovery();
  else if (S.view === 'logs') renderLogs();
  else if (S.view === 'collaboration') renderCollaboration();
  else if (S.view === 'remote') renderRemote();
  else if (S.view === 'expert') renderExpert();
  else if (S.view === 'engineering') renderEngineering();
  else renderSettings();
}
function renderWelcome() {
  const wrapper = el('div', 'onboarding');
  append(wrapper, el('span', 'eyebrow', '给每一个可用版本，留一个位置'), el('h2', 'onboarding-title', '让工程的每次进步，都有迹可循。'), el('p', 'onboarding-copy', '继续在 Keil 中编写代码。在这里检查变化、保存版本，或找回之前的实现。所有日常操作都可以通过按钮完成。'));
  const steps = el('div', 'onboarding-steps');
  for (const [number, title, desc] of [['01', '选择工程', '打开本机的 STM32 工程文件夹'], ['02', '查看变化', '检查代码与工程配置的修改'], ['03', '保存版本', '写一句说明，留下一个清晰的记录']]) append(steps, append(el('div'), el('b', '', number), el('strong', '', title), el('p', '', desc)));
  append(wrapper, steps, append(el('div', 'inline-actions'), button('选择工程文件夹', chooseProject, 'primary'), button('浏览最近工程', projectDialog), button('从远程克隆', cloneDialog, 'ghost'))); $('content').append(wrapper);
}
function renderInitialize() {
  if (S.current.parentRepo || S.current.bare) return renderUnsupported();
  const wrapper = el('div', 'onboarding');
  append(wrapper, el('span', 'eyebrow', '准备你的第一个版本'), el('h2', 'onboarding-title', '这个工程，还没有版本记录。'), el('p', 'onboarding-copy', '启用 Git 后，就可以查看变化并保存版本。启用只建立版本管理目录，第一份正式记录由你选择文件后创建。'));
  const box = card('已识别的工程'); const inner = el('div', 'card-content'); append(inner, infoTable([['工程目录', S.current.path], ['Keil 工程', S.current.keil?.projects?.map(p => p.name).join('、') || '未检测到，可继续管理普通文件'], ['目标芯片', targetInfo()?.device || '未识别']])); box.append(inner); wrapper.append(box);
  append(wrapper, append(el('div', 'inline-actions section-spaced'), button('启用 Git 版本记录', () => run('正在启用 Git…', async () => { S.current = await invoke('init', params()); render(); toast('Git 已启用，接下来检查忽略规则并选择文件。'); }), 'primary'), button('查看工程设置', () => navigate('settings')))); $('content').append(wrapper);
}
function renderUnsupported() {
  const c = S.current; const title = c.bare ? '这是一个裸仓库' : '所选目录属于另一个 Git 仓库';
  const description = c.bare ? 'A 阶段需要包含工作文件的工程目录。请选择正常检出的工程。' : `为避免把子目录误当成完整工程，请打开仓库根目录：${c.repoRoot || c.parentRepo}`;
  const block = empty(title, description, '▱', 'large');
  block.append(button('重新选择工程', projectDialog, 'primary'));
  if (c.repoRoot && !c.bare) block.append(button('打开仓库根目录', () => run('正在打开仓库…', () => loadProject(c.repoRoot)), 'ghost'));
  $('content').append(block);
}
function targetInfo() { return S.current?.keil?.projects?.[0]?.targets?.[0]; }
function writeBlocked() { return Boolean(S.current?.operation || S.current?.files?.some(file => file.conflict)); }
function renderChanges() {
  const c = S.current, files = c.files || [], staged = files.filter(file => file.staged);
  $('content').append(pageHeading('当前修改', '检查文件变化，选择这次要记录的内容。', [button('检查忽略规则', ignoreDialog, 'small')]));
  const stats = el('div', 'stats-row');
  for (const [label, value, symbol, cls] of [['待检查的文件', files.length, '◫', ''], ['已加入本次版本', staged.length, '✓', 'blue'], ['当前记录', c.head ? `${c.head.slice(0, 7)} · 已有版本` : '等待第一个版本', '◷', 'neutral']]) {
    const valueNode = el('strong', `stat-value ${typeof value === 'string' ? 'text-value' : ''}`, value);
    stats.append(append(el('div', 'stat-card'), append(el('div'), el('span', 'stat-label', label), valueNode), el('span', `stat-symbol ${cls}`, symbol)));
  }
  $('content').append(stats);
  if (!c.head) $('content').append(note('第一次记录工程，从一个清晰的起点开始', '先检查忽略规则，再勾选源码和工程配置。“加入版本”后，你可以检查将要保存的内容。'));
  else if (c.operation === '二分排错') { $('content').append(note('当前有正在进行的二分排错', '到“专家工具箱 → 二分排错”测试并标记候选版本，或结束排错。')); $('content').append(button('前往二分排错', () => { E.tab = 'bisect'; navigate('expert'); }, 'soft')); }
  else if (writeBlocked()) { $('content').append(note('当前工程有尚未处理的 Git 操作或冲突', '到“分支与草稿 → 解决冲突”查看双方内容，处理后继续或中止本次操作。')); $('content').append(button('前往解决冲突', () => { B.tab = 'conflicts'; navigate('collaboration'); }, 'soft')); }
  const grid = el('div', 'workspace-grid');
  append(grid, renderFilePanel(), renderDiffPanel(), renderCommitPanel(staged)); $('content').append(grid);
  loadDiff().catch(showError);
}
function visibleFiles() { return (S.current.files || []).filter(file => S.fileFilter === 'staged' ? file.staged : S.fileFilter === 'working' ? file.unstaged || file.untracked : true); }
function renderFilePanel() {
  const visible = visibleFiles();
  if (!S.selectedFile || !S.current.files.some(file => file.path === S.selectedFile)) { S.selectedFile = visible[0]?.path || null; const f = visible[0]; S.diffMode = f?.unstaged || f?.untracked ? 'working' : 'staged'; }
  const panel = card('变化的文件', el('span', 'subcount', `${S.current.files.length} 项`), 'file-panel');
  panel.append(append(el('div', 'file-filters'), segmented([['all', '全部'], ['working', '未加入'], ['staged', '已加入']], S.fileFilter, filter => { S.fileFilter = filter; renderChangesOnly(); })));
  const all = el('input'); all.type = 'checkbox'; all.checked = visible.length > 0 && visible.every(file => S.selected.has(file.path)); all.indeterminate = visible.some(file => S.selected.has(file.path)) && !all.checked; all.setAttribute('aria-label', '选择当前列表的全部文件');
  all.addEventListener('change', () => { for (const f of visible) if (all.checked) S.selected.add(f.path); else S.selected.delete(f.path); renderChangesOnly(); });
  const source = button('选择源码', () => { for (const file of S.current.files) if (/\.(c|h|s|cpp|hpp|uvprojx?|uvoptx?|ioc|ld|sct|dbgconf)$/i.test(file.path) || /(^|\/)\.gitignore$/.test(file.path)) S.selected.add(file.path); renderChangesOnly(); }); source.className = 'link-button';
  append(panel, append(el('div', 'selection-bar'), append(el('label'), all, el('span', '', `已勾选 ${S.selected.size}`)), source));
  const list = el('div', 'file-list');
  if (!visible.length) list.append(empty('这里已经整理好了', S.fileFilter === 'staged' ? '选中文件后，点击“加入版本”。' : '保存 Keil 中的代码后，点击右上角刷新。', '✓', 'compact'));
  for (const file of visible) {
    const row = el('div', `file-row ${S.selectedFile === file.path ? 'active' : ''}`); row.tabIndex = 0; row.setAttribute('role', 'button'); row.setAttribute('aria-label', `查看 ${file.path} 的差异`); row.title = file.originalPath ? `${file.originalPath} → ${file.path}` : file.path;
    const select = () => { S.selectedFile = file.path; S.diffMode = file.unstaged || file.untracked ? 'working' : 'staged'; renderChangesOnly(); };
    row.addEventListener('click', select); row.addEventListener('keydown', event => { if (event.target === row && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); select(); } });
    const checkbox = el('input'); checkbox.type = 'checkbox'; checkbox.checked = S.selected.has(file.path); checkbox.setAttribute('aria-label', `勾选 ${file.path}`); checkbox.disabled = S.busy;
    checkbox.addEventListener('click', event => event.stopPropagation()); checkbox.addEventListener('change', () => { if (checkbox.checked) S.selected.add(file.path); else S.selected.delete(file.path); renderChangesOnly(); });
    const parts = splitPath(file.path), status = file.conflict ? 'conflict' : file.kind || (file.untracked ? 'untracked' : 'modified');
    const description = file.staged && (file.unstaged || file.untracked) ? '已加入版本 · 又有修改' : file.staged ? '已加入本次版本' : file.untracked ? '尚未记录的新文件' : '尚未加入版本';
    append(row, checkbox, append(el('div', 'file-name-wrap'), el('div', 'file-name', parts.name), el('div', 'file-directory', parts.dir), el('div', 'file-state-label', description)), el('span', `status-letter ${status}`, statusWords[status] || '修改')); list.append(row);
  }
  panel.append(list);
  const selected = S.current.files.filter(file => S.selected.has(file.path));
  const stage = selected.filter(file => file.unstaged || file.untracked), unstage = selected.filter(file => file.staged);
  panel.append(append(el('div', 'file-actions'), button('＋ 加入版本', () => mutateSelection('stage', stage), 'soft', !stage.length || writeBlocked()), button('移出版本', () => mutateSelection('unstage', unstage), '', !unstage.length || writeBlocked())));
  return panel;
}
function renderChangesOnly() { if (S.view === 'changes') { $('content').replaceChildren(); renderChanges(); } }
async function mutateSelection(action, files) {
  await run(action === 'stage' ? '正在加入本次版本…' : '正在移出本次版本…', async () => {
    S.current = await invoke(action, params({ paths: files.map(file => file.path), token: S.current.token })); S.selected.clear(); render();
    toast(action === 'stage' ? `${files.length} 个文件已加入本次版本。` : '已移出本次版本，磁盘上的文件内容仍保留。');
  });
}
function renderDiffPanel() {
  const panel = el('section', 'card diff-panel'); const header = el('div', 'diff-header');
  append(header, append(el('div', 'diff-title-wrap'), el('div', 'diff-title', S.selectedFile || '文件差异'), el('div', 'diff-subtitle', '点击左侧文件，检查实际变化')), segmented([['working', '未加入的修改'], ['staged', '本次版本内容']], S.diffMode, mode => { S.diffMode = mode; renderChangesOnly(); })); panel.append(header);
  const body = el('div'); body.id = 'diff-body'; body.append(S.selectedFile ? loading() : empty('每一处变化，都看得清楚', '选择左侧文件，在这里查看代码差异。', '≠')); panel.append(body); return panel;
}
function renderCode(result, isDiff = true) {
  const wrapper = el('div');
  if (result.binary) return empty('这是一个二进制文件', `文件大小 ${bytesText(result.bytes)}。内容会按原始字节保存，无法逐行显示。`, '▧');
  const toolbar = el('div', 'code-toolbar');
  append(toolbar, el('span', '', result.encoding || 'UTF-8'), isDiff ? append(el('div', 'code-legend'), append(el('span'), el('i', 'legend-dot'), el('span', '', '新增')), append(el('span'), el('i', 'legend-dot removed'), el('span', '', '删除'))) : el('span', '', '只读预览'));
  wrapper.append(toolbar);
  if (!result.text) { wrapper.append(empty(isDiff ? '当前比较范围没有差异' : '这是一个空文件', isDiff ? '可以切换“未加入的修改”和“本次版本内容”查看。' : '文件内容为空。', '✓')); return wrapper; }
  const code = el('div', 'code-view'); code.tabIndex = 0; code.setAttribute('aria-label', isDiff ? '代码差异，只读' : '文件内容，只读');
  let index = 0;
  for (const line of String(result.text).split('\n')) {
    let cls = '';
    if (isDiff) cls = line.startsWith('@@') ? 'hunk' : /^(diff |index |--- |\+\+\+ |new file|deleted file|similarity |rename )/.test(line) ? 'meta' : line.startsWith('+') ? 'addition' : line.startsWith('-') ? 'deletion' : '';
    code.append(append(el('div', `code-line ${cls}`), el('span', 'code-number', ++index), el('span', 'code-text', line.replace(/\r$/, ''))));
  }
  wrapper.append(code); if (result.truncated) wrapper.append(el('div', 'code-footnote', '内容较长，当前仅预览部分内容。原文件不会被截断。')); return wrapper;
}
async function loadDiff() {
  const id = ++S.diffRequest, projectPath = S.current?.path, path = S.selectedFile, mode = S.diffMode;
  if (!path || !projectPath) return;
  const result = await invoke('diff', { projectPath, path, mode });
  if (id !== S.diffRequest || S.view !== 'changes' || S.current?.path !== projectPath || !$('diff-body')) return;
  $('diff-body').replaceChildren(renderCode(result, true));
}
function renderCommitPanel(staged) {
  const panel = card('保存一个新版本', el('span', 'pill muted', '本地'), 'commit-panel');
  const body = el('div', 'commit-body');
  body.append(append(el('div', 'step-label'), el('span', 'step-circle', '02'), el('span', '', '为这次进步留一句说明')));
  const label = el('label', 'field-label', '版本说明'); label.htmlFor = 'commit-message'; body.append(label);
  const textarea = el('textarea'); textarea.id = 'commit-message'; textarea.placeholder = '例如：完成按键消抖，单击只触发一次'; textarea.value = S.draft;
  textarea.addEventListener('input', () => { S.draft = textarea.value; const b = $('review-commit'); if (b) baseDisabled(b, !S.draft.trim() || !staged.length || writeBlocked() || !S.current.identity?.name || !S.current.identity?.email); }); body.append(textarea);
  body.append(el('p', 'field-help', '写清楚做了什么，日后会更容易找到。'));
  const summary = el('div', 'staged-summary'); append(summary, el('strong', '', `${staged.length} 个文件`), el('span', '', ' 将被记录'));
  const list = el('ul', 'mini-files'); for (const file of staged.slice(0, 12)) list.append(el('li', '', file.path)); if (staged.length > 12) list.append(el('li', '', `以及其他 ${staged.length - 12} 个文件`)); summary.append(list); body.append(summary);
  if (!S.current.identity?.name || !S.current.identity?.email) { body.append(el('div', 'attention-inline', '请先在“工程设置”中填写提交姓名和邮箱。')); body.append(button('设置提交署名', () => navigate('settings'), 'small')); }
  const review = button('预览并保存版本 →', reviewCommit, 'primary full', !S.draft.trim() || !staged.length || writeBlocked() || !S.current.identity?.name || !S.current.identity?.email); review.id = 'review-commit'; body.append(review);
  body.append(el('p', 'commit-hint', '请先保存 Keil 中的编辑内容。这里只记录已加入版本的文件；版本保存在本机。')); panel.append(body);
  const target = targetInfo(), metadata = el('div', 'project-info-small'); metadata.append(el('div', 'info-title', '工程信息'));
  for (const [key, value] of [['芯片', target?.device || '未识别'], ['目标', target?.name || '未识别'], ['验证状态', '由你编译与上板确认']]) metadata.append(append(el('div', 'info-pair'), el('span', '', key), el('strong', '', value))); panel.append(metadata); return panel;
}
function reviewCommit() {
  const staged = S.current.files.filter(file => file.staged); const token = S.current.token, projectPath = S.current.path, message = S.draft.trim();
  const d = modal('确认这一次记录', '保存本地版本');
  d.body.append(el('p', '', `本次将记录暂存区中的 ${staged.length} 个文件。请确认版本说明和文件清单。`)); d.body.append(el('div', 'review-summary', message));
  const list = el('ul', 'review-files'); for (const file of staged) list.append(el('li', '', `${statusWords[file.kind] || '修改'}  ${file.path}`)); d.body.append(list);
  d.body.append(el('p', '', '“编译通过”或“上板通过”需要你实际验证。工具不会根据提交说明自动判定程序正确。'));
  append(d.actions, button('返回检查', closeModal, 'ghost'), button('确认保存版本', () => run('正在保存版本…', async () => {
    const result = await invoke('commit', { projectPath, message, token }); S.current = result.state; S.draft = ''; S.selected.clear(); S.selectedFile = null;
    forceCloseModal(); render(); toast(`版本已保存 · ${result.hash.slice(0, 7)}`);
  }), 'primary'));
}

async function navigate(view) {
  if (S.busy) return;
  S.view = view; render();
  if (S.current?.isRepo && !S.current.parentRepo && !S.current.bare && ['history', 'recovery', 'logs', 'collaboration', 'remote', 'expert', 'engineering'].includes(view)) await run('正在读取记录…', async () => { await loadViewData(); render(); });
}
async function loadViewData() {
  if (S.view === 'history') await fetchHistory(false);
  else if (S.view === 'recovery') S.backups = (await invoke('backups', params())).backups || [];
  else if (S.view === 'logs') S.logs = (await invoke('logs', params())).logs || [];
  else if (S.view === 'collaboration') await loadCollaboration();
  else if (S.view === 'remote') await loadRemotes();
  else if (S.view === 'expert') await loadExpert();
  else if (S.view === 'engineering') await loadEngineering();
}
async function fetchHistory(more) {
  const result = await invoke('history', params({ skip: more ? S.commits.length : 0, limit: 40, search: S.historySearch }));
  S.commits = more ? [...S.commits, ...result.commits] : result.commits;
  S.historyMore = result.hasMore;
  if (!S.commits.some(commit => commit.hash === S.historyHash)) {
    S.historyHash = S.commits[0]?.hash || null; S.historyPath = null; S.historyPaths = [];
    if (S.historyHash) await fetchHistoryFiles();
  }
}
async function fetchHistoryFiles() {
  if (!S.historyHash) return;
  const result = await invoke('historyFiles', params({ hash: S.historyHash }));
  S.historyPaths = result.files || [];
  if (!S.historyPaths.some(file => file.path === S.historyPath)) S.historyPath = S.historyPaths.find(file => /(^|\/)main\.c$/i.test(file.path))?.path || S.historyPaths[0]?.path || null;
}
function renderHistory() {
  const input = el('input', 'search-input'); input.placeholder = '搜索版本说明，按 Enter'; input.value = S.historySearch; input.setAttribute('aria-label', '搜索版本历史');
  const search = () => run('正在搜索版本…', async () => { S.historySearch = input.value.trim(); S.historyHash = null; await fetchHistory(false); render(); });
  input.addEventListener('keydown', event => { if (event.key === 'Enter') search(); });
  $('content').append(pageHeading('版本历史', '每一次提交，都是一个可以回看的工程节点。', [input, button('搜索', search, 'small'), button('移植这个提交', () => bCherryPickDialog(S.historyHash), 'small', !S.historyHash || writeBlocked()), button('标记标签', () => bTagDialog(S.historyHash), 'small', !S.historyHash || writeBlocked()), button('导出源码', () => bExportDialog(S.historyHash), 'small soft', !S.historyHash)]));
  if (!S.commits.length) {
    $('content').append(append(el('section', 'card'), empty(S.historySearch ? '没有找到匹配的版本' : '第一份版本记录，等你来创建', S.historySearch ? '换一个关键词，或者清空搜索查看全部记录。' : '回到“当前修改”，选择文件并保存版本后，这里就会出现时间线。', '◷', 'large'))); return;
  }
  const grid = el('div', 'history-layout'), timeline = card('版本时间线', el('span', 'subcount', `${S.commits.length} 条`));
  const timelineList = el('div', 'history-list');
  for (const commit of S.commits) {
    const item = button('', () => run('正在读取历史版本…', async () => { S.historyHash = commit.hash; S.historyPaths = []; S.historyPath = null; await fetchHistoryFiles(); render(); }));
    item.className = `history-item ${commit.hash === S.historyHash ? 'active' : ''}`;
    append(item, el('div', 'history-subject', commit.subject || '(无说明)'), append(el('div', 'history-meta'), el('span', 'history-hash', commit.shortHash || commit.hash.slice(0, 7)), el('span', '', commit.author), el('span', '', dateText(commit.date)))); timelineList.append(item);
  }
  timeline.append(timelineList);
  if (S.historyMore) timeline.append(append(el('div', 'card-content'), button('加载更早版本', () => run('正在读取更多版本…', async () => { await fetchHistory(true); render(); }), 'full small')));
  const files = card('这个版本中的文件', el('span', 'subcount', `${S.historyPaths.length}`));
  const list = el('div', 'history-files');
  for (const file of S.historyPaths) {
    const item = button(file.path, () => { S.historyPath = file.path; render(); }); item.className = `history-file ${S.historyPath === file.path ? 'active' : ''}`; item.title = file.path; list.append(item);
  }
  if (!S.historyPaths.length) list.append(empty('没有可预览的普通文件', '这个版本中可能只有特殊文件或子模块。', '▧', 'compact')); files.append(list);
  const viewer = el('section', 'card history-detail');
  const header = el('div', 'diff-header');
  append(header, append(el('div', 'diff-title-wrap'), el('div', 'diff-title', S.historyPath || '历史文件'), el('div', 'diff-subtitle', `版本 ${S.historyHash?.slice(0, 7) || ''} · 只读查看`)), button('恢复这个文件', restoreDialog, 'small soft', !S.historyPath || writeBlocked())); viewer.append(header);
  const tabs = append(el('div', 'file-filters'), segmented([['content', '完整文件'], ['diff', '该版本的修改']], S.historyMode, mode => { S.historyMode = mode; render(); })); viewer.append(tabs);
  const body = el('div'); body.id = 'history-content'; body.append(S.historyPath ? loading() : empty('选择一个历史文件', '在中间列表中选择需要查看的文件。', '◫')); viewer.append(body);
  append(grid, timeline, files, viewer); $('content').append(grid); loadHistoryContent().catch(showError);
}
async function loadHistoryContent() {
  const id = ++S.diffRequest, projectPath = S.current?.path, hash = S.historyHash, path = S.historyPath, mode = S.historyMode;
  if (!hash || !path) return;
  const result = mode === 'diff' ? await invoke('diff', { projectPath, path, mode: 'commit', hash }) : await invoke('readFile', { projectPath, path, source: 'commit', hash });
  if (id !== S.diffRequest || S.view !== 'history' || S.current?.path !== projectPath || !$('history-content')) return;
  $('history-content').replaceChildren(renderCode(result, mode === 'diff'));
}
async function restoreDialog() {
  await run('正在准备恢复预览…', async () => {
    const projectPath = S.current.path, path = S.historyPath, hash = S.historyHash;
    const preview = await invoke('restorePreview', { projectPath, path, hash });
    const d = modal('先比较，再恢复', '恢复单个文件 · 自动备份', true);
    d.body.append(el('p', '', `${path}  ←  版本 ${hash.slice(0, 7)}`));
    d.body.append(el('div', 'warning-box', '确认后，工具会先备份当前磁盘文件，再用历史内容覆盖它。暂存区保持原状，恢复结果需要你检查后重新提交。'));
    const columns = el('div', 'restore-columns');
    append(columns, append(el('div', 'restore-column'), el('h4', '', '当前磁盘内容 · 将先备份'), renderCode(preview.current, false)), append(el('div', 'restore-column'), el('h4', '', '历史版本内容 · 将恢复'), renderCode(preview.target, false))); d.body.append(columns);
    const confirm = el('input'); confirm.type = 'checkbox'; confirm.id = 'restore-saved-check';
    d.body.append(append(el('label', 'restore-confirm'), confirm, el('span', '', '我已保存 Keil 中的编辑内容，并确认要覆盖这个文件。')));
    const execute = button('备份并恢复文件', () => run('正在备份并恢复文件…', async () => {
      const result = await invoke('restore', { projectPath, path, hash, token: preview.token });
      S.current = result.state; S.view = 'changes'; S.selectedFile = path; S.diffMode = 'working'; forceCloseModal(); render();
      toast('文件已恢复，原内容已备份。请在 Keil 重新加载并验证。');
    }), 'primary', true);
    confirm.addEventListener('change', () => baseDisabled(execute, !confirm.checked));
    append(d.actions, button('取消', closeModal, 'ghost'), execute);
  });
}
function renderRecovery() {
  $('content').append(pageHeading('恢复中心', '覆盖文件前的备份，会保存在工程外的应用数据目录。'));
  $('content').append(note('恢复有依据，操作有记录', '还原备份前会再次检查文件状态；如果文件后来又被修改，工具会停止覆盖，保护新的工作。'));
  if (!S.backups.length) { $('content').append(append(el('section', 'card'), empty('目前没有备份记录', '从历史版本恢复文件或应用忽略规则时，工具会保存需要的备份。', '↶', 'large'))); return; }
  for (const record of S.backups) {
    const item = el('section', 'card list-card');
    const description = actionWords[record.reason] || record.reason || '操作前备份';
    const main = append(el('div', 'record-main'), el('h3', '', record.path), append(el('div', 'record-meta'), el('p', '', dateText(record.date)), el('p', '', description)), el('p', '', `备份编号 ${record.id}`));
    const undo = button(record.canUndo ? '还原这份备份' : '已保留备份', () => undoDialog(record), 'small', !record.canUndo);
    if (!record.canUndo) undo.title = '当前文件与备份后的状态不同，不能直接覆盖；备份文件仍然保留。';
    append(item, el('div', 'record-icon', '↶'), main, undo); $('content').append(item);
  }
}
function undoDialog(record) {
  const projectPath = S.current.path; const d = modal('还原操作前的内容', '备份恢复');
  d.body.append(el('p', '', `文件：${record.path}`)); d.body.append(el('p', '', `备份时间：${dateText(record.date)}`));
  d.body.append(el('div', 'warning-box', record.willRemove
    ? '这份备份记录的是“文件尚不存在”。确认后将先备份当前文件，再移除它，使磁盘回到当时的状态。暂存区不会被修改。'
    : '工具将再次备份当前文件，然后恢复备份中的原始内容。若当前内容在上次操作后又发生变化，工具会拒绝覆盖。暂存区不会被修改。'));
  append(d.actions, button('取消', closeModal, 'ghost'), button('确认还原备份', () => run('正在还原备份…', async () => {
    const result = await invoke('undoRestore', { projectPath, backupId: record.id }); S.current = result.state;
    S.backups = (await invoke('backups', { projectPath })).backups; forceCloseModal(); render(); toast('操作前的文件状态已还原。');
  }), 'primary'));
}
function renderLogs() {
  $('content').append(pageHeading('操作记录', '查看这个工程最近的操作结果，最多显示 200 条。'));
  if (!S.logs.length) { $('content').append(append(el('section', 'card'), empty('还没有操作记录', '保存版本、修改设置、恢复文件后，这里会记录结果。', '≡', 'large'))); return; }
  const wrapper = el('section', 'card'), table = el('table', 'log-table'), head = el('thead'), row = el('tr');
  for (const title of ['时间', '操作', '说明', '结果']) row.append(el('th', '', title)); head.append(row); table.append(head);
  const body = el('tbody');
  for (const record of S.logs) { const r = el('tr'); append(r, el('td', '', dateText(record.date)), el('td', '', actionWords[record.action] || record.action), el('td', '', record.summary), append(el('td'), el('span', `pill ${record.success ? '' : 'failed'}`, record.success ? '已完成' : '未完成'))); body.append(r); }
  table.append(body); wrapper.append(table); $('content').append(wrapper);
}
function infoTable(items) { const table = el('table', 'info-table'); const body = el('tbody'); for (const [name, value] of items) body.append(append(el('tr'), el('th', '', name), el('td', '', value || '—'))); table.append(body); return table; }
function renderSettings() {
  const c = S.current;
  $('content').append(pageHeading('工程设置', '设置仅应用于当前工程。根据真实工程结构生成忽略建议。', [button('打开文件夹', () => run('正在打开文件夹…', () => invoke('openFolder', params())), 'small')]));
  const grid = el('div', 'settings-grid'), left = el('div'), right = el('div');
  const identity = card('提交署名', el('span', 'pill muted', '当前工程')); const form = el('form', 'card-content');
  const name = el('input'); name.id = 'identity-name'; name.value = c.identity?.name || ''; name.autocomplete = 'name'; name.placeholder = '你的名字';
  const email = el('input'); email.id = 'identity-email'; email.value = c.identity?.email || ''; email.type = 'email'; email.autocomplete = 'email'; email.placeholder = 'name@example.com';
  const nameLabel = el('label', 'field-label', '姓名'); nameLabel.htmlFor = name.id; const emailLabel = el('label', 'field-label', '邮箱'); emailLabel.htmlFor = email.id;
  append(form, append(el('div', 'form-field'), nameLabel, name), append(el('div', 'form-field'), emailLabel, email), el('p', 'field-help', '这会写入提交记录，用于标识作者。它不是远程账号登录。'));
  const save = button('保存当前工程署名', () => { if (!form.reportValidity()) return; run('正在保存提交署名…', async () => { S.current = await invoke('identity', params({ name: name.value.trim(), email: email.value.trim() })); render(); toast('当前工程的提交署名已保存。'); }); }, 'primary', !c.isRepo || Boolean(c.parentRepo || c.bare));
  save.classList.add('section-spaced'); form.append(save); form.addEventListener('submit', event => event.preventDefault()); identity.append(form); left.append(identity);
  const ignore = card('编译产物与忽略规则'); const ignoreBody = el('div', 'card-content');
  append(ignoreBody, el('p', 'muted-text', '根据 Keil 工程配置识别输出目录，预览哪些文件会被忽略。现有规则会保留，源码不会因为建议被自动删除。'), button('预览忽略规则', ignoreDialog, 'soft', !c.isRepo || Boolean(c.parentRepo || c.bare))); ignore.append(ignoreBody); left.append(ignore);
  const keil = card('Keil 工程识别', el('span', 'pill', `${c.keil?.projects?.length || 0} 个工程`)); const keilBody = el('div', 'card-content');
  if (!c.keil?.projects?.length) keilBody.append(el('p', 'muted-text', '没有找到 .uvproj/.uvprojx 文件，仍可管理普通 Git 文件。'));
  for (const project of c.keil?.projects || []) {
    keilBody.append(el('div', 'keil-project-title', project.name || project.path));
    for (const target of project.targets || []) keilBody.append(infoTable([['目标', target.name], ['芯片', target.device], ['编译器', target.compiler], ['输出目录', target.outputDir], ['列表目录', target.listingDir]]));
  }
  for (const warning of c.keil?.warnings || []) keilBody.append(el('div', 'attention-inline', warning)); keil.append(keilBody); right.append(keil);
  const local = card('本地环境'); local.append(append(el('div', 'card-content'), infoTable([['工程目录', c.path], ['仓库根目录', c.repoRoot], ['Git', S.projects.gitVersion || S.info.gitVersion], ['工具版本', S.info.version || '0.1.0'], ['记录与备份', S.projects.dataDir || S.info.dataDir]]))); right.append(local);
  append(grid, left, right); $('content').append(grid);
}
async function ignoreDialog() {
  if (!S.current) return;
  await run('正在分析工程输出目录…', async () => {
    const projectPath = S.current.path, preview = await invoke('ignorePreview', { projectPath });
    const d = modal('检查忽略规则', '保留源码，略过可重新生成的文件');
    d.body.append(el('p', '', '以下建议来自当前 Keil 工程配置。勾选后会追加到 .gitignore，已有内容会保留；写入前会建立备份。'));
    for (const warning of preview.warnings || []) d.body.append(el('div', 'warning-box', warning));
    const rules = new Set(preview.rules || []), list = el('div', 'rule-list');
    const apply = button('应用所选规则', () => run('正在备份并更新忽略规则…', async () => {
      S.current = await invoke('ignoreApply', { projectPath, rules: [...rules], token: preview.token }); forceCloseModal(); render(); toast('忽略规则已更新。需要时将 .gitignore 一起保存到版本中。');
    }), 'primary', !rules.size);
    for (const rule of preview.rules || []) {
      const checkbox = el('input'); checkbox.type = 'checkbox'; checkbox.checked = true;
      checkbox.addEventListener('change', () => { if (checkbox.checked) rules.add(rule); else rules.delete(rule); baseDisabled(apply, !rules.size); });
      list.append(append(el('label', 'rule-item'), checkbox, el('span', '', rule)));
    }
    if (preview.rules?.length) d.body.append(list); else d.body.append(el('div', 'review-summary', '现有规则已包含建议项，无需追加。'));
    d.body.append(el('div', 'modal-section-label', `全部建议规则匹配的文件 · ${preview.matchedFiles?.length || 0} 项`));
    d.body.append(el('pre', 'small-pre', preview.matchedFiles?.length ? preview.matchedFiles.slice(0, 180).join('\n') + (preview.matchedFiles.length > 180 ? '\n…更多文件未展开' : '') : '当前没有匹配文件。以后生成到这些目录的文件会被忽略。'));
    d.body.append(el('p', '', '已被 Git 跟踪的文件不会因为新增忽略规则自动停止跟踪。'));
    append(d.actions, button('取消', closeModal, 'ghost'), apply);
  });
}

async function openKeil() {
  const projects = S.current?.keil?.projects || [];
  if (projects.length <= 1) return run('正在打开 Keil…', async () => { await invoke('openKeil', params({ keilProjectPath: projects[0]?.path })); toast('已请求打开 Keil 工程。'); });
  const d = modal('选择要打开的 Keil 工程');
  for (const project of projects) {
    const b = button(project.name || project.path, () => run('正在打开 Keil…', async () => { await invoke('openKeil', params({ keilProjectPath: project.path })); forceCloseModal(); })); b.className = 'project-option'; d.body.append(b);
  }
  d.actions.append(button('取消', closeModal, 'ghost'));
}
async function startup() {
  $('project-switch').addEventListener('click', projectDialog);
  $('open-keil').addEventListener('click', openKeil);
  $('refresh').addEventListener('click', () => run('正在刷新工程…', refreshState));
  $('project-path').addEventListener('click', async () => {
    if (!S.current?.path) return;
    try { await navigator.clipboard.writeText(S.current.path); toast('工程路径已复制。'); }
    catch { const d = modal('工程路径'); const input = el('input'); input.value = S.current.path; input.readOnly = true; input.className = 'full'; d.body.append(input); input.select(); d.actions.append(button('关闭', closeModal)); }
  });
  $('dismiss-error').addEventListener('click', () => { $('error-banner').hidden = true; });
  $('modal-close').addEventListener('click', closeModal);
  $('modal').addEventListener('cancel', event => { event.preventDefault(); closeModal(); });
  $('modal').addEventListener('click', event => { if (event.target === $('modal')) { const r = $('modal').getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) closeModal(); } });
  document.querySelectorAll('[data-view]').forEach(node => node.addEventListener('click', () => navigate(node.dataset.view)));
  let focusRefreshTimer;
  window.addEventListener('focus', () => {
    clearTimeout(focusRefreshTimer);
    focusRefreshTimer = setTimeout(() => {
      if (S.current && !S.busy && !$('modal').open) run('正在检查外部文件变化…', refreshState);
    }, 300);
  });
  render();
  await run('正在读取本地工程…', async () => {
    const results = await Promise.all([invoke('projects'), invoke('appInfo')]); S.projects = results[0]; S.info = results[1];
    const initial = S.projects.recents?.[0] || S.projects.discovered?.[0];
    if (initial?.path) await loadProject(initial.path); else render();
  });
}
window.addEventListener('unhandledrejection', event => { event.preventDefault(); showError(event.reason); });
startup().catch(showError);
