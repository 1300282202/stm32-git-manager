# 第三方组件

项目自身代码采用 MIT。第三方组件遵循其各自许可证，项目许可证不替代第三方条款。

| 组件 | 用途 | 声明位置 |
| --- | --- | --- |
| Electron 45.0.0 | 桌面运行时 | 发行目录 `LICENSE`、`LICENSES.chromium.html`；包含 Node.js/Chromium 相关声明 |
| fast-xml-parser 5.11.2 及运行依赖 | Keil XML 解析 | 发行包 `resources/app/node_modules/` 各包许可证和 package.json |
| Playwright 1.64.1 | 仅开发和界面测试 | 开发依赖目录许可证，不随应用运行负载分发 |

发行目录的 `PROJECT-LICENSE.txt` 是本项目 MIT 许可证，`LICENSE` 保留 Electron 原始声明，避免覆盖。打包脚本保留运行依赖的完整包及其许可证。

Git、Git Credential Manager、Keil MDK/编译器、STM32 SDK、设备包以及用户工程均不随本工具分发，请分别按其许可安装使用。

