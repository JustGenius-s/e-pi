# E-Pi 文件浏览与上下文注入方案

> 目标：为 E-Pi 补齐 **文件树预览 · 内置编辑器 · 选区添加到对话** 三大能力，并实现与 pi 会话的完整联动。
> 参考实现：LiveAgent（Stack-Cairn/LiveAgent）的文件树 / workspace-editor / mention 体系。
> **交互形态：完整仿照 LiveAgent**（主区 overlay 滑入、编辑器/预览互斥、脏关闭确认、右键插入代码引用）。

## 0. 已确认选型

| 项 | 决策 | 说明 |
|---|---|---|
| 编辑器内核 | **CodeMirror 6** | ~300KB，Electron 友好，选区/行 API 简洁；不引入 Monaco 的 worker 复杂度 |
| 选区→对话格式 | **仅引用链接** | 照搬 LiveAgent：`[file.ts:10-20](src/file.ts#L10-L20)`，只传路径+行号，由 pi 自行 Read |
| 预览范围 | **核心集** | 图片（缩放/旋转/翻页）、Markdown 渲染、纯文本、PDF（iframe） |
| 联动深度 | **完整联动** | fs.watch 驱动树自动刷新；终端/消息中的文件链接可点击回跳编辑器定位行；编辑器保存实时反映到树 |
| **交互形态** | **完整仿照 LiveAgent** | 编辑器/预览为覆盖 workspace 主区的 overlay（左侧滑入动画）；互斥切换；脏关闭 Save all/Discard/Cancel；右键"插入代码引用" |

引用格式兼容性依据：LiveAgent 的 agent 运行时就是 `@earendil-works/pi-ai` + `pi-agent-core`，E-Pi 的 pi 同为 `@earendil-works/pi-coding-agent`，`[label](path#L10-L20)` markdown 引用是其原生支持的输入格式。**Phase E 开工前仍需做一次实测确认**（见 §11 风险）。

---

## 1. 现状与差距

### 1.1 E-Pi 现状

- **文件树** `src/components/workspace/FileTreeView.tsx`：递归懒加载树（无虚拟化、无搜索、无自动刷新）；右键 "Add to Chat" 仅附加**路径字符串**到 composer。
- **Composer** `src/components/workspace/Composer.tsx`：纯 textarea + 附件 chips（`ComposerAttachments`）；图片走 `/e-pi-attach` base64；普通附件序列化为 `Attached path: <绝对路径>` 行。
- **桥接层**：`electron/main/services/file-service.ts` 仅有 `listDir`（硬编码 SKIPPED_DIRS）与 `readFile`（512KB 上限、8192B 二进制探测）；IPC 通道 `fs:list-dir` / `fs:read-file`（`electron/main/index.ts` L367-370）；类型契约在 `src/types/contracts.ts` 的 `EPiApi.fs`。
- **主区结构**：`.app-main` > `SidebarInset.workspace`（`terminal-frame` + `Composer`）。overlay 直接挂 `.workspace` 内。
- **终端链接**：`TerminalPanel.tsx` 用 `@xterm/addon-web-links` 处理 pi TUI 的 OSC 8 链接，目前一律 `window.open` 外部打开。
- **git 联动**：`useGitReview` 已有 `git.watchStart` 监听 repo 状态变化。

### 1.2 与 LiveAgent 的关键差距（抄作业点）

