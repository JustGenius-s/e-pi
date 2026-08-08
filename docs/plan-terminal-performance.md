# E-Pi 终端性能与渲染流水线优化实施计划

> **交接文档**。执行者无需重新调研，本文档包含全部背景、证据、精确改动位置与验收标准。
> **代码基线**：本文档编写时的 `src/lib/terminalReplayBuffer.ts`、`src/components/workspace/TerminalPanel.tsx`、
> `src/components/workspace/SideTerminalView.tsx`、`src/hooks/useSessionRuntime.ts` 已包含前序优化
> （`smoothScrollDuration: 0`、viewport watchdog、rAF settle 重排）。开工前先 `git diff` 确认这些已在。

---

## 0. 项目上下文（执行者必读）

E-Pi 是把 pi coding agent 的 TUI 嵌进Electron 的桌面应用。数据流：

```
pi 进程 (PTY)
  └─ child.onData(chunk)                      electron/main/services/pi-runtime.ts:419
       └─ #globalDataListeners                → 每 chunk 一次
            └─ runtime.onGlobalData(...)       electron/main/index.ts:555
                 └─ sendToRenderer("runtime:data", {sessionPath, data})   ← 每 chunk 一次 IPC
                      └─ preload: ipcRenderer.on("runtime:data")electron/preload/index.ts:139-144
                           ├─ ensureBufferFeeder 的全局 listener  → appendTerminalReplay（每 chunk 全量拷贝）
                           └─ TerminalPanel 的 per-session listener → flushWrite → xterm.write
```

另有一条状态流：pi 写sidecar JSON → `pi-runtime.ts` 的 `#watchSessionState` 读取 →
`sendToRenderer("runtime:state", state)` → `useSessionRuntime` 的 `setRuntimeStates` → **App 全树 re-render**。

关键技术约束（前序调研已验证，不要推翻）：

1. **xterm 版本是 v6.0.0**。`Viewport._sync` 不碰 DOM `scrollTop`，只改内部 `Scrollable._state`。
   v6 引入了 `SmoothScrollingOperation`，已通过 `smoothScrollDuration: 0`（`src/lib/xterm.ts`）关闭 —— **不要恢复**。
2. **pi TUI 每次权威渲染都发 `\x1b[2J\x1b[H\x1b[3J`（full redraw）**，并用 `\x1b[?2026h/l`（synchronized output）包裹。
   `3J` 会清空 scrollback，已在 `src/lib/xtermScrollbackGuard.ts` 用parse-time CSI handler 吞掉 —— **不要移除**。
3. **pi TUI 只在 PTY size 变化时重发full frame**，这是 `TerminalPanel` 里 checkpoint shimmy 的前提。
4. xterm 的 `write()` 是异步解析（setTimeout macrotask）。`write("", cb)` 是 FIFO barrier。

验证命令（每个任务完成后都要全过）：

```bash
cd /Users/jiahaoqian/proj/e-pi
npx tsc --noEmit          # 必须 0 error
npx vitest run            # 基线 188 passed / 21 files，只允许增加
npx oxlint                # 只允许既有的 no-await-in-loop warning，不允许 error
npx oxfmt .# 提交前必须跑，CI 用 oxfmt --check
```

---

## 任务 A1：`terminalReplayBuffer` 改为分段累积（最高优先级）

### 问题证据（已实测）

现有实现 `src/lib/terminalReplayBuffer.ts:69`：

```ts
const input = previous.awaitingCheckpoint ? previous.checkpointPrefix + data : previous.content + data;
const checkpoint = latestCheckpoint(input); // 内部 lastIndexOf 反向全扫
```

每个 chunk 都无条件把**整个 buffer** 与新数据拼接成新字符串，再全扫找 checkpoint。
用 36×120 全屏帧 + spinner 增量流实测（稳态 buffer ≈108KB）：

| 场景                              | 每 chunk耗时 |
| --------------------------------- | ------------ |
| 稳态（108KB，spinner 流）         | **76.9 µs**  |
| 399KB 无 checkpoint（"最坏"情况） | 6.6 µs       |

