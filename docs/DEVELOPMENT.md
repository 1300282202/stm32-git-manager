# 开发与打包

当前目标平台为 Windows x64，Node.js 24+，Git。Electron、XML 解析器和 Playwright 使用锁定版本。Keil 不参与自动测试安装。

## 安装并启动

```powershell
npm ci
npm run check
npm test
npm start
```

`npm ci` 会安装锁定依赖并下载 Electron。若网络或 npm 的 `ignore-scripts` 设置导致 Electron 未安装，可确认网络和设置后运行：

```powershell
node node_modules/electron/install.js
```

不要用 `npm audit fix --force` 无条件改动锁定依赖。修改依赖后重新运行检查与测试。

## 测试

```powershell
npm test
npm run test:ui
npm run test:startup
npm run check:share
```

后端测试使用系统临时目录内的专用仓库，覆盖独立 Git 配置；结果与界面测试数据放在 `.test-work/`；不依赖开发者桌面工程。界面测试注入模拟构建器，创建示例仓库、笔记、检查点、归档和迁移清单；不会真实烧录或推送。`test:startup` 检查公开版首次启动为空工程列表。

打包后可对成品重跑界面流程：

```powershell
$env:STM32_TEST_EXE = (Resolve-Path 'dist/STM32Git-v0.4.1-win32-x64/STM32Git.exe').Path
npm run test:ui
npm run test:startup
Remove-Item Env:STM32_TEST_EXE
```

## 打包

```powershell
npm run package
npm run package:zip
```

仅在 Windows x64 打包。`package` 从已安装 Electron 运行时新建 `dist/STM32Git-v版本-win32-x64/`，复制当前源码、所需运行依赖、文档和许可证；**不从历史 app/data 复制设置或工程**。已有同名目录时停止，避免覆盖使用中的包。

`package:zip` 先检查发行目录，再用系统 `tar.exe` 生成 ZIP 和 `SHA256SUMS.txt`。运行包只含白名单运行文件与资料；源码通过 GitHub 仓库分发。发行目录首次运行会生成 `data/`，出现这个目录后不得直接重新分发，需生成全新干净包。

## 结构

| 路径 | 用途 |
| --- | --- |
| `src/main.cjs`、`preload.cjs` | 桌面主进程、固定 IPC 入口和权限边界 |
| `src/git-service.cjs`、`git-utils.cjs` | 基础 Git、状态与文件处理 |
| `src/git-collaboration.cjs`、`git-expert.cjs` | 协作与专家能力 |
| `src/git-engineering.cjs`、`keil-build.cjs` | 工程记录、检查点、快照编译与归档 |
| `src/renderer/` | 无构建步骤的中文界面 |
| `tests/` | 使用临时仓库的后端集成测试 |
| `scripts/` | 语法、界面、启动、分享检查与打包 |
| `docs/` | 使用、范围、开发、验证与接口文档 |

主进程采用受限 action 白名单，renderer 不直接接触 Node/Git。修改 IPC 时同步更新主进程、preload 与文档。写操作须保留状态令牌、路径约束、备份和错误状态处理。

`STM32_DATA_DIR` 可覆盖应用数据位置。`STM32_SEED_PROJECTS` 供隔离测试指定工程 JSON 数组，普通用户无需设置。测试输出与本地数据被 `.gitignore` 排除。