| 能力 | LiveAgent 做法 | E-Pi 落地方式 |
|---|---|---|
| 树数据层 | `fs_list` depth=1 懒加载 + ref 请求去重 + epoch 防乱序 | 保持递归懒加载，加 watcher 失效刷新 |
| 树刷新 | workspace-activity 事件（revision + changedPaths 精确子树刷新） | 新增 fs watcher 服务，事件合并后按目录级刷新 |
| 树搜索 | `fs_mention_list`（主进程 walk + 过滤，180ms 防抖） | main 侧新增 `fs:mention-search` |
| 预览 | 扩展名路由 → **单例 overlay**，base64 → blob URL | 同一路由 + 同一 overlay 形态 |
| 编辑器 | Monaco 多标签 overlay + **版本化读写**（mtime+contentHash，stale_file 冲突） | CodeMirror 6 多标签 overlay + 同一版本化契约 |
| 选区→对话 | 选区扩整行 → `createCodeMentionReference` → 序列化 markdown 链接 → 插入输入框 | 编辑器右键菜单 → composerBus 插入文本（E-Pi 为 textarea，插入纯文本 token，交互位置一致） |
| 链接回跳 | 消息渲染 rewrite 链接 → `open_chat_file_link` 分类 → 编辑器定位行 | 终端 OSC 8 链接拦截 → 编辑器打开定位行 |
| **overlay 状态机** | `useWorkspaceOverlays`：mounted/open/request(id)/closeRequestId/cleanupPending，编辑器/预览/SSH 三互斥 | **移植同构 hook**（去掉 SSH 项，保留 editor/preview 互斥） |

---

## 2. 总体架构

```
┌────────────────────────────── Renderer (React) ─────────────────────────────┐
│  FileTreeView(升级)   ┌── WorkspaceOverlayHost（覆盖 .workspace 主区）──┐    │
│        │             │  WorkspaceCodeEditorOverlay(CM6, 多标签)         │    │
│        │             │  WorkspaceFilePreviewOverlay(核心集)             │    │
│        │             │  互斥滑入/滑出 · 脏关闭对话框                     │    │
│  ┌─────┴───────────┐ └──────────▲───────────────────────────────────┘    │
│  │ useFileTreeData │            │ useWorkspaceOverlays（移植）             │
│  └─────┬───────────┘            │                                          │
│        └────────────── composerBus（插入代码引用 → Composer）───────────┘  │
└───────────────┬─────────────────────────────────────────────────────────────┘
                │ window.ePi.fs.* / window.ePi.workspace.* (preload 透传)
┌───────────────▼─────────────────────────────────────────────────────────────┐
│ Electron Main                                                                │
│  FileService(扩展)                                                           │
│    · readEditableText (mtimeMs + contentHash + totalLines)                   │
│    · writeText (expected mtime/hash → STALE_FILE)                            │
│    · readWorkspaceBinary (base64, 预览用)                                     │
│    · mentionSearch (walk + 过滤, 上限)                                        │
│  WorkspaceWatcherService(新)                                                 │
│    · fs.watch 每活跃 cwd 一个, 事件合并 → workspace:changed                  │
└──────────────────────────────────────────────────────────────────────────────┘
```

关键原则：

1. **安全不变**：所有 fs IPC 继续走 `FileService.isInside(root, path)` 工作区根限定，路径参数统一相对化（renderer 传相对路径，main 侧 resolve）。
2. **渲染层零 Node API**：树/编辑器/预览只依赖 `window.ePi` 契约；preload 仅透传。
3. **版本化写**：编辑器保存必须带读时快照（mtimeMs + contentHash），磁盘被外部改动时拒绝写入并提示，防 LiveAgent 遇到的 `stale_file` 类问题。
4. **引用不内联**：选区→对话只传 `路径 + 行号区间`，内容由 pi 的 Read 工具获取，不污染上下文。

---

## 3. 后端改造（Electron Main + Preload）

### 3.1 `FileService` 扩展（`electron/main/services/file-service.ts`）

```ts
// 新增方法
readEditableText(cwd: string, path: string): Promise<EditableTextResult>
  // { content, mtimeMs, contentHash, sizeBytes, totalLines, binary }
  // 上限 EDITOR_MAX_BYTES = 1MB（超过抛 TooLarge 错误，前端提示只读）
  // contentHash = sha256(content).hex  (node:crypto)
  // mtimeMs = stat.mtimeMs

writeText(cwd, path, content, opts: { expectedMtimeMs?, expectedContentHash? }): Promise<WriteResult>
  // 校验：目标存在且 mtimeMs/contentHash 任一不匹配 → 抛 { code: "STALE_FILE", ... }
  // 成功 → { mtimeMs, contentHash, totalLines, sizeBytes }
  // 原子写：写临时文件 + rename（防半截）

readWorkspaceBinary(cwd, path, maxBytes?): Promise<BinaryResult>
  // { mimeType, data: base64, sizeBytes, mtimeMs }
  // mime 探测：扩展名白名单 + 魔数（复用现有 image-data 的探测思路，扩展 pdf 等）

mentionSearch(cwd, query, limit = 200): Promise<{ entries: {path, kind, name}[], truncated }>
  // walk（跳过 .git/node_modules/dist/out/.next/build/coverage/.venv/venv + 点文件）
  // 大小写不敏感子串匹配（后续可升级 fuzzy）；返回相对 cwd 路径
```