稳态反而慢 10 倍：因为 pi 每帧都带 full-redraw 标记，**每个 chunk 都命中 checkpoint 分支**，
即每帧付一次 108KB 拷贝 + 反向扫描。这条路径在 `ensureBufferFeeder`（`TerminalPanel.tsx:104-112`）
的**全局** listener 上，与可见性无关、与session 数量成正比，持续占用主线程，与 xterm 的 rAF 抢帧。

### 目标

-每 chunk 成本降到~2 µs 量级，且**不随 buffer 大小增长**。

- 对外行为（`content` 的最终字节、`awaitingCheckpoint`、`checkpointPrefix` 语义）**完全不变**。
- 现有 9 个测试（`test/terminal-replay-buffer.test.ts`）全部不改动即通过。

### 实施方案

将`TerminalReplayBuffer` 内部表示从单一`content: string` 改为 `segments: string[]` + 派生字段。

**新接口**（保持 `content` 作为兼容读取入口，避免改所有调用点）：

```ts
export interface TerminalReplayBuffer {
  /** 内部分段存储；仅本模块读写。 */
  readonly segments: readonly string[];
  /** segments 的字符总长（避免每次 reduce）。 */
  readonly length: number;
  readonly awaitingCheckpoint: boolean;
  readonly checkpointPrefix: string;
}

/** 物化为可直接喂给新 xterm parser 的自包含VT 流。仅在 replay 时调用。 */
export function replayContent(buffer: TerminalReplayBuffer | undefined): string;
```

**核心算法改动**：

1. **checkpoint 检测只扫新 chunk +跨界前缀**，不再扫全buffer：
   `haystack = previous.checkpointPrefix + data`（`checkpointPrefix` 已是≤ `FULL_REDRAW_SEQUENCE.length - 1`
   的有界后缀，正是为跨 chunk 检测存在的）。在 `haystack` 里 `lastIndexOf(FULL_REDRAW_SEQUENCE)`。
2. **命中 checkpoint** → `segments = [该 checkpoint 起始的自包含流]`（旧段全丢）。
   注意 sync-opener 平衡逻辑（现`latestCheckpoint`）必须保留：checkpoint 之前若有未闭合的
   `SYNC_OPEN_SEQUENCE` 则保留它，否则合成一个 `SYNC_OPEN_SEQUENCE` 前缀。
   **此处 `openAt`/`closeAt` 的判断需要在"checkpoint 所在 chunk"内完成**；若 checkpoint 在
   本次 chunk 内且其前部在旧段中，按现有语义合成 opener 即可（测试
   `"retains or synthesizes a balanced synchronized-output opener"` 覆盖这两条分支）。
3. **未命中** → `segments = [...previous.segments, data]`，`length += data.length`。
4. **溢出判定**（`length > maxChars`）→ 与现有一致：返回
   `{ segments: [], length: 0, awaitingCheckpoint: true, checkpointPrefix: checkpointPrefixOf(...) }`。
   `checkpointPrefixOf` 的输入只需是**新数据尾部**（≤ 3 字节的 marker 前缀），不必是全 buffer。
5. **`replayContent`** = `segments.join("")`，并可缓存（把 join 结果记在一个 module-level `WeakMap`
   或 buffer 对象的可变私有字段上；若用 `readonly` 接口就在模块内用 `WeakMap<TerminalReplayBuffer, string>`）。

**保持不变的语义（测试依赖，逐条核对）**：

- `append(undefined, "")` → 空且`awaitingCheckpoint: false`（`data` 为空直接返回 previous）。
- `maxChars <= 0` → 立即 `awaitingCheckpoint: true`。
- 溢出后所有增量 chunk 继续被忽略，只留 `checkpointPrefix`，直到出现完整 full redraw才恢复。
- checkpoint 自身超过 `maxChars` → 仍然 `awaitingCheckpoint: true`、`content` 为空。
- 跨 chunk 分裂的 `\x1b[2J\x1b[H` + `\x1b[3J` 必须能被识别（测试第4 例）。

