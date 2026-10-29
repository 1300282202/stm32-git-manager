# 开发接口约定

本文保留基础、协作、专家与工程扩展各阶段的接口演进。公开版为 0.4.1。

> 0.2.0 增加 B 阶段接口，见文末。本节记录的基础接口继续兼容。

所有源码 CommonJS 或无依赖浏览器 JavaScript；Electron 桌面壳；中文界面。主进程通过固定 action 白名单调用 GitService。页面仅通过 `window.stm32.invoke(action, payload)` 访问受控接口，成功返回 data，失败抛出有 message/code 的 Error。

后端：`src/git-service.cjs` 导出 `GitService`，构造参数 `{dataDir, seedProjects: string[], gitPath?: string}`；方法 `await service.execute(action,payload)`。供测试和主进程直接调用。所有路径输出统一使用 Windows 绝对项目路径、项目内正斜线相对文件路径。

## 方法与结构

- `projects {}` → `{recents:[{path,name}], discovered:[{path,name}], gitVersion, dataDir}`。seedProjects 为已知项目列表。
- `inspect {projectPath}` → 项目结构（见 state），可包含非仓库；登记最近项目。
- `state {projectPath}` → `{path,name,isRepo,repoRoot,parentRepo,bare,branch,head,identity:{name,email},keil:{projects:[{path,name,targets:[{name,device,compiler,outputDir,listingDir}]}],warnings:[]},files:[{path,originalPath?,x,y,staged,unstaged,untracked,conflict,kind,bytes?}],token,operation?,gitVersion?}`。head 无提交时为 null，kind 为 added/modified/deleted/renamed/untracked/conflict。外部父仓库与裸仓库明确标记并拒绝写操作。
- `init {projectPath}` → state；只初始化精确项目根目录的未初始化仓库，分支 main。
- `identity {projectPath,name,email}` → state；只设置仓库级身份。
- `stage {projectPath,paths:string[],token}`、`unstage {projectPath,paths:string[],token}` → state。token 必须匹配最新状态；空仓库取消暂存也应支持。
- `commit {projectPath,message,token}` → `{hash,state}`；提交当前暂存区，不能隐式选择未勾选文件；message 非空，拦截冲突/进行中的 Git 操作。失败保留暂存区。
- `diff {projectPath,path,mode:'working'|'staged'|'commit',hash?}` → `{text,binary,encoding,truncated}`。working 显示工作区对暂存区，未跟踪文件显示内容；staged 显示暂存区对 HEAD；commit 显示提交与其父提交差异，支持根提交。
- `history {projectPath,skip?:number,limit?:number,search?:string}` → `{commits:[{hash,shortHash,subject,author,date}],hasMore}`；空仓库返回空列表。
- `historyFiles {projectPath,hash}` → `{files:[{path}]}`：选定历史版本内全部普通文件，供查看/恢复。
- `readFile {projectPath,path,source:'working'|'index'|'commit',hash?}` → `{text,binary,encoding,truncated,bytes}`。保留原始文件字节，不自动转码。文本展示可使用 TextDecoder UTF8/GB18030 等。
- `ignorePreview {projectPath}` → `{rules:string[],matchedFiles:string[],warnings:string[],token}`。按 Keil 实际输出目录生成窄规则，根目录输出不能忽略整个根目录；源码不应被目录规则覆盖。预览不得更改文件。
- `ignoreApply {projectPath,rules:string[],token}` → state；不覆盖现有 .gitignore，添加去重规则，写入前备份。必须验证 token 与建议规则。
- `restorePreview {projectPath,path,hash}` → `{token,path,hash,current:{text,binary,encoding,truncated,bytes},target:{text,binary,encoding,truncated,bytes},indexWillChange:false}`。记录恢复目标和当前文件/索引指纹。
- `restore {projectPath,path,hash,token}` → `{backupId,state}`。必须先校验预览令牌、备份工作区原始字节+校验及索引证据，再恢复普通文件工作区；保留暂存区；防止 symlink/junction 越界。操作后仍是待提交修改。
- `backups {projectPath}` → `{backups:[{id,date,path,reason,canUndo}]}`。
- `undoRestore {projectPath,backupId}` → `{backupId,state}`。检测当前文件是否仍与上次恢复结果一致；不一致拒绝覆盖；先为当前文件创建新备份再恢复旧字节；原文件不存在则需要明确该备份动作会移除当前文件。仅限本工程。
- `logs {projectPath}` → `{logs:[{id,date,action,summary,success}]}`，最近 200 条；用户文件正文和敏感凭据不入日志。

## 由桌面壳实现的方法

- `chooseProject {}` → `{path:string|null}`（系统目录选择框）。
- `openKeil {projectPath,keilProjectPath?}` → `{opened:true}`；选择的 uvprojx 必须来自当前项目扫描结果。
- `openFolder {projectPath}` → `{opened:true}`。
- `chooseCloneDestination {}` → `{path:string|null}`；克隆向导可选，新目录需空。
- `clone {url,destination}` → state；使用 execFile/spawn 参数数组，禁止本地 ext/helper 命令协议，保留错误，不能默删残留文件。HTTPS/SSH 支持按本机已有凭据，取消和私钥管理不在 A。
- `appInfo {}` → `{version,dataDir,gitVersion}`。

## 实现要求

开发测试使用独立临时仓库和示例文件，不访问开发者的私人工程；公开版首次启动不预选工程。