### 3.2 `WorkspaceWatcherService`（新文件 `electron/main/services/workspace-watcher-service.ts`）

- 每活跃会话 cwd 一个 watcher 实例；`fs.watch(dir, { recursive: true })`。
  - macOS/Windows 原生支持 recursive；**Linux 用非递归 + 逐子目录注册的 fallback**（启动时遍历注册、变更时补齐）。
- 事件合并：300ms 窗口内合并 `changedPaths`（去重、归一化为相对路径），只发一次 `workspace:changed { cwd, paths[] }`。
- 生命周期：会话启动注册 / 会话关闭或 cwd 切换注销；单例注册表。
- 与现有 `git.watchStart` 不冲突（git watcher 只关心 status 变化，可后续合并事件源）。

### 3.3 IPC 契约（`src/types/contracts.ts` + `electron/preload/index.ts` + `electron/main/index.ts`）

```ts
// EPiApi.fs 扩展
fs: {
  listDir(cwd, path): Promise<FileEntry[]>;          // 保留
  readFile(cwd, path): Promise<FileContentResult>;   // 保留（现有消费方）
  readEditableText(cwd, path): Promise<EditableTextResult>;   // 新增
  writeText(cwd, path, content, expected?): Promise<WriteResult>;      // 新增
  readWorkspaceBinary(cwd, path, maxBytes?): Promise<BinaryResult>;    // 新增
  mentionSearch(cwd, query, limit?): Promise<MentionSearchResult>;     // 新增
}
// 新增 EPiApi.workspace
workspace: {
  onChanged(listener: (ev: { cwd: string; paths: string[] }) => void): () => void;
}
```

错误契约：`FsBridgeError { code: "STALE_FILE" | "TOO_LARGE" | "BINARY" | "NOT_FOUND" | "OUTSIDE_WORKSPACE", message }`，preload 透传，renderer 侧 `isFsError(e, code)` 判断。

---

## 4. 文件树升级（`FileTreeView.tsx`）

保持递归懒加载结构（E-Pi 项目规模下无虚拟化需求；虚拟化列为 Phase F 可选项），新增：

1. **自动刷新**：订阅 `workspace.onChanged`；事件命中当前 cwd 时，对 `paths` 涉及的已展开目录做局部 force-reload（同 LiveAgent 的"精确子树刷新"思想，按目录粗粒度即可）；300ms 合并由 main 侧完成。
2. **搜索框**：顶部输入框（180ms 防抖）→ `fs.mentionSearch` → 结果列表（点击：文件→打开，目录→展开定位）。
3. **右键菜单扩展**（对齐 LiveAgent `FileTreeContextMenu`）：
   - 文件：`Preview`（核心集内格式）/ `Open in Editor`（可编辑文本）/ 保留 `Open`、`Open With`、`Show in Folder`、`Add to Chat`
   - 目录：保留现有 + `Add to Chat`
   - 预览格式判定：renderer 侧 `workspacePreviewKind(path)`（§5）复用。
4. **双击行为**：目录→展开；文件→预览格式进预览 overlay，否则进编辑器 overlay。
5. **选中高亮与 reveal**：新增 `revealPath(path)`（展开祖先 + 滚动到行），供编辑器右键"在树中显示"、外部 reveal 使用。**打开文件时文件树行保持选中**（LiveAgent 语义：selectedPath 是打开文件的锚点）。

---

## 5. 文件预览（新 `WorkspaceFilePreviewOverlay.tsx` + 路由）