### 需要同步修改的调用点

| 文件:行                                                  | 现状                                                         | 改成                                                     |
| -------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------- |
| `src/components/workspace/TerminalPanel.tsx:74`          | `buffers.set(k, appendTerminalReplay(buffers.get(k), data))` | 不变（签名兼容）                                         |
| `src/components/workspace/TerminalPanel.tsx:473`         | `const replay = buffers.get(sessionKey)?.content;`           | `const replay = replayContent(buffers.get(sessionKey));` |
| `src/components/workspace/TerminalPanel.tsx` shimmy 判断 | `buffers.get(sessionKey)?.awaitingCheckpoint`                | 不变                                                     |

已核实：全仓库对 `TerminalReplayBuffer.content` 的读取**只有 `TerminalPanel.tsx:473` 一处**
（`grep -rn '\.content' src/components/workspace/TerminalPanel.tsx`）。测试文件里另有多处读取，见下。

### 测试要求

1. `test/terminal-replay-buffer.test.ts` **不允许修改断言**。若测试里直接读 `.content`，
   在测试顶部加一个 helper `const contentOf = (b) => replayContent(b)` 并替换读取方式即可，
   **断言的期望字符串一字不改**。
2. 新增测试文件 `test/terminal-replay-buffer.perf.test.ts`：
   - 构造稳态（40 个full frame + 2000 个spinner），断言 3000 次 append 的总耗时
     **低于一个宽松阈值**（如 60ms，即平均 20µs/chunk；实测应在 2µs 量级，阈值留足CI 抖动余量）。
   - 断言 `append` 后 `replayContent(buf)` 的结果与旧实现逐字节一致：把旧实现的纯函数逻辑
     复制成测试内的 `referenceAppend`，对同一串输入做交叉验证（property test思路，
     50组随机 chunk 切分，包含把 `FULL_REDRAW_SEQUENCE` 切在任意位置的用例）。

**交叉验证是本任务的核心验收手段** —— 它保证性能重写没有改变字节语义。

---

## 任务 A2：`buffers` Map 加LRU 驱逐

### 问题

`src/components/workspace/TerminalPanel.tsx:67` 的 `const buffers = new Map<string, TerminalReplayBuffer>()`
只在 `clearTerminalBuffer`（调用点：`src/App.tsx:507`、`src/hooks/useSessionRuntime.ts:45`）被删除，
这两处都只在 reload /冷启动路径触发。开N 个 session 跑一天 = N × 最多 400KB 常驻，
且后台 session 的 feeder 一直在写。

### 方案

在 `TerminalPanel.tsx` 的 buffer 管理区（第 60-80 行附近）加：

```ts
/** 最多保留多少个 session 的 replay buffer（含当前可见的）。 */
const MAX_BUFFERED_SESSIONS = 6;
/** 插入顺序即 LRU 顺序：Map 保证迭代顺序 =插入顺序。 */
function appendTerminalBuffer(sessionKey: string, data: string): void {
  const next = appendTerminalReplay(buffers.get(sessionKey), data);
  // 重新set 到末尾 = 标记为最近使用
  buffers.delete(sessionKey);
  buffers.set(sessionKey, next);
  while (buffers.size > MAX_BUFFERED_SESSIONS) {
    const oldest = buffers.keys().next();
    if (oldest.done || oldest.value === sessionKey) break;
    buffers.delete(oldest.value);
  }
}
```

**注意**：被驱逐的 session 再切回来时没有 replay 内容，但 `TerminalPanel` 已有兜底 ——
`awaitingCheckpoint` /空 replay 会走 checkpoint shimmy 强制 pi 重画全屏帧。
**验证这条兜底真的生效**：驱逐一个 session 后切回，终端应在~100ms 内被 pi 的full frame 填满，
而不是留白。若留白，说明空 buffer（`undefined`）与 `awaitingCheckpoint: true` 走的分支不同，
需要在驱逐时写入一个 `{ segments: [], awaitingCheckpoint: true, ... }` 占位而非直接 `delete`。