后端安全：固定 Git 参数、literal pathspec、路径规范化、阻止 .git 和符号链接越界、操作串行、状态变化后拒绝过期写入、超时/输出上限。禁止渲染器任意执行命令。普通未受信任仓库的 hooks/filters 行为需明确处理，不能静默执行任意仓库脚本。

前端：精致克制的中文桌面界面，浅色石墨/青绿色；左侧项目与导航，中部文件+差异，右侧版本说明；首次提交有清晰引导。页签：当前修改、版本历史、恢复中心、操作记录、工程设置。支持加载/错误/空状态、忙时禁用重复动作；目录路径可复制。先给必需操作，B/C/D 功能不要放假按钮。

## B 阶段接口（0.2.0 试用）

实现位于 `src/git-collaboration.cjs`，通过固定白名单注入 GitService，桌面壳及 preload 同步声明。写操作继续要求 `projectPath` 和最新状态 `token`；返回普通 state 或 `{state,conflicted,...}`。

- 分支：`branches`、`branchCreate {name,switchTo}`、`branchSwitch {name,expectedHash}`、`branchRename {name,newName}`、`branchDelete {name}`。
- 合并：`mergePreview {source,expectedHash}` → `{source,sourceHash,token,commits,diff,fastForward}`；`merge {source,sourceHash}`。
- 冲突：`conflicts`、`conflictFile {path}` → `{base,ours,theirs,current,token}`；`resolveConflict {path,choice,text?}`，choice 为 ours/theirs/edited/working；`continueOperation`、`abortOperation`。
- 草稿：`stashes` → `{items,archives}`；`stashCreate {message,includeUntracked}`、`stashApply {hash,reinstateIndex}`、`stashDrop {hash}`、`stashRecover {id}`。
- 移植：`cherryPick {hash}`，仅普通提交，冲突沿用上述流程。
- 标签：`tags`、`tagCreate {name,message,hash}`、`tagDelete {name}`，仅本地未签名标签。
- 工作目录：`worktrees`、`worktreeAdd {destination,hash}` → `{path,state}`、`worktreeRemove {worktreePath}`。
- 远程：`remotes` → `{items,current,upstream,ahead,behind}`；`remoteSave {name,url}`、`remoteRemove {name}`。
- 同步：`syncPreview {remote,direction}` → `{token,url,branch,commits,...}`；`fetch/pull/push {remote,url}`。pull 仅快进，push 不强制覆盖；对应当前分支的远程同名分支。
- 导出：桌面 `chooseArchiveDestination {projectPath,hash}` → `{path}`；服务 `exportArchive {hash,destination}` → `{filePath,hash,bytes}`。

Git stash 使用 Git 自身内部的路径规则，不继承全局 literal-pathspec 开关；外部文件选择接口仍保持 literal pathspec。草稿删除保留救援引用，工作目录删除拒绝脏状态和未被命名引用保留的提交。
# C1 专家接口补充（0.3.0）

新增：`expertOverview`、`expertCatalog`、`expertHelp`、`expertReflog`、`expertPreview`、`expertExecute`、`expertRescue`、`expertBackups`、`expertBackupExport`、`expertBisectStatus/Start/Mark/Stop/Worktree`、`expertDiagnose`、`expertBundleExport/Verify`。具体参数见 `src/git-expert.cjs`。

危险写入必须先取得服务端保存的 `expertPreview` 令牌，执行时带 `previewToken` 和精确的确认文字。服务端复查 HEAD、索引、工作区状态和全部普通文件内容；先校验文件备份并创建救援分支，再执行。清理只能选择该预览列出的文件。预览有效期 10 分钟，执行后不可复用。

二分使用 `--no-checkout`，状态返回 `candidate` 和 `logToken`；标记或创建候选目录时必须同时匹配。历史包导出只支持固定 `--all`，不接受任意 Git 参数。工具箱帮助只执行固定安全帮助白名单，其余条目仅显示说明；渲染层不能请求任意 shell 或 Git 命令。

桌面专用接口：`chooseExpertBundleSave`、`chooseExpertBundleOpen`、`openExpertHelp`。所有接口仍校验调用窗口及已登记的工程。B 的 `continueOperation/abortOperation` 扩展普通反向提交的继续与中止。

# D1 工程扩展接口（0.4.0）

`engineeringOverview/Settings` 返回并设置 Keil 位置、目标配置与自动检查点偏好。`engineeringBuildStart/Poll/Cancel` 管理后台快照构建；启动前校验工程、路径及已启用的用户程序，构建期间 `longOperations` 阻止同仓库写操作。构建在短临时路径复制中运行，不使用 shell，不提供烧录参数。`test-simulation` 与 `keil` 来源在记录及归档中分开。

`engineeringVerification` 是手工上板记录，不是自动硬件结论。`engineeringArchive/ArchiveExport` 仅接受该构建记录的已校验产物；源码变化、当前匹配状态、编译器请求值与实际日志值单独保留。

`engineeringNoteRead/Save/Image` 限工程内 Markdown 和受支持的本地位图；保存带文件版本哈希，备份旧内容。`engineeringCheckpoint/CheckpointExport/CheckpointDelete` 管理普通磁盘文件和索引证据；删除经桌面端委托系统回收站，不永久删除。`engineeringAutoTick` 只在显式启用、当前项目、间隔到达且非忙时运行，状态未变或达到上限时跳过。

`engineeringLfs` 只调用固定版本检测且拒绝自定义别名；`engineeringSummary` 为本地规则草稿；`engineeringReport` 为本地 JSON 检查清单。桌面文件选择、HTTPS 笔记链接仍经过已登记项目和固定协议检查，renderer 无任意命令或文件访问接口。