### 5.1 格式路由（`src/lib/workspacePreviewKind.ts`，移植 LiveAgent 思路精简）

```ts
type PreviewKind = "image" | "markdown" | "pdf" | "text";
workspacePreviewKind(path): PreviewKind | null
// image: png jpg jpeg gif webp bmp svg
// markdown: md mdx
// pdf: pdf
// text: log txt + 其余可安全按 UTF-8 解码的（读取后 binary 标志兜底）
```

### 5.2 Overlay UI 与渲染（完整仿照 LiveAgent `WorkspaceFilePreviewOverlay`）

```
┌────────────────────────────────────────────────────────────┐
│ [图标] 文件预览 · <相对路径>        [编辑][重新加载][✕]     │  ← 标题栏 h-11
├────────────────────────────────────────────────────────────┤
│ (错误条 amber，出错时)                                      │
├────────────────────────────────────────────────────────────┤
│  图片: [←] [2/8] [→] │ − 100% + │ ⟳   ← 工具栏 h-10        │
│  MD / PDF / 文本 渲染体（flex-1 overflow-auto）             │
├────────────────────────────────────────────────────────────┤
│ <路径> · mime · 大小                                        │  ← 状态栏 h-8
└────────────────────────────────────────────────────────────┘
```

- 挂载位置：`WorkspaceOverlayHost`（§6.3），`absolute inset-0 z-50` 覆盖 `.workspace`（终端+Composer），左侧滑入动画（`opacity + translate-x`，180ms，对齐 LiveAgent `EDITOR_OVERLAY_ANIMATION_MS`）。
- 读取：`fs.readWorkspaceBinary` → base64 → `Uint8Array` → `Blob` + `URL.createObjectURL`；卸载 revoke。
- 渲染体：
  - **image**：`<img>` + 缩放（0.25–4x，滚轮/按钮）、旋转 90°、**上一张/下一张**（同目录兄弟图片，从文件树节点 children 计算——打开请求携带 `imagePaths`，对齐 LiveAgent `getSiblingImagePaths`）；切换时滑入方向动画（左滑/右滑）。
  - **markdown**：新依赖 `react-markdown` + `remark-gfm`；内部相对路径链接点击 → 打开对应预览/编辑器。
  - **pdf**：sandbox `iframe` + blob URL。
  - **text**：`<pre>` 等宽滚动。
- **可编辑切换**：`.md/.html/.txt/.csv/.tsv`（`isWorkspaceEditablePreviewPath` 语义）→ 标题栏出现"编辑"按钮 → 关预览、开编辑器（对齐 LiveAgent `onOpenEditor`）。

---

## 6. 内置编辑器（新 `WorkspaceCodeEditorOverlay.tsx`）

### 6.1 依赖

```jsonc
// 新增 dependencies
"@codemirror/state", "@codemirror/view", "@codemirror/commands", "@codemirror/language",
"@codemirror/autocomplete", "@codemirror/search", "@codemirror/theme-one-dark",
"@codemirror/lang-javascript", "@codemirror/lang-html", "@codemirror/lang-css",
"@codemirror/lang-json", "@codemirror/lang-markdown", "@codemirror/lang-python",
"@codemirror/lang-yaml", "@codemirror/lang-sql", "@codemirror/lang-xml",
"@codemirror/legacy-modes"   // 兜底：rust/go/java/c/cpp/shell/toml 等
```

语言检测：`languageForPath(path)` 扩展名映射（移植 LiveAgent `WorkspaceCodeEditorOverlay` 的映射表）。

### 6.2 Overlay 结构与核心行为（完整仿照 LiveAgent `WorkspaceCodeEditorOverlay`）