### 测试

新增 `test/terminal-replay-eviction.test.ts` 前需先把 buffer 管理逻辑从组件中抽出到
`src/lib/terminalReplayStore.ts`（导出 `appendTerminalBuffer` / `getReplay` / `clearTerminalBuffer` /
`setMaxBufferedSessions` 便于测试）。`TerminalPanel.tsx` 改为 import 使用。
测试断言：写入 8 个 session → `size === 6`；最近写入的 session 一定还在；当前活跃 key 永不被驱逐。

---

## 任务 B4：减少 App 全树 re-render

### 问题证据

`src/hooks/useSessionRuntime.ts` 的 state 订阅：

```ts
const stopState = window.ePi.runtime.onState((state) => {
  window.ePi.app.log(`[app] onState ${JSON.stringify({...})}`);   // ← 问题 1
  setRuntimeStates((current) => ({ ...current, [state.sessionPath]: state }));   // ← 问题 2
});
```

**问题 1**：每次状态更新都无条件 `window.ePi.app.log(...)`，内含 `JSON.stringify`。
（精确位置：`src/hooks/useSessionRuntime.ts:72`）
这是一次 `ipcRenderer.send`（`electron/preload/index.ts` → `ipcMain.on("app:log")` →
`debugLog`，`electron/main/index.ts:230-232`）。`debugLog` 内部虽有 `enabled()` 早退
（`electron/main/services/debug-log.ts:25-26`，仅 `E_PI_DEBUG=1` 时写盘），
但 **renderer 侧的 stringify + IPC 往返无论如何都发生**。

**问题 2**：`{ ...current, [path]: state }` 每次都产生新对象引用。而 pi 运行时 sidecar
会持续更新 `activity` / `context` / `usage` / `speed`（`pi-runtime.ts:535-630` 的
`#watchSessionState`），所以 agent 跑一次任务期间这个 setState 会高频触发。

**放大器**：主要子组件都**没有 memo**。已确认：

- 无 memo：`Composer`（`Composer.tsx:116`）、`SessionSidebar`（`SessionSidebar.tsx:433`）、
  `AppHeader`（`AppHeader.tsx:15`）、`SessionStats`（`SessionStats.tsx:20`）
- 有 memo：`ToolPanel`、`FileTreeView`、`SideTerminalView`、`WorkspaceCodeEditorOverlay`、
  `WorkspaceFilePreviewOverlay`、`WorkspaceMarkdownPreview`、`WorkspaceOverlayHost`

`Composer` 是最重的一个（`Composer.tsx`~700 行，含模型选择器、命令popup、附件、SessionStats）。
每次 sidecar 更新都重渲染它→ 与 xterm 的 rAF/WebGL 抢主线程 → 表现为"面板收起后还有点黏"。

### 方案（三步，按顺序做）

**B4-1：状态日志改为仅调试时发送**

在 `useSessionRuntime.ts` 顶部加一个模块级开关，只在开发或显式开启时打日志：

```ts
/** 状态流日志很吵（sidecar 高频更新），默认关闭；需要时在 devtools 里置 true。 */
const LOG_STATE_UPDATES = false;
```

把 `window.ePi.app.log(...)` 包进 `if (LOG_STATE_UPDATES)`。
**不要**删掉这行日志（排障有用），只是默认不执行。

**B4-2：`onState` 浅比较提前 bail**

```ts
const stopState = window.ePi.runtime.onState((state) => {
  setRuntimeStates((current) => {
    const previous = current[state.sessionPath];
    if (previous && isSameRuntimeState(previous, state)) return current; // 引用不变 → 不 re-render
    return { ...current, [state.sessionPath]: state };
  });
});
```

新建 `src/lib/runtimeStateEquality.ts`，导出 `isSameRuntimeState(a, b): boolean`。
`PiRuntimeState` 的字段清单在 `src/types/contracts.ts:143-176`（status / sessionPath / cwd /
generation / activity / waitingUser / model / thinkingLevel / supportedThinkingLevels /
context / usage / cacheHitRate / speed / pid / exitCode / signal / error）。

