'use strict';
const D = { root: null, tab: 'builds', data: { projects: [], builds: [], archives: [], checkpoints: [], settings: {} }, note: null, pollTimer: null, pollBusy: false, lfs: null };
const dPhase = { preparing: '准备快照', running: '正在编译', completed: '编译已结束', failed: '执行失败', cancelled: '已取消', 'timed-out': '超时', interrupted: '上次任务未确认完成' };
Object.assign(actionWords, { engineeringSettings: '保存工程扩展设置', engineeringBuildStart: '开始快照编译', engineeringVerification: '记录手工验证', engineeringArchive: '归档构建产物', engineeringArchiveExport: '导出固件归档', engineeringNoteSave: '保存工程笔记', engineeringCheckpoint: '保存本地检查点', engineeringCheckpointDelete: '检查点移至回收站' });
async function loadEngineering() {
  const root = S.current.path, data = await invoke('engineeringOverview', { projectPath: root }); if (root !== S.current.path) return;
  if (D.root !== root) { D.note = null; D.lfs = null; clearTimeout(D.pollTimer); }
  D.root = root; D.data = data;
  if (data.activeBuild) dPoll(root, data.activeBuild);
}
async function dAct(action, payload = {}, success = '操作完成。') {
  return run('正在处理工程记录…', async () => { const result = await invoke(action, params(payload)); S.current = await invoke('state', params()); await loadEngineering(); forceCloseModal(); render(); toast(success); return result; });
}
function dConfirm(title, text, action, payload, success) {
  const d = modal(title, 'D1 · 工程扩展'); d.body.append(el('p', '', text)); append(d.actions, button('取消', closeModal, 'ghost'), button('确认' + title, () => dAct(action,payload,success), 'primary'));
}
async function dPoll(root, id) {
  if (root !== S.current?.path) return; clearTimeout(D.pollTimer);
  if (D.pollBusy) { D.pollTimer = setTimeout(() => dPoll(root,id),250); return; }
  D.pollBusy = true;
  try {
    const build = await invoke('engineeringBuildPoll', { projectPath: root, buildId: id }); if (D.root !== root) return;
    const index = D.data.builds.findIndex(item => item.id === id); if (index >= 0) D.data.builds[index] = build; else D.data.builds.unshift(build);
    if (['running','preparing'].includes(build.phase)) D.pollTimer = setTimeout(() => dPoll(root,id), 2000);
    else { D.data.activeBuild = null; toast(build.result?.passed ? '快照编译结束，请检查日志及产物。' : '构建未通过或未完成，请查看日志。'); }
    if (S.view === 'engineering' && D.tab === 'builds' && !$('modal').open) render();
  } catch (e) { if (S.view === 'engineering') showError(e); } finally { D.pollBusy = false; }
}
function renderEngineering() {
  $('content').append(pageHeading('构建与工程记录', 'D1：把磁盘快照、编译日志、产物和手工验证结果关联起来。'));
  $('content').append(append(el('div','b-tabs'),segmented([['builds','Keil 编译'],['archives','固件归档'],['notes','工程笔记'],['checkpoints','本地检查点'],['extensions','扩展与迁移']],D.tab,tab=>{D.tab=tab;render();})));
  if (D.root !== S.current.path) { $('content').append(loading()); return; }
  if (D.tab === 'builds') renderDBuilds(); else if (D.tab === 'archives') renderDArchives(); else if (D.tab === 'notes') renderDNotes(); else if (D.tab === 'checkpoints') renderDCheckpoints(); else renderDExtensions();
}
function renderDBuilds() {
  const section = card('选择工程与 Target'), available = D.data.projects.flatMap(project => project.targets), select = el('select'); select.setAttribute('aria-label','构建工程与 Target');
  available.forEach((target,i)=>{const option=el('option','',`${target.project} · ${target.name} · ${target.device}`);option.value=i;select.append(option);});
  append(section, el('p','d-muted','Keil：'+(D.data.settings.keilPath || '未检测到，请选择 UV4.exe')), button('选择 Keil 安装位置',async()=>{const result=await run('选择 Keil…',()=>invoke('chooseKeilExecutable',params()));if(result?.path)await dAct('engineeringSettings',{keilPath:result.path},'Keil 位置已保存。');},'small ghost'));
  if (available.length) append(section,select,button('重新编译快照',()=>{
    const target=available[Number(select.value)],d=modal('重新编译工程快照','D1 · 编译前检查');
    append(d.body,el('pre','small-pre',`工程：${target.project}\nTarget：${target.name}\n芯片：${target.device}\n编译器记录：${target.compiler}\nHEX 输出：${target.createHex?'已启用':'未启用，仅按实际生成的产物显示'}`),el('p','','请先在 Keil 保存文件。本次编译复制磁盘文件、排除旧输出，在独立短路径目录中重新编译；不会烧录或自动提交。'));
    if(target.blocked.length)d.body.append(note('该配置暂不能隔离编译',target.blocked.join('；')));
    append(d.actions,button('取消',closeModal,'ghost'),button('开始快照编译',async()=>{const result=await dAct('engineeringBuildStart',{project:target.project,target:target.name,mode:'rebuild',token:S.current.token},'编译任务已启动。');if(result){D.data.activeBuild=result.buildId;dPoll(S.current.path,result.buildId);}},'primary',Boolean(target.blocked.length)));
  },'primary',Boolean(D.data.activeBuild)||writeBlocked()));
  else section.append(note('没有找到可用的 .uvprojx',D.data.projects.map(item=>item.error||item.project).join('；')||'请选择包含 Keil 工程的实际工程目录；笔记、检查点等功能仍可使用。'));
  $('content').append(section);
  for(const build of D.data.builds){
    const passed=build.result?.passed, busy=['preparing','running'].includes(build.phase),title=busy?dPhase[build.phase]:passed?(build.result.warnings?'编译通过（有警告）':'编译通过'):(build.phase==='completed'?'编译失败':dPhase[build.phase]||'编译失败');
    const info=`${build.target} · ${build.device} · ${dateText(build.date)}\n${build.source.commitBound?'提交 '+build.source.head?.slice(0,8):'包含未提交或未跟踪文件的磁盘快照'}\n快照：${build.source.hash.slice(0,16)}\n${busy?'构建进行中':build.currentMatches?'当前工程与该快照一致':'当前工程已变化，该记录不代表当前版本验证通过'}${build.execution==='test-simulation'?'\n模拟测试构建，不能作为真实编译证明':''}`;
    const actions=[button('查看日志',()=>run('读取构建日志…',async()=>{const result=await invoke('engineeringBuildPoll',params({buildId:build.id}));cOutput('构建日志',`${dPhase[result.phase]||result.phase}\n退出码：${result.exitCode??'尚无'}\n${result.error||''}\n\n${result.log||'尚未获得构建日志。启动进程不代表编译通过。请先在 Keil 打开原工程，确认编译器、设备包和许可证可用，并核对本工具选用的 UV4.exe 位置。'}`);}), 'small ghost')];
    if(busy)actions.push(button('取消本次编译',()=>run('请求取消…',async()=>{await invoke('engineeringBuildCancel',params({buildId:build.id}));toast('已请求终止本次编译进程。');}),'small'));
    else actions.push(button('记录手工上板结果',()=>dVerification(build),'small'),button('归档产物',()=>dArchiveDialog(build),'small soft',!passed||!build.sourceVerified||!build.artifacts.length));
    const row=bRow(title,info,actions,`${build.artifacts.length} 个可归档产物`);
    if(passed&&!build.sourceVerified)row.append(note('构建输入在编译中发生变化','该结果不提供已验证的源码/产物归档。'));
    if(build.verification)row.append(note('手工上板记录',`${build.verification.board}：${{passed:'通过',failed:'失败',untested:'未测试'}[build.verification.verdict]} · ${build.verification.notes}`));else if(!busy)row.append(el('p','d-muted','上板状态：未记录；编译通过不等于硬件验证通过。'));
    $('content').append(row);
  }
}
function dVerification(build){const d=modal('手工上板验证','D1 · 用户实际测试记录'),board=bInput('板卡或测试对象',build.verification?.board||''),notes=bInput('测试说明',build.verification?.notes||''),verdict=el('select');verdict.setAttribute('aria-label','上板验证结果');for(const[v,l]of[['untested','未测试'],['passed','实际测试通过'],['failed','实际测试失败']]){const o=el('option','',l);o.value=v;verdict.append(o);}append(d.body,el('p','','记录仅关联这个构建快照。工具不会自动烧录，也不会自动判断硬件结果。'),board.wrap,verdict,notes.wrap);append(d.actions,button('取消',closeModal,'ghost'),button('保存手工验证',()=>dAct('engineeringVerification',{buildId:build.id,board:board.input.value,notes:notes.input.value,verdict:verdict.value},'手工验证已记录。'),'primary'));}
function dArchiveDialog(build){const d=modal('归档构建产物','D1 · 本地固件归档'),selected=new Map(),include=el('input');include.type='checkbox';include.checked=true;
  d.body.append(el('p','',`来源快照 ${build.source.hash.slice(0,16)}。归档保存在本机，不自动发布到 GitHub。`));
  for(const file of build.artifacts){const c=el('input');c.type='checkbox';c.checked=true;c.setAttribute('aria-label','归档 '+file.name);selected.set(file.id,c);d.body.append(append(el('label','c-checkbox'),c,el('span','',`${file.name} · ${file.format} · ${bytesText(file.bytes)}\nSHA-256：${file.sha256}`)));}
  d.body.append(append(el('label','c-checkbox'),include,el('span','','包含对应工程文件快照（不含 Git 历史与旧编译输出）')));append(d.actions,button('取消',closeModal,'ghost'),button('保存本地固件归档',()=>dAct('engineeringArchive',{buildId:build.id,artifactIds:[...selected].filter(([,c])=>c.checked).map(([id])=>id),includeSource:include.checked},'固件、日志与来源清单已归档。'),'primary'));
}
function renderDArchives(){if(!D.data.archives.length){$('content').append(empty('还没有固件归档','编译成功且快照校验通过后，在 Keil 编译页选择产物进行本地归档。'));return;}for(const item of D.data.archives)$('content').append(bRow(item.artifacts.join('、'),`${dateText(item.date)}\n快照：${item.sourceHash}\n${item.includeSource?'包含工程文件快照':'仅产物和记录，不包含源码'} · 不包含 Git 历史`,[button('导出到空目录',async()=>{const folder=await run('选择导出目录…',()=>invoke('chooseCloneDestination'));if(folder?.path){const result=await dAct('engineeringArchiveExport',{id:item.id,destination:folder.path},'归档已导出。');if(result)cOutput('导出完成',`${result.files} 个文件\n${result.destination}\n清单包含文件 SHA-256 和构建来源。`);}},'small soft')],'本地归档'));}
function dDraftKey(root,notePath){return 'stm32-note:'+root+':'+notePath;}
function dPersistDraft(){if(!D.note)return;try{localStorage.setItem(dDraftKey(D.root,D.note.notePath),JSON.stringify({content:D.note.content,version:D.note.version}));D.note.draftStatus='草稿已保存在本机，尚未写入工程';}catch{D.note.draftStatus='本机草稿存储失败，请及时保存笔记';}}
async function dOpenNote(notePath){await run('读取笔记…',async()=>{const note=await invoke('engineeringNoteRead',params({notePath}));try{const draft=JSON.parse(localStorage.getItem(dDraftKey(S.current.path,notePath))||'null');if(draft&&typeof draft.content==='string'){note.content=draft.content;note.version=draft.version;note.draftStatus='已恢复本机草稿；保存时会检查文件是否改变';}}catch{}D.note=note;render();});}
function renderDNotes(){
  const choose=card('工程 Markdown 笔记'),file=bInput('笔记路径',D.note?.notePath||'docs/工程笔记.md');append(choose,file.wrap,button('读取或创建笔记',()=>dOpenNote(file.input.value),'soft'));$('content').append(choose);
  if(!D.note){$('content').append(note('可记录接线、测试与开发说明','输入工程内的 .md 相对路径。这里只保存笔记文件，不自动提交。支持基础标题、列表、表格、代码块、链接和本地图片；原始 HTML 按文字显示。'));return;}
  const grid=el('div','d-note-grid'),editor=card('编辑'),preview=card('预览'),input=el('textarea');input.value=D.note.content;input.rows=20;input.setAttribute('aria-label','Markdown 笔记内容');const status=el('p','d-muted',D.note.draftStatus||'内容已从磁盘读取'),renderArea=el('div','d-markdown');
  input.addEventListener('input',()=>{D.note.content=input.value;dPersistDraft();status.textContent=D.note.draftStatus;dMarkdown(renderArea,input.value);});
  append(editor,input,status,button('保存笔记到工程',async()=>{const note={...D.note};await run('保存笔记…',async()=>{const saved=await invoke('engineeringNoteSave',params({notePath:note.notePath,content:note.content,version:note.version}));localStorage.removeItem(dDraftKey(D.root,note.notePath));D.note=saved;S.current=await invoke('state',params());render();toast('笔记已保存到工程；尚未提交。旧文件可在恢复中心找回。');});},'primary'),button('重新读取磁盘',()=>{const d=modal('重新读取磁盘笔记');d.body.append(el('p','','会替换当前编辑框并移除本机草稿，请先确认需要的内容已保存。'));append(d.actions,button('取消',closeModal,'ghost'),button('确认重新读取',()=>{localStorage.removeItem(dDraftKey(D.root,D.note.notePath));forceCloseModal();dOpenNote(D.note.notePath);},'soft'));},'ghost'));
  preview.append(renderArea);append(grid,editor,preview);$('content').append(grid);dMarkdown(renderArea,D.note.content);
}
function dInline(node,text){const expression=/(!?\[[^\]]*\]\([^\)]+\)|\*\*[^*]+\*\*|`[^`]+`)/g;let end=0;for(const match of text.matchAll(expression)){node.append(document.createTextNode(text.slice(end,match.index)));const token=match[0];if(token.startsWith('**'))node.append(el('strong','',token.slice(2,-2)));else if(token.startsWith('`'))node.append(el('code','',token.slice(1,-1)));else{const link=/^(!?)\[([^\]]*)\]\(([^)]+)\)$/.exec(token);if(link[1]){const wrap=el('span','d-image-placeholder',link[2]||'图片');node.append(wrap);if(!/^[a-z][a-z0-9+.-]*:|^\//i.test(link[3]))invoke('engineeringNoteImage',params({notePath:D.note.notePath,imagePath:link[3]})).then(result=>{if(wrap.isConnected){const image=el('img');image.alt=link[2];image.src=result.dataUrl;wrap.replaceChildren(image);}}).catch(()=>{wrap.textContent='[本地图片无法预览：'+link[3]+']';});else wrap.textContent='[远程图片未加载：'+link[2]+']';}else{const b=button(link[2],()=>run('打开链接…',()=>invoke('openEngineeringLink',params({url:link[3]}))),'d-link');node.append(b);}}end=match.index+token.length;}node.append(document.createTextNode(text.slice(end)));}
function dMarkdown(container,text){container.replaceChildren();const lines=text.split(/\r?\n/);let code=null;for(let i=0;i<lines.length;i++){const line=lines[i];if(line.startsWith('```')){if(code){container.append(el('pre','',code.join('\n')));code=null;}else code=[];continue;}if(code){code.push(line);continue;}if(!line.trim())continue;const heading=/^(#{1,6})\s+(.+)$/.exec(line);if(heading){const h=el('h'+heading[1].length);dInline(h,heading[2]);container.append(h);continue;}if(line.includes('|')&&i+1<lines.length&&/^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(lines[i+1])){const table=el('table');const cells=row=>row.replace(/^\s*\||\|\s*$/g,'').split('|').map(x=>x.trim());let row=el('tr');for(const cell of cells(line)){const th=el('th');dInline(th,cell);row.append(th);}table.append(row);i+=2;for(;i<lines.length&&lines[i].includes('|');i++){row=el('tr');for(const cell of cells(lines[i])){const td=el('td');dInline(td,cell);row.append(td);}table.append(row);}i--;container.append(table);continue;}const item=/^\s*(?:[-*]|\d+\.)\s+(.+)$/.exec(line),p=el(item?'div':line.startsWith('> ')?'blockquote':'p');dInline(p,item?'• '+item[1]:line.replace(/^> /,''));container.append(p);}if(code)container.append(el('pre','',code.join('\n')));}
function renderDCheckpoints(){const settings=D.data.settings,enabled=el('input');enabled.type='checkbox';enabled.checked=settings.checkpointEnabled;enabled.setAttribute('aria-label','自动本地检查点');const interval=el('select');interval.setAttribute('aria-label','检查点间隔');for(const n of[1,5,10,30,60]){const o=el('option','',`${n} 分钟`);o.value=n;o.selected=n===settings.intervalMinutes;interval.append(o);}const cardEl=card(`本地检查点 · ${D.data.checkpoints.length}/20`);append(cardEl,note('检查点与正式提交分开','保留普通磁盘文件及暂存区证据；不创建正式提交，不上传。自动检查点只在本程序打开且当前工程被选中时运行，无变化不重复保存。最多保留 20 个，可移到系统回收站。'),append(el('label','c-checkbox'),enabled,el('span','','启用自动本地检查点')),interval,button('保存检查点设置',()=>dAct('engineeringSettings',{checkpointEnabled:enabled.checked,intervalMinutes:Number(interval.value)},'检查点设置已保存。'),'soft'),button('立即保存检查点',()=>dAct('engineeringCheckpoint',{},'本地检查点已保存。'),'primary',D.data.checkpoints.length>=20));$('content').append(cardEl);for(const item of D.data.checkpoints)$('content').append(bRow(dateText(item.date),`${item.automatic?'自动':'手动'} · ${item.files} 个文件 · ${bytesText(item.bytes)}\n原提交：${item.head||'尚未提交'}`,[button('导出到空目录',async()=>{const out=await run('选择导出目录…',()=>invoke('chooseCloneDestination'));if(out?.path)await dAct('engineeringCheckpointExport',{id:item.id,destination:out.path},'检查点文件已导出，当前工程未覆盖。');},'small soft'),button('移到系统回收站',()=>dConfirm('检查点移到回收站','只将这个检查点副本移到系统回收站，当前工程文件保留。','engineeringCheckpointDelete',{id:item.id},'检查点副本已移到系统回收站。'),'small ghost')]));}
function renderDExtensions(){const section=card('环境与可选扩展');append(section,el('p','','GitHub 连接沿用现有远程同步。D1 提供 Git LFS 版本检测，不安装组件、不迁移历史。在线 AI 与其他托管平台尚未启用；下面的提交说明只是按文件类型生成的规则草稿。'),button('检测 Git LFS',()=>run('检测 LFS…',async()=>{D.lfs=await invoke('engineeringLfs',params());render();}),'soft'),button('生成提交说明草稿',()=>run('生成规则草稿…',async()=>{const result=await invoke('engineeringSummary',params());S.draft=result.text;S.view='changes';render();toast(result.source+'；请自行修改后保存。');}),'soft'),button('导出迁移检查清单',async()=>{const out=await run('选择清单位置…',()=>invoke('chooseEngineeringReportSave',params()));if(out?.path){const result=await dAct('engineeringReport',{destination:out.path},'迁移检查清单已导出。');if(result)cOutput('清单已导出',result.filePath+'\n此清单不包含完整源码、Git 历史、Keil 安装或外部依赖。');}},'ghost'));if(D.lfs)section.append(note(D.lfs.version,D.lfs.scope));$('content').append(section);}