```
┌──────────────────────────────────────────────────────────────┐
│ [✏️] 文件编辑 · <路径>    [保存][查找][替换][重载][预览][✕]  │ ← 工具栏 h-11
├──────────────────────────────────────────────────────────────┤
│ [app.ts ●] [utils.ts] [readme.md ⚠]                          │ ← 文件标签栏 h-10
├──────────────────────────────────────────────────────────────┤
│ (amber 错误条：冲突 → Reload from disk 按钮)                  │
├──────────────────────────────────────────────────────────────┤
│                  CodeMirror 6 主区 (flex-1)                   │
│                  右键菜单（自绘，见 §7）                       │
├──────────────────────────────────────────────────────────────┤
│ <目录> · 语言 · 行数 · 大小 · 未保存●                          │ ← 状态栏 h-7
└──────────────────────────────────────────────────────────────┘
```

1. **多标签**：`EditorTab[]`，tab 键 = `${projectKey}\0${path}`；每 tab 独立 `EditorState`（CodeMirror 天然按 state 隔离，无需 model 池）；切换 tab 保留滚动位置（`scrollDOM.scrollTop` 快照）。tab 显示 basename + 脏点 + 冲突 ⚠；✕ 关闭。
2. **打开**：`fs.readEditableText` → 组装 CM6 `EditorState`；加载中 spinner；失败提示。
3. **编辑与脏标记**：`updateListener` 对比 `content !== savedContent` 标脏。
4. **保存（版本化）**：`fs.writeText` 带 `{ expectedMtimeMs, expectedContentHash }`；`STALE_FILE` → amber 警告条 + 三选一：**Reload from disk / 强制覆盖 / 忽略**。保存成功更新 tab 快照。⌘S 保存（window keydown，仅 overlay 打开时拦截，对齐 LiveAgent）。
5. **只读保护**：二进制（`binary`）、超 1MB → `EditorState.readOnly`，状态栏徽标；只读也能选区→对话。
6. **行定位**：`revealLines(tabKey, startLine, endLine)` → dispatch selection + `scrollIntoView`；打开请求携带 `line/endLine/column` 时定位（对齐 LiveAgent `linkedLocationKeyRef` 去重逻辑）。
7. **预览切换**：可预览格式（§5.1 核心集）→ 工具栏"预览"按钮 → 关编辑器、开预览（对齐 `onPreviewFile`）。
8. **隐藏 vs 关闭**：`hideOverlay`（暂隐藏——被预览/其他 overlay 顶掉时）/ `finalClose`（真正关闭，✕）；脏时 `pendingDialog closeOverlay`：**Save all / Discard / Cancel**（对齐 LiveAgent）。

### 6.3 Overlay 状态机与宿主（移植 `useWorkspaceOverlays` + 新 `WorkspaceOverlayHost`）

**`src/hooks/useWorkspaceOverlays.ts`**（移植 LiveAgent，去掉 SSH 项）：

```ts
{
  editorMounted, editorOpen, editorCleanupPending,
  editorOpenRequest: { id, projectPathKey, workdir, path, line?, endLine?, column? } | null,
  editorCloseRequestId,
  previewMounted, previewOpen, previewOpenRequest: { id, workdir, path, imagePaths? } | null,
  openEditorFile(request), openFilePreview(request),
  requestEditorClose(), requestPreviewClose(), handlePreviewClosed(),
  // 互斥：openEditorFile → previewOpen=false；openFilePreview → editorOpen=false
}
```

**`src/components/workspace/WorkspaceOverlayHost.tsx`**：挂 `.workspace` 内，条件渲染两个 overlay（mounted 才渲染，open 控制动画）；接收 App 下发的打开请求与关闭请求。**文件树 tab 关闭 → 编辑器 cleanup**（对齐 LiveAgent：right-dock file tree tab 关闭且 editor mounted → cleanupPending → 请求关闭 → 脏确认）。

---

## 7. 选区 → 对话（引用链接）

### 7.1 编辑器侧（完整仿照 LiveAgent 右键菜单）

- 右键菜单项 **"插入代码引用"**（选中态）/ 空选区退化当前行（对齐 `insertSelectionAsCodeMention`：`startLine`/`endLine`，选区结束列=1 时收一行）。
- 序列化（移植 `mentionReferences.ts` 的 `createCodeMentionReference` / `formatCodeMentionToken`，相对 cwd 路径）：