实现要求：

- 标量字段直接 `===`。
- `context`（`{tokens, contextWindow, percent}`）、`usage`（多个数值字段）、`model`（`ModelRef`）、
  `waitingUser` 需逐字段比较；`supportedThinkingLevels` 是数组，按长度 + 逐项比较。
- **不要用 `JSON.stringify` 比较**（那等于把开销换个地方付）。
- 必须为它写单元测试 `test/runtime-state-equality.test.ts`：相同对象返回 true；
  每个字段各改一次都必须返回 false（用逐字段遍历生成用例，避免漏字段）；
  `undefined` vs `null` 必须视为不同（`waitingUser?: WaitingUserState | null` 两种空值语义不同）。

**B4-3：给热路径组件加 memo**

对 `Composer`、`SessionSidebar`、`SessionStats`、`AppHeader` 四个组件加 `memo`。
形式统一为（与既有 `SideTerminalView.tsx` 一致）：

```ts
export const Composer = memo(function Composer({ ... }: ComposerProps) { ... });
```

**前置条件（必须先做，否则 memo 无效）**：`src/App.tsx` 传给这些组件的 props 里有内联新建的函数，
必须先提成 `useCallback`。**以下行号已核实**（基线 commit 下的 `src/App.tsx`）：

| 行      | 内联 props                                                                       | 处理                                        |
| ------- | -------------------------------------------------------------------------------- | ------------------------------------------- |
| 576     | `onTogglePanel={() => setPanelOpen((current) => !current)}`                      | `useCallback([])`，函数式 setState 故无依赖 |
| 588     | `onCreateProject={() => void createProjectSession()}`                            | `useCallback([createProjectSession])`       |
| 589-592 | `onImportProject={() => { setEditingProject(undefined); setImportOpen(true); }}` | `useCallback([])`                           |
| 596     | `onRename={(session) => void renameSession(session)}`                            | `useCallback([renameSession])`              |
| 597     | `onRemove={(session) => void removeSession(session)}`                            | `useCallback([removeSession])`              |
| 598     | `onReload={(session) => void reloadSession(session)}`                            | `useCallback([reloadSession])`              |
| 599     | `onOpenFolder={(cwd) => void window.ePi.app.openPath(cwd)}`                      | `useCallback([])`                           |
| 600     | `onCopyText={(text) => void window.ePi.app.copyText(text)}`                      | `useCallback([])`                           |
| 603     | `onOpenSettings={() => setSettingsOpen(true)}`                                   | `useCallback([])`                           |
| 669     | `onInterrupt={() => activePath && window.ePi.runtime.interrupt(activePath)}`     | `useCallback([activePath])`                 |

已经是稳定引用、**不要改**的：`onSelect={selectSession}`(586)、`onCreate={createSession}`(587)、
`onEditProject={openEditProject}`(593)、`onPromoteProject={openPromoteProject}`(594)、
`onRemoveProject={removeProject}`(595)、`onOpenPackages={openPackages}`(601)、
`onOpenSkills={openSkills}`(602) —— 先确认这些来源本身被 `useCallback` 包过
（`App.tsx:383-436` 一带已有若干 `useCallback`），若不是则一并处理。

其余值类型 props 无需处理：`Composer` 的 `focusRequest`（三元产出 string|undefined）、
`disabled`（布尔表达式）。

`SessionSidebar` 约 15 个 `on*` props 是本任务最大的机械工作量，逐个提取，注意依赖数组完整。
其 `runtimeStates={runtimeStates}`(583) 依赖 B4-2 生效后引用才稳定。

`SessionStats` 在 `Composer` 内部使用，其 props（`context` / `usage` / `cacheHitRate` /
`speed` / `live`）来自 `runtimeState?.*`，B4-2 后稳定。

