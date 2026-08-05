# E-Pi

> E-Pi is a focused desktop shell for Pi sessions, packages, and terminal workflows.

E-Pi 是一个基于 Electron 的桌面应用，为 [Pi Coding Agent](https://github.com/earendil-works/pi-coding-agent) 提供原生桌面体验。它把 Pi 的会话、包管理、技能管理与一个功能完整的终端集成在同一个窗口里。

## 特性

- **多会话并行** — 每个会话独立运行一个 Pi 进程，按项目分组，互不干扰
- **终端集成** — 内嵌 xterm.js 终端（WebGL 渲染加速），与 Pi 会话同屏协作
- **代码审查** — 基于 [Pierre diffs](https://www.npmjs.com/package/@pierre/diffs) 引擎渲染 diff，附带 git numstat 行数统计
- **技能管理** — 可视化查看、管理 Pi 技能（Skills）
- **包管理面板** — 浏览与管理 Pi 包（Packages）
- **模型设置** — 按会话切换模型、配置模型参数
- **会话统计** — 实时展示输出速度（tok/s）、token 用量等运行时指标
- **图片粘贴** — 输入框直接粘贴图片
- **点阵状态指示** — 侧边栏用 3×3 点阵 + Braille spinner 展示各会话的 agent 工作状态
- **现代 UI** — React 19 + Tailwind CSS 4 + Radix UI 组件

## 技术栈

| 层 | 技术 |
|---|---|
| 桌面框架 | Electron 43 + electron-vite |
| 前端 | React 19、TypeScript、Tailwind CSS 4、Radix UI |
| 终端 | xterm.js + WebGL 渲染 |
| 核心 | [@earendil-works/pi-coding-agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)（pi 本体）、node-pty |
| 测试 | Vitest |
| 质量 | oxlint、oxfmt、Husky + lint-staged |

## 快速开始

### 环境要求

- Node.js 20+（建议 22 LTS）
- pnpm 10

### 安装与运行

```bash
# 安装依赖（postinstall 会自动安装 Electron 与构建依赖）
pnpm install

# 启动开发模式（热重载）
pnpm dev

# 或先构建再预览
pnpm build
pnpm start
```

### 常用命令

| 命令 | 说明 |
|---|---|
| `pnpm dev` | 开发模式，热重载 |
| `pnpm build` | 类型检查 + 测试 + 构建 |
| `pnpm start` | 预览已构建的应用 |
| `pnpm test` | 运行 Vitest 测试 |
| `pnpm lint` / `pnpm lint:fix` | 代码检查 |
| `pnpm format` / `pnpm format:check` | 代码格式化 |
| `pnpm typecheck` | TypeScript 类型检查 |
| `pnpm dist:mac` | 打包 macOS 安装包（dmg + zip） |

## 项目结构

```
e-pi/
├── electron/            # Electron 主进程与 preload
│   ├── main/
│   │   ├── index.ts     # 应用入口
│   │   └── services/    # pi 运行时、会话、git、模型、包、技能等服务
│   └── preload/index.ts # 预加载脚本（IPC 桥接）
├── src/                 # 渲染进程（React）
│   ├── components/      # 界面组件（Composer、终端、审查、侧边栏等）
│   ├── styles/          # 模块化 CSS
│   ├── types/           # 类型定义
│   └── main.tsx         # React 入口
├── resources/           # 打包资源（e-pi-bridge.ts）
├── public/              # 静态资源
├── test/                # 单元测试
└── scripts/
```

## 开发

核心架构：Electron 主进程通过 `pi-runtime` 服务管理多个 Pi 进程（每会话一个），通过 IPC 与渲染进程通信；渲染进程用 React 渲染会话 UI，并通过 preload 暴露的桥接接口与主进程交互。

### 运行测试

```bash
pnpm test
```

## 打包发布

```bash
# macOS（dmg + zip）
pnpm dist:mac
```

## License

暂未指定（private 项目，如需开源请补充许可证）。