```
[file.ts:10-20](src/file.ts#L10-L20)     // 选区跨行
[file.ts:10](src/file.ts#L10)            // 单行
```

- 发送目标：**composerBus**（新 `src/lib/composerBus.ts`，仿 `attachmentsBus` 的模块级 pub/sub）：`insertTextAtCaret(token)` + `focus()`。

### 7.2 Composer 侧（`Composer.tsx` 小改）

- 订阅 bus：`insertTextAtCaret(text)` → 在 textarea 光标处插入文本（`setRangeText` + 重设 caret + 触发 onChange 逻辑），聚焦输入框。
- **发送格式不变**：引用链接作为纯文本随消息发出（pi 原生支持 markdown 引用）。
- 与现有 `Attached path:` 附件机制并存：附件=整文件路径；引用=精确行区间，互不干扰。
- 差异说明：LiveAgent 输入框是 contenteditable 芯片编辑器，E-Pi 保持 textarea——**插入位置、焦点行为、右键入口完全一致**，仅"引用以纯文本 token 呈现而非 chip"。

---

## 8. 完整联动：链接回跳与树刷新

### 8.1 终端链接 → 编辑器（`TerminalPanel.tsx` 的 `WebLinksAddon` 回调改造）

- 回调中先尝试解析 `uri`：
  - `file://<abs>` 或 workspace 相对路径 + `#L<line>(-L<line>)` 后缀 → **内部打开**：`openEditorFile(path, { line })`（先做 workspace 归属校验，越界则退回外部打开）。
  - 其余 → 维持 `window.open` 外部打开。
- 保留 ⌘/Ctrl+点击语义（防误触）。

### 8.2 编辑器保存 → 树刷新

- 保存走 `fs.writeText`（main 进程真实写入）→ 同目录的文件监听器（若有）自然触发 `workspace:changed` → 树局部刷新。无需额外联动代码；watcher 未覆盖的 cwd（无活跃会话监听）由编辑器保存成功后**主动广播**一次变更兜底（main 侧 `workspaceService.notify(cwd, [path])`）。

### 8.3 树 ↔ 编辑器互跳

- 树右键文件 → "在编辑器中打开"；编辑器右键 → "在树中显示"（`revealPath`，文件树 tab 自动打开并定位）。

---

## 9. 实施阶段与验证

### Phase A — 后端 IPC（无 UI）
- 文件：`file-service.ts`（readEditableText/writeText/readWorkspaceBinary/mentionSearch）、新 `workspace-watcher-service.ts`、`contracts.ts`、`preload/index.ts`、`electron/main/index.ts`（注册通道）
- 测试：`test/file-service.test.ts`（vitest，覆盖：版本化冲突、原子写、二进制探测、越界拒绝、mention 过滤）、watcher 合并逻辑单测
- 验证：`npm run test && npm run typecheck`

### Phase B — 文件树升级
- 文件：`FileTreeView.tsx`（搜索框、watcher 刷新、右键 Preview/Open in Editor、revealPath、双击路由入口）、`contracts` 消费
- 验证：手动开两个项目，外部 `touch` 文件观察树自动刷新；搜索定位

### Phase C — 预览 overlay
- 文件：`workspacePreviewKind.ts`、`WorkspaceFilePreviewOverlay.tsx`、`useWorkspaceOverlays.ts`（预览部分）、`WorkspaceOverlayHost.tsx`、`App.tsx`（host 接入 + 打开路由）、新依赖 `react-markdown`/`remark-gfm`
- 验证：png/jpg/md/pdf/txt 各打开一次（overlay 滑入动画、互斥）；大图缩放旋转；跨目录图片翻页；md 中"编辑"按钮切编辑器

### Phase D — 编辑器 overlay
- 文件：`WorkspaceCodeEditorOverlay.tsx`、`languageForPath.ts`、`useWorkspaceOverlays.ts`（编辑器部分）、CM6 依赖
- 验证：多标签打开/切换/关闭（脏提示、Save all/Discard/Cancel）；⌘S 保存；外部改文件后保存触发冲突三选一；>1MB/二进制只读；✕ 关闭滑出动画回终端