**验收方式**：用 React DevTools Profiler 录一次 agent 运行（有 sidecar 高频更新的时段），
对比改动前后 `Composer` 的 render 次数。改动后应从"每次 sidecar 更新一次"降到
"仅在真正相关字段变化时"。**把前后次数写进 PR 描述**。

---

## 任务 B5：抽出共享 resize scheduler，让侧终端与主终端一致

### 问题

`TerminalPanel.tsx` 现在用 rAF settle 检测（2帧稳定后 refit），而
`SideTerminalView.tsx:121` 仍是 `fitTimer = window.setTimeout(fitTerminal, 120)` 固定防抖。
两个组件里 resize + viewport 恢复逻辑大量重复，且侧终端在收起面板时仍会卡一下。

### 方案

新建 `src/lib/xtermResizeScheduler.ts`，导出：

```ts
export interface ResizeSchedulerOptions {
  terminal: Terminal;
  fit: FitAddon;
  /** 返回 true 表示当前有未解析完的 write（主终端传() => pendingWrites > 0；侧终端传 () => false）。 */
  hasPendingWrites: () => boolean;
  /** 排一个 FIFO barrier，drain 后回调（主终端用 terminal.write("", cb)）。 */
  queueWriteBarrier: (onDrained: () => void) => void;
  /** barrier 最长等待时间（ms），超时后强行 refit。默认 100。 */
  barrierCapMs?: number;
  /** refit 完成后调用，用于发PTY resize / checkpoint shimmy。 */
  onFitted: (size: { cols: number; rows: number }) => void;
  isDisposed: () => boolean;
}

export interface ResizeScheduler {
  /** ResizeObserver 回调里调用：启动/重启 settle 检测。 */
  schedule(): void;
  /** 立即 refit（首次挂载 / barrier drain 后）。 */
  refitNow(): void;
  dispose(): void;
}

export function createResizeScheduler(options: ResizeSchedulerOptions): ResizeScheduler;
```

把 `TerminalPanel.tsx` 当前 `fitTerminal` 里的这些逻辑搬进去（**行为不变，只是搬家**）：

- grid 未变化则早退的 `proposeDimensions` 守卫
- 带 100ms 上限的 write barrier
- rAF settle 检测（2 帧稳定）
- transition 首帧 `terminal.refresh(0, rows - 1)`
- refit 后 `wasAtBottom ? scrollToBottom()` 与 `restoreViewportAfterSettle` 调用

`TerminalPanel` 的 `onFitted` 回调里保留：`window.ePi.runtime.resize(...)` + checkpoint shimmy。
`SideTerminalView` 的 `onFitted` 里只需 `window.ePi.sideTerminal.resize(id, size)`。

**风险控制**：这是纯重构，**必须在A1/B4 都合并且验证稳定之后再做**。
重构完成后手动回归：主终端拖拽面板宽度、收起/展开面板、切换 session、切换字号（Appearance 设置）、
侧终端开关与面板宽度变化，各测一遍确认无回归。

### 测试

`createResizeScheduler` 是纯逻辑 + 注入依赖，可以像 `test/xterm-viewport-watchdog.test.ts` 那样
用 fake terminal + stub `requestAnimationFrame` 测：

- 尺寸连续变化时不refit，稳定 2 帧后 refit 一次
- `hasPendingWrites` 恒为 true 时，100ms 内不 refit、超过后强行 refit
- `dispose` 后不再有任何 refit
- 首帧调用了 `terminal.refresh`

---

## 任务 B3：`runtime:data` IPC 合批 —— **已实施（2026-08-08）**

### 测量结论（已实测，E_PI_DEBUG 埋点）

| 场景 | chunks/10s | avg chunk | 总量 |
|---|---|---|---|
| 启动/恢复 dump | 5,323 | 998B | 5.3MB |
| 活跃输出 | 21,646 | 999B | 21.6MB |

远超 500/s 阈值 → 已实施合批。合批后同负载 chunks/10s 降至 ~1,000
（IPC 数 ~20 倍下降）。实现：`pi-runtime.ts` 的 `#queueData/#flushBatch`，
8ms timer 或 64KB 上限，onExit flush，单 chunk 批次零拷贝转发，输入方向不动。