### Phase E — 选区→对话 + 链接回跳
- 文件：`composerBus.ts`、编辑器右键菜单、`Composer.tsx`（bus 订阅）、`TerminalPanel.tsx`（链接拦截解析）
- **前置实测**：向 pi 发一条 `[file.ts:10-20](src/file.ts#L10-L20)` 消息，确认 pi 正确 Read 该区间（备选方案见 §11）
- 验证：编辑器选区 → 右键 → 引用插入输入框 → 发送 → pi 回复内容命中选中区间；终端里 pi 输出的文件链接（若带 OSC 8）点击 → 编辑器定位

### Phase F — 打磨（可裁剪）
- 树虚拟化（超大项目）、text 预览行号、编辑器 tab 拖拽排序、fuzzy 搜索升级、⌘P 快速打开、编辑器顶栏脏点透出（overlay 隐藏时提示未保存）

---

## 10. 测试策略

- **单测（vitest）**：`mentionReferences` 序列化/反序列化往返、`workspacePreviewKind` 路由、`languageForPath` 映射、FileService 全部新方法（临时目录 fixture）、watcher 合并窗口（fake timers）、overlay 状态机 reducer（mounted/open/cleanup 转换）。
- **类型门禁**：`npm run typecheck`（contracts 改动必跑）。
- **手动验收清单**（每 Phase 结尾）：见各 Phase "验证"。
- **回归**：现有 `file-tree` 相关（git review 等）不受影响——fs 契约只增不改，`readFile` 保留。

---

## 11. 风险与备选

| 风险 | 应对 |
|---|---|
| pi 对 `[label](path#L10-L20)` 引用的实际解析行为未实测 | Phase E 前置 30 分钟实测；若 pi 不识别，退化为发送时转换：`请查看 src/file.ts 第 10-20 行` + 保留链接文本 |
| `fs.watch` recursive 平台差异（Linux 不支持 recursive） | main 侧按平台分派：Linux 目录遍历注册 + 变更补注册；事件丢失可接受（保存后主动广播兜底） |
| CodeMirror 语言包体积 | 按需引入（核心官方包 + legacy-modes 兜底）；CI 里 `pnpm build` 观察 bundle |
| 大文件/二进制误判 | readEditableText 1MB 上限 + binary 标志只读；预览 binary 探测失败时渲染 text 但截断提示 |
| 编辑器与终端抢占焦点（⌘S 全局快捷键） | ⌘S 仅在编辑器 overlay open 时拦截；xterm 快捷键不受影响 |
| overlay 遮挡 Composer 导致"发送中看不到输入" | LiveAgent 同构（overlay 本就覆盖主区）；关闭后焦点回 Composer（对齐 LiveAgent `focusEditorAtSavedSelection` 思路：关闭时若此前焦点在编辑器则恢复） |
| 会话切换（activeCwd 变化）时 overlay 残留 | 对齐 LiveAgent 的"文件树 tab 关闭 → cleanup"语义：会话切换 → cleanupPending → 请求关闭；脏 → Save all/Discard/Cancel |

---

## 12. 涉及文件清单（新增/修改）

**修改**：`electron/main/index.ts`、`electron/main/services/file-service.ts`、`electron/preload/index.ts`、`src/types/contracts.ts`、`src/components/workspace/FileTreeView.tsx`、`src/components/workspace/Composer.tsx`、`src/components/workspace/TerminalPanel.tsx`、`src/App.tsx`、`package.json`

**新增**：`electron/main/services/workspace-watcher-service.ts`、`src/hooks/useWorkspaceOverlays.ts`、`src/components/workspace/WorkspaceOverlayHost.tsx`、`src/components/workspace/WorkspaceCodeEditorOverlay.tsx`、`src/components/workspace/WorkspaceFilePreviewOverlay.tsx`、`src/lib/composerBus.ts`、`src/lib/workspacePreviewKind.ts`、`src/lib/mentionReferences.ts`（移植）、`test/file-service.test.ts`、`test/mentionReferences.test.ts`、`test/workspaceOverlays.test.ts`