### 现状（实施前的分析，保留作参考）

`pi-runtime.ts:419` 的 `child.onData` 与 `index.ts:555` 的 `sendToRenderer` 是 1:1，
每个 PTY chunk 一次结构化克隆 + IPC 边界穿越。pi 的一帧全屏重绘常被 PTY 切成多个 chunk。

### 先测量，再决定是否做

在 `pi-runtime.ts` 加临时埋点（`E_PI_DEBUG=1` 下生效），统计 10 秒窗口内：
chunk 数量、平均 chunk 字节数、总字节数。

```
如果 chunk 数 < 100/s      → 跳过本任务，IPC 不是瓶颈
如果 chunk 数 > 500/s      → 执行下面的合批
```

### 合批方案（仅在测量支持时执行）

在 `pi-runtime.ts` 的 `#globalDataListeners` 分发前加一层per-session 合批：

- 用 `setTimeout(flush, 8)`（或 `setImmediate` + 长度阈值）攒chunk，`flush` 时拼成一个字符串发出。
- **必须保序**：同一 session 的 chunk 只能按到达顺序拼接。
- **必须有字节上限**：单批超过 64KB 立即 flush，避免大输出被延迟。
- **进程退出前必须 flush**：`child.onExit` 与 `instance.dying` 路径都要先 flush 再走后续逻辑，
  否则会丢掉最后一帧。
- **不要动输入方向**（`runtime.write`）：打字回显必须零延迟。

**风险**：8ms 合批会让 TUI 光标动画稍微成块。若观感变差，降到 4ms 或放弃本任务。
这条是**可选优化**，收益不确定，优先级最低。

---

## 明确不要做的事

| 项                                                             | 原因                                                                                                             |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 把 `.sidebar-root` 的 `transition: width 180ms` 换成 transform | offcanvas 面板用 transform 会脱离 grid 流，中间列不会同步变宽，需重构整个 `.app-content` grid 布局，风险远超收益 |
| 恢复 `smoothScrollDuration` 默认值                             | v6 的 `SmoothScrollingOperation` 会把 clamp 后的 scrollTop 烘进动画 `from` 关键帧，是"滚动条跳顶部"的根因        |
| 移除 `xtermScrollbackGuard`                                    | pi 每帧发 `3J`，移除后 scrollback 会被清空                                                                       |
| 调整 write barrier 的 100ms 上限                               | 刚引入，先收集实际数据再调参                                                                                     |
| 在 viewport watchdog 里主动移动 viewport                       | xterm 已把 `viewportY` clamp 在 `[0, baseY]`，主动移动会与用户滚动打架                                           |

---

## 执行顺序与提交粒度

```
1. A1  分段 buffer（含交叉验证测试）           ✅ 已提交 0831990
2. A2  LRU 驱逐（含 store 抽出）                ✅ 已提交 b6d5b88
3. B4  re-render 优化                          ✅ 已提交 4e39c79
4. B5  抽共享 resize scheduler                 ✅ 已提交 fbacc47
5. B3  IPC 合批                                ✅ 已提交 e406a70（含埋点）
```

每个提交都必须：`npx tsc --noEmit && npx vitest run && npx oxlint && npx oxfmt .` 全绿。

## 手动回归清单（每个任务完成后过一遍）

1. 收起 / 展开右侧面板 —— TUI 重排应在~200ms 内完成，无 1s+卡顿
2. agent 高强度输出时收起面板 —— 同上，且不掉帧
3. 拖拽右侧面板宽度 —— 终端跟随，无闪烁
4. 反复切换 session —— scrollback 完整，滚动位置不跳顶部
5. 滚上去看历史时持续输出 —— 视口不被拉走
6. sidebar "Reload session" —— 终端正确重绘，不留白
7. 开7+ 个 session 后切回第一个（验证 A2 驱逐兜底）—— 应被 pi full frame 填满，不留白
8. 修改 Appearance 字号 —— 主终端与侧终端都正确 reflow
