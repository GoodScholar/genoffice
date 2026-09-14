# Markdown Lossless Editing Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Markdown 文件在未编辑时打开→保存逐字节不变，并让可视化编辑、源码模式、AI 与保存链路共享同一个区域级无损会话。

**Architecture:** 以完整源码为事实来源，新增深模块 `MarkdownDocumentSession`。Marked token 的原始切片用于建立源码单元，TipTap 只承载可视化投影；未变化单元复用原始切片，变化单元才通过 codec 序列化。无法安全表示的 HTML、注释、旧 `:::` fenced div 和歧义范围投影成不可编辑 atom，所有写入都由会话统一校验和拼接。

**Tech Stack:** TypeScript 5.9、React 19、TipTap/ProseMirror 3.31、Marked（通过 `editor.markdown.instance`）、Electron IPC、Vitest 4 + jsdom。

**Spec:** [2026-09-14-markdown-lossless-editing-design.md](../specs/2026-09-14-markdown-lossless-editing-design.md)

## Global Constraints

- 完整源码始终是唯一保存来源；任何路径都不得回退到整篇 `editor.getMarkdown()` 覆盖源码。
- 未编辑单元必须复用原始 `raw`，不得通过“重新序列化后再 diff”猜测保真结果。
- 无法证明边界安全时扩大保护范围；整篇无法安全投影时保留输入并进入源码模式。
- 保留片段的删除、替换、转换和 AI patch 必须先确认；确认前不得改变会话或触发自动保存。
- 普通 AI 结构化操作必须在执行前整体预检，命中保留片段时整批拒绝，不能先改一半再失败。
- Save As 的图片路径改写以主进程实际返回的 `text` 为准；保存期间的新编辑不能被成功回包覆盖。
- 不新增源码编辑器依赖；首期使用可靠的原生 `textarea`，不扩展语法高亮、行号或主题能力。
- 每个任务只提交本任务列出的文件；提交前运行对应测试和 `git diff --check`。

## File Structure

### New files

- `apps/markdown/src/renderer/markdown/sourceScanner.ts` — 基于 token/raw 覆盖关系识别源码单元与保护范围。
- `apps/markdown/src/renderer/markdown/sourceProjection.ts` — 源码单元与 TipTap JSON 之间的投影、来源标记和局部序列化。
- `apps/markdown/src/renderer/markdown/documentSession.ts` — 唯一的源码事实、revision、dirty、模式和保存基线。
- `apps/markdown/src/renderer/markdown/sourcePatch.ts` — 转换/AI patch 的创建、过期校验与确认应用。
- `apps/markdown/src/renderer/markdown/featureFlag.ts` — 开发期隐藏开关，最终任务切到默认启用。
- `apps/markdown/src/renderer/editor/protectedSource.ts` — 块级/内联 atom、来源属性与破坏性 transaction 守卫。
- `apps/markdown/src/renderer/editor/ProtectedSourceView.tsx` — 受保护源码片段的 React NodeView。
- `apps/markdown/src/renderer/components/SourceEditor.tsx` — 全文源码 textarea 与范围选中。
- `apps/markdown/src/renderer/components/ProtectedChangeConfirm.tsx` — 删除/替换确认。
- `apps/markdown/src/renderer/ai/SourcePatchCard.tsx` — 源码 patch diff、确认、过期提示。
- `apps/markdown/tests/fixtures/lossless/core-gfm.md` — GFM、数学、Mermaid 组合语料。
- `apps/markdown/tests/fixtures/lossless/typora-html.md` — Typora/HTML、注释、图片尺寸、`u`/`mark` 语料。
- `apps/markdown/tests/fixtures/lossless/legacy-and-malformed.md` — `:::`、不完整标签和歧义嵌套语料。
- `apps/markdown/tests/source-scanner.test.ts` — 扫描器、范围和 fail-safe 测试。
- `apps/markdown/tests/source-projection.test.ts` — TipTap 投影、atom、来源和局部序列化测试。
- `apps/markdown/tests/document-session.test.ts` — 无损、重写窗口、模式、dirty、保存 revision 测试。
- `apps/markdown/tests/source-mode.test.tsx` — 源码模式、定位、切换和错误保留测试。
- `apps/markdown/tests/protected-change.test.ts` — 删除/替换/移动的 transaction 守卫测试。
- `apps/markdown/tests/source-patch.test.ts` — 转换与 AI patch 的确认和过期测试。
- `apps/markdown/tests/save-session.test.ts` — renderer 保存协调与主进程实际文本同步测试。

### Existing files to modify

- `apps/markdown/src/renderer/markdown/docText.ts` — 增加保留原始 EOL/offset 的 envelope 拆分函数；旧 API 暂保留给迁移期测试。
- `apps/markdown/src/renderer/editor/extensions.ts` — 注册来源属性、protected nodes、NodeView 和守卫。
- `apps/markdown/src/renderer/editor/ops.ts` — 去掉 AI 内容的破坏性 `stripLegacyFencedDivs`，暴露操作影响范围预检。
- `apps/markdown/src/renderer/App.tsx` — 接入 session、模式切换、保存 ticket 和确认 UI。
- `apps/markdown/src/renderer/components/Ribbon.tsx` — 增加可视化/源码模式切换，源码模式禁用结构化命令。
- `apps/markdown/src/renderer/ai/tools.ts` — 读取受保护源码、普通写预检、显式 patch 工具、源码模式写禁用。
- `apps/markdown/src/renderer/ai/markdown-skill.ts` — 注入 session access 并更新系统约束。
- `apps/markdown/src/renderer/ai/AiPanel.tsx` — 接收 patch proposal 并显示确认卡。
- `apps/markdown/src/renderer/export/docxExport.ts` — 受保护源码按文字导出。
- `apps/markdown/src/renderer/export/printHtml.ts` — 清理交互控件，仅保留已转义源码文本。
- `apps/markdown/src/renderer/i18n/strings.ts` — 所有现有语言增加模式、保护、确认和 patch 文案键。
- `apps/markdown/src/renderer/styles.css` — 源码编辑器、保护节点、确认层和 patch 卡样式。
- `apps/markdown/src/shared/ipc.ts` — 成功保存结果增加主进程实际写入的 `text`。
- `apps/markdown/src/main/markdown-main.ts` — 返回 `textToWrite`。
- `apps/markdown/tests/doc-text.test.ts` — 新 envelope 边界测试，移除“打开时剥离旧 fenced div”的产品预期。
- `apps/markdown/tests/markdown-nodes.test.ts` — 将 HTML 降级断言改成 protected projection 断言。
- `apps/markdown/tests/ai-tools.test.ts` — AI 保护与源码模式写禁用测试。
- `apps/markdown/tests/docx-export.test.ts`、`apps/markdown/tests/print-html.test.ts` — 安全导出测试。
- `apps/markdown/tests/asset-lifecycle.test.ts` — Save As 返回实际改写文本的集成断言。
- `apps/markdown/vitest.config.ts` — 测试 include 同时接纳 `.test.tsx`。

---

## Task 1: 建立黄金语料与可证明覆盖的源码扫描器

**Files:**

- Create: `apps/markdown/tests/fixtures/lossless/core-gfm.md`
- Create: `apps/markdown/tests/fixtures/lossless/typora-html.md`
- Create: `apps/markdown/tests/fixtures/lossless/legacy-and-malformed.md`
- Create: `apps/markdown/tests/source-scanner.test.ts`
- Create: `apps/markdown/src/renderer/markdown/sourceScanner.ts`
- Modify: `apps/markdown/src/renderer/markdown/docText.ts`
- Modify: `apps/markdown/tests/doc-text.test.ts`

**Interfaces:**

```ts
export interface SourceRange {
  from: number
  to: number
}

export type ProtectedReason =
  | 'raw-html'
  | 'html-comment'
  | 'legacy-fenced-div'
  | 'ambiguous-inline-html'
  | 'parse-failure'

export interface SourceToken {
  type: string
  raw: string
  tokens?: SourceToken[]
}

export interface ScannedUnit {
  id: string
  raw: string
  range: SourceRange
  trailingRaw: string
  protection: null | {
    display: 'inline' | 'block'
    reason: ProtectedReason
    ranges: SourceRange[]
  }
}

export interface SourceScan {
  units: ScannedUnit[]
  fallbackToSource: boolean
  error?: string
}

export function scanMarkdownSource(
  bodyRaw: string,
  lex: (source: string) => SourceToken[],
  idPrefix?: string,
): SourceScan
```

- [ ] 在三个 fixture 中写入规范要求的 GFM、frontmatter、数学、Mermaid、块级/内联 HTML、HTML 注释、`details`、style、图片 width、`u`、`mark`、旧 `:::` 和畸形组合；fixture 只承载 LF 文本，CRLF/BOM/无末尾换行在测试中由字符串变换生成。
- [ ] 在 `source-scanner.test.ts` 先写失败测试：token `raw` 按顺序覆盖正文，空行进入 `trailingRaw`，代码 fence 内的 HTML/`:::` 不被保护，边界明确的 inline HTML 只返回内联范围，畸形/歧义 inline HTML 扩大到整个块，lexer 抛错或 `raw` 无法连续覆盖时 `fallbackToSource === true`。
- [ ] 运行 `npm test -w @genoffice/markdown -- --run tests/source-scanner.test.ts`，确认失败原因是模块不存在/行为缺失。
- [ ] 在 `docText.ts` 增加不归一化正文的拆分结果，供 session 保留真实 offset：

```ts
export interface RawDocEnvelope {
  bomRaw: '' | '\uFEFF'
  frontmatterRaw: string
  bodyRaw: string
  bodyOffset: number
  eol: '\n' | '\r\n'
  trailingNewline: boolean
}

export function parseRawDocEnvelope(source: string): RawDocEnvelope
```

- [ ] 实现 `scanMarkdownSource`：先用状态机排除 backtick/tilde fenced code，再识别成对旧 fenced div；随后消费 lexer 的顶层 token `raw`，用单调 cursor 校验完整覆盖，不允许 `indexOf` 跳过未知字符。
- [ ] 对 inline token 使用相对 cursor 校验 `raw`；成对且不跨块的 HTML token产出内联保护范围，不完整标签、交叉嵌套或 inline raw 无法精确对齐时将整个顶层 unit 标记为块级保护。
- [ ] 用稳定的 session-local 序号生成 `id`（例如 `s0-b3`），禁止随机值进入文件或快照测试。
- [ ] 补充 `doc-text.test.ts`：BOM 和 CRLF 下 `bodyOffset` 是原始字符串 offset，frontmatter 后空行属于 `frontmatterRaw`，正文仍保留 CRLF。
- [ ] 运行 `npm test -w @genoffice/markdown -- --run tests/source-scanner.test.ts tests/doc-text.test.ts`，确认通过。
- [ ] 运行 `git diff --check`。
- [ ] 仅暂存本任务文件：`git add apps/markdown/src/renderer/markdown/sourceScanner.ts apps/markdown/src/renderer/markdown/docText.ts apps/markdown/tests/source-scanner.test.ts apps/markdown/tests/doc-text.test.ts apps/markdown/tests/fixtures/lossless`；提交：`git commit -m "test(markdown): define lossless source corpus"`。

---

## Task 2: 建立 TipTap 来源属性与受保护源码投影

**Files:**

- Create: `apps/markdown/src/renderer/editor/protectedSource.ts`
- Create: `apps/markdown/src/renderer/markdown/sourceProjection.ts`
- Create: `apps/markdown/tests/source-projection.test.ts`
- Modify: `apps/markdown/src/renderer/editor/extensions.ts`
- Modify: `apps/markdown/tests/markdown-nodes.test.ts`

**Interfaces:**

```ts
export interface MarkdownCodec {
  lex(source: string): SourceToken[]
  parse(source: string): JSONContent
  serialize(doc: JSONContent): string
}

export interface VisualProjection {
  doc: JSONContent
  frontmatterInner: string
}

export interface ProjectedFragment {
  id: string
  raw: string
  range: SourceRange
  display: 'inline' | 'block'
  reason: ProtectedReason
}

export interface ProjectionResult {
  visual: VisualProjection
  fragments: ProjectedFragment[]
  fingerprints: Map<string, string>
  fallbackToSource: boolean
}

export function createTiptapMarkdownCodec(editor: Editor): MarkdownCodec
export function projectScan(scan: SourceScan, codec: MarkdownCodec): ProjectionResult
export function serializeProjectedGroup(nodes: JSONContent[], codec: MarkdownCodec): string
```

- [ ] 先写失败测试：HTML block 变成 `protectedSourceBlock`；段落中的明确 HTML 变成 `protectedSourceInline`，左右 GFM 仍可编辑；旧 `:::` 整体成为 block atom；同一 token 解析成多个顶层节点时共享同一个 `sourceId`；投影不得丢失 raw。
- [ ] 把 `markdown-nodes.test.ts` 中“legacy HTML degrades”五个断言改为调用 `projectScan`，分别断言原始 `<span>`、`<p style>`、`<img width>`、`<u>`、`<mark>` 存在于 protected node attrs；不再接受标签消失。
- [ ] 运行 `npm test -w @genoffice/markdown -- --run tests/source-projection.test.ts tests/markdown-nodes.test.ts`，确认新断言失败。
- [ ] 在 `protectedSource.ts` 定义 `SourceProvenance` global attribute 和两个 atom：

```ts
const sourceAttr = {
  default: null,
  parseHTML: () => null,
  renderHTML: () => ({}),
}

export const ProtectedSourceBlock = Node.create({
  name: 'protectedSourceBlock',
  group: 'block',
  atom: true,
  selectable: true,
  addAttributes() {
    return { id: {}, raw: {}, reason: {}, sourceId: sourceAttr }
  },
})

export const ProtectedSourceInline = Node.create({
  name: 'protectedSourceInline',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return { id: {}, raw: {}, reason: {}, sourceId: sourceAttr }
  },
})
```

- [ ] `SourceProvenance` 只给当前可编辑 block 类型增加 `sourceId`，`rendered: false`，确保来源信息不进 HTML、不进 Markdown 文件。
- [ ] `projectScan` 对受保护 block 直接造 atom JSON；对 inline 保护片段用源文件中不存在的私用区 sentinel 暂代，codec parse 后递归把 sentinel text 拆成左右 text + inline atom；找不到 sentinel 时把整个 unit 降为 block atom。
- [ ] fingerprint 使用稳定 JSON（递归删除 `sourceId` 后 `JSON.stringify`），同一个源 unit 的多个顶层节点合并计算，禁止依赖 ProseMirror 对象身份。
- [ ] `serializeProjectedGroup` 先把 inline atom 替换成唯一 sentinel，调用 codec，再按 id 把 sentinel 替换回精确 `raw`；sentinel 缺失、重复或新增时抛出一致性错误。
- [ ] 将扩展注册到 `buildExtensions`，暂用安全的 `<code data-protected-source>` DOM fallback 渲染，内容通过 text node 输出，不用 `dangerouslySetInnerHTML`。
- [ ] 运行本任务两组测试和 `npm run typecheck -w @genoffice/markdown`。
- [ ] 运行 `git diff --check`。
- [ ] 仅暂存本任务文件：`git add apps/markdown/src/renderer/editor/protectedSource.ts apps/markdown/src/renderer/markdown/sourceProjection.ts apps/markdown/src/renderer/editor/extensions.ts apps/markdown/tests/source-projection.test.ts apps/markdown/tests/markdown-nodes.test.ts`；提交：`git commit -m "feat(markdown): project protected source nodes"`。

---

## Task 3: 实现 `MarkdownDocumentSession` 深模块

**Files:**

- Create: `apps/markdown/src/renderer/markdown/documentSession.ts`
- Create: `apps/markdown/tests/document-session.test.ts`

**Interfaces:**

```ts
export type EditorMode = 'visual' | 'source'

export interface SessionView {
  source: string
  visual: VisualProjection
  protectedFragments: ProjectedFragment[]
  dirty: boolean
  revision: number
  mode: EditorMode
  sourceSelection?: SourceRange
  fallbackReason?: string
}

export type SessionUpdate =
  | { ok: true; view: SessionView; changedRange?: SourceRange }
  | { ok: false; view: SessionView; error: string }

export interface SaveTicket {
  revision: number
  source: string
}

export interface MarkdownDocumentSession {
  view(): SessionView
  applyVisual(next: VisualProjection): SessionUpdate
  applySource(next: string): SessionUpdate
  enterSource(fragmentId?: string): SessionUpdate
  enterVisual(): SessionUpdate
  serialize(): string
  beginSave(): SaveTicket
  markSaved(sourceActuallyWritten: string, ticket: SaveTicket): SessionView
}

export function createMarkdownDocumentSession(
  source: string,
  codec: MarkdownCodec,
): MarkdownDocumentSession
```

- [ ] 先写 table-driven 失败测试：每个 fixture 以及派生的 CRLF/BOM/无末尾换行版本，`serialize() === input` 且 `dirty === false`。
- [ ] 写失败测试：只改第二个普通段落时，首段表格空格、相邻空行、HTML raw、文件 EOL 和 EOF 状态保持原样；新增节点只在插入边界使用当前文档 EOL 的规范分隔符。
- [ ] 写失败测试：原有 unit 整体移动时移动 `raw + trailingRaw` 而不重新序列化；删除普通 unit 删除其拥有的分隔符；保护 unit 未获确认时 `applyVisual` 返回错误且 source 不变。
- [ ] 写失败测试：`applySource` 成功后 revision +1 并重建 ranges；失败时完整输入仍成为 `view.source`、mode 为 `source`、`serialize()` 仍可保存该输入。
- [ ] 写失败测试：`enterSource(fragmentId)` 返回当前新鲜 range；无编辑来回切换不 dirty、不增 revision；有源码改动返回视觉模式时是单次 session revision。
- [ ] 写失败测试：`beginSave()` 固定 revision/source；同 revision 的 `markSaved(text, ticket)` 同步 Save As 改写后的 source 并清 dirty；保存期间 revision 已变化时只更新 saved baseline，当前 source 不被旧回包覆盖且继续 dirty。
- [ ] 运行 `npm test -w @genoffice/markdown -- --run tests/document-session.test.ts`，确认失败。
- [ ] 实现私有 `SourceUnitState`，只在模块内部保存 `raw`、`trailingRaw`、sourceId、fingerprint 和 protected fragments；调用方只看到 `SessionView`。
- [ ] `applyVisual` 按顶层 `sourceId` 分组：fingerprint 未变复用旧 raw；group 顺序变化搬运旧 raw；新 group 或变更 group 调 `serializeProjectedGroup`；任何 protected id/raw 丢失先返回错误，不修改内部状态。
- [ ] 对结构合并/拆分，把连续受影响 group 和夹在其间的 separator 合成单一重写窗口；窗口外从旧 source 直接 slice，完成后重新扫描并校验投影等价。
- [ ] `serialize()` 仅返回当前已拼好的 source；先断言 unit ranges 连续、拼接等于内存 source，失败即抛错，绝不临时调用 codec 生成全文。
- [ ] `markSaved` 校验 ticket.source 与写盘请求一致；同 revision 时用实际写入文本重建 session，异 revision 时仅替换 baseline，并通过字符串比较计算 dirty。
- [ ] 运行该测试、`npm run typecheck -w @genoffice/markdown` 和 `git diff --check`。
- [ ] 仅暂存本任务文件：`git add apps/markdown/src/renderer/markdown/documentSession.ts apps/markdown/tests/document-session.test.ts`；提交：`git commit -m "feat(markdown): add source-backed document session"`。

---

## Task 4: 接入 renderer 保存链路并同步主进程实际写入文本

**Files:**

- Create: `apps/markdown/src/renderer/markdown/featureFlag.ts`
- Create: `apps/markdown/tests/save-session.test.ts`
- Modify: `apps/markdown/src/renderer/App.tsx`
- Modify: `apps/markdown/src/shared/ipc.ts`
- Modify: `apps/markdown/src/main/markdown-main.ts`
- Modify: `apps/markdown/tests/asset-lifecycle.test.ts`

**Interfaces:**

```ts
export type SaveMarkdownResult =
  | {
      ok: true
      path: string
      text: string
      imageRewrites?: Array<{ from: string; to: string }>
    }
  | { ok: true; canceled: true }
  | { ok: false; error: string }

export function losslessMarkdownEnabled(
  search: string,
  isDev: boolean,
): boolean
```

- [ ] 先写失败测试：主进程普通保存回包的 `text` 等于 request text；跨目录 Save As 回包的 `text` 等于 `prepareAssetsForSaveAs` 处理后的实际文本。
- [ ] 在 `save-session.test.ts` 写失败测试：无编辑保存清 dirty；保存等待期间发生 visual edit 时成功回包不清 dirty；Save As 图片改写同步到 session，但不覆盖等待期间的新文本。
- [ ] 运行 `npm test -w @genoffice/markdown -- --run tests/save-session.test.ts tests/asset-lifecycle.test.ts`，确认失败。
- [ ] 修改 IPC 成功类型和主进程返回值，返回写入原子文件的同一个变量：

```ts
return done({
  ok: true,
  path: target,
  text: textToWrite,
  ...(prepared?.rewrites.length ? { imageRewrites: prepared.rewrites } : {}),
})
```

- [ ] 实现开发期开关：仅 `import.meta.env.DEV && ?losslessMarkdown=1` 启用新路径；生产路径在 Task 9 切换，开关不写用户文档。
- [ ] `App.tsx` 增加 `sessionRef`、`syncingProjectionRef`；打开时创建 session，并用 `session.view().visual.doc` 初始 `setContent`，设置 `addToHistory=false`，完全移除新路径中的 `stripLegacyFencedDivs`。
- [ ] `onUpdate` 在非 `uiOnly`、非投影同步 transaction 时调用 `session.applyVisual({ doc: editor.getJSON(), frontmatterInner })`；失败时保持已有 source、标记错误并切源码模式，不调用旧 serializer。
- [ ] frontmatter 修改通过同一个 `applyVisual` 提交；dirty 始终取 `session.view().dirty`，主进程 dirty flag 只镜像该值。
- [ ] `doSave` 改为 `const ticket = session.beginSave()`，图片引用从 ticket.source 加上当前 visual image 节点汇总；IPC 前只使用 `ticket.source`。
- [ ] 成功回包时先应用 `imageRewrites` 到 live TipTap；如果 revision 未变化，用 `result.text` 重建 session/visual 且不进 undo history；最后 `session.markSaved(result.text, ticket)`。revision 已变化时保留当前 session，依据 baseline 比较继续 dirty。
- [ ] 保存一致性错误必须在调用 `window.markdownApi.save` 前进入 failed 状态；补测试断言 IPC mock 未调用。
- [ ] 运行本任务测试、现有 `tests/doc-text.test.ts`、`npm run typecheck -w @genoffice/markdown` 和 `git diff --check`。
- [ ] 仅暂存本任务文件：`git add apps/markdown/src/renderer/markdown/featureFlag.ts apps/markdown/src/renderer/App.tsx apps/markdown/src/shared/ipc.ts apps/markdown/src/main/markdown-main.ts apps/markdown/tests/save-session.test.ts apps/markdown/tests/asset-lifecycle.test.ts`；提交：`git commit -m "feat(markdown): save source-backed sessions"`。

---

## Task 5: 增加整篇源码模式与可靠的模式切换

**Files:**

- Create: `apps/markdown/src/renderer/components/SourceEditor.tsx`
- Create: `apps/markdown/tests/source-mode.test.tsx`
- Modify: `apps/markdown/src/renderer/App.tsx`
- Modify: `apps/markdown/src/renderer/components/Ribbon.tsx`
- Modify: `apps/markdown/src/renderer/i18n/strings.ts`
- Modify: `apps/markdown/src/renderer/styles.css`
- Modify: `apps/markdown/vitest.config.ts`

**Interfaces:**

```ts
export interface SourceEditorProps {
  value: string
  selection?: SourceRange
  disabled?: boolean
  onChange(next: string): void
  onExit(): void
}

export interface RibbonProps {
  editor: Editor | null
  mode: 'visual' | 'source'
  onModeChange(mode: 'visual' | 'source'): void
  disabled: boolean
  // existing props stay unchanged
}
```

- [ ] 将 Vitest include 改为 `tests/**/*.test.{ts,tsx}`，先写组件失败测试：传入 selection 后 textarea focus 且 `selectionStart/End` 正确；输入原样回传 CRLF/BOM；Cmd/Ctrl+S 不被组件拦截。
- [ ] 写 App 级纯 helper/组件测试：无编辑视觉→源码→视觉不增 revision/dirty；源码改动后视觉文档重建；投影失败停留源码模式且 textarea 保留完整输入。
- [ ] 运行 `npm test -w @genoffice/markdown -- --run tests/source-mode.test.tsx`，确认失败。
- [ ] 实现受控 `textarea`；`useLayoutEffect` 在 value 挂载后执行 `focus()` 和 `setSelectionRange(from, to)`，不自行归一化换行。
- [ ] Ribbon 加“可视化/源码”切换；源码模式下 Save、模式切换、缩放和 AI 面板入口可用，格式、表格、插图、outline、find/replace 等依赖 TipTap 的操作统一 disabled。
- [ ] `App.tsx` 进入源码模式前同步一次 visual projection，再调用 `session.enterSource(fragmentId)`；隐藏 `FrontmatterPanel`、`EditorContent`、`TableMenu`、`AiAskPopover`，显示包含 frontmatter 的全文 `SourceEditor`。
- [ ] textarea 每次 `onChange` 直接调用 `session.applySource(next)` 并刷新 view；如果局部投影失败仍保持 source mode 和可保存 source，不丢输入。
- [ ] 返回视觉模式时调用 `enterVisual()`；成功后用单次 ProseMirror transaction 替换 doc，并显式 `addToHistory=true`，从源码模式产生一个整体视觉撤销点；失败则显示错误并留在源码模式。
- [ ] 新增所有语言的键：`visualMode`、`sourceMode`、`sourceModeError`、`editSource`、`protectedSource`；现有非中文语言可使用准确英文兜底，但每个 locale object 必须具备完整键以通过类型检查。
- [ ] 增加 `.source-editor` 等样式，沿用现有主题变量、文档宽度与缩放容器，不新增颜色常量绕过主题。
- [ ] 运行本任务测试、`npm run typecheck -w @genoffice/markdown`、`npm run check:theme-colors` 和 `git diff --check`。
- [ ] 仅暂存本任务文件：`git add apps/markdown/src/renderer/components/SourceEditor.tsx apps/markdown/src/renderer/App.tsx apps/markdown/src/renderer/components/Ribbon.tsx apps/markdown/src/renderer/i18n/strings.ts apps/markdown/src/renderer/styles.css apps/markdown/tests/source-mode.test.tsx apps/markdown/vitest.config.ts`；提交：`git commit -m "feat(markdown): add whole-document source mode"`。

---

## Task 6: 完成受保护片段的 NodeView 与破坏性操作确认

**Files:**

- Create: `apps/markdown/src/renderer/editor/ProtectedSourceView.tsx`
- Create: `apps/markdown/src/renderer/components/ProtectedChangeConfirm.tsx`
- Create: `apps/markdown/tests/protected-change.test.ts`
- Modify: `apps/markdown/src/renderer/editor/protectedSource.ts`
- Modify: `apps/markdown/src/renderer/editor/extensions.ts`
- Modify: `apps/markdown/src/renderer/App.tsx`
- Modify: `apps/markdown/src/renderer/i18n/strings.ts`
- Modify: `apps/markdown/src/renderer/styles.css`

**Interfaces:**

```ts
export interface ProtectedChangeRequest {
  ids: string[]
  kind: 'delete' | 'cut' | 'replace'
  baseDoc: JSONContent
  steps: unknown[]
}

export interface ProtectedSourceOptions {
  onEditSource(id: string): void
  onConvert(id: string): void
  onConfirmChange(request: ProtectedChangeRequest): void
}

export const APPROVED_PROTECTED_CHANGE = 'approvedProtectedChange'
```

- [ ] 先写失败测试：光标不能进入 atom；NodeSelection 复制得到 attrs.raw；纯移动保留同 id/raw 可直接执行；删除、cut、replace 或 transaction 中修改 raw 会被 filterTransaction 拒绝并产生 request；未确认时 session/source/dirty 不变。
- [ ] 写失败测试：给同一 transaction 加 `APPROVED_PROTECTED_CHANGE` 后执行一次并进入 undo history；旧 transaction 在文档改变后不能直接重放，必须按当前 state 重新构造或提示过期。
- [ ] 运行 `npm test -w @genoffice/markdown -- --run tests/protected-change.test.ts`，确认失败。
- [ ] 实现 React NodeView：用 `<pre>/<code>` 或 inline `<code>` 显示 `node.attrs.raw`，React 文本插值保证 HTML 转义；显示保护原因、编辑源码、尝试转换按钮，不使用 `dangerouslySetInnerHTML`。
- [ ] 实现 ProseMirror plugin：比较 transaction 前后 protected id→raw multiset；集合相同且 raw 相同视为移动并允许；减少或 raw 改变视为破坏性操作，未带批准 meta 时阻止并回调。
- [ ] 实现 clipboard serializer：NodeSelection 或跨选区包含 atom 时写入原始 raw；不把 NodeView 按钮文案复制到剪贴板。
- [ ] `ProtectedChangeConfirm` 显示受影响片段数量与操作类型；取消只清 request。确认时先用 `editor.state.doc.toJSON()` 校验 `baseDoc`，未过期则用 `Step.fromJSON(editor.schema, step)` 重建 transaction、加批准 meta 后执行；禁止复用 stale Transaction 对象。
- [ ] “编辑源码”调用 `session.enterSource(id)`，使用 session 当前 range 定位，不缓存打开时 range。
- [ ] “尝试转换”只触发 Task 7 的 proposal 创建入口；Task 7 完成前若 proposal 服务不可用，按钮 disabled 并有可翻译说明，不做临时直接替换。
- [ ] 运行本任务测试、`npm run typecheck -w @genoffice/markdown`、主题颜色检查和 `git diff --check`。
- [ ] 仅暂存本任务文件：`git add apps/markdown/src/renderer/editor/ProtectedSourceView.tsx apps/markdown/src/renderer/components/ProtectedChangeConfirm.tsx apps/markdown/src/renderer/editor/protectedSource.ts apps/markdown/src/renderer/editor/extensions.ts apps/markdown/src/renderer/App.tsx apps/markdown/src/renderer/i18n/strings.ts apps/markdown/src/renderer/styles.css apps/markdown/tests/protected-change.test.ts`；提交：`git commit -m "feat(markdown): guard protected source changes"`。

---

## Task 7: 统一转换与 AI 源码 patch 的确认/过期模型

**Files:**

- Create: `apps/markdown/src/renderer/markdown/sourcePatch.ts`
- Create: `apps/markdown/src/renderer/ai/SourcePatchCard.tsx`
- Create: `apps/markdown/tests/source-patch.test.ts`
- Modify: `apps/markdown/src/renderer/App.tsx`
- Modify: `apps/markdown/src/renderer/ai/tools.ts`
- Modify: `apps/markdown/src/renderer/ai/markdown-skill.ts`
- Modify: `apps/markdown/src/renderer/ai/AiPanel.tsx`
- Modify: `apps/markdown/src/renderer/editor/ops.ts`
- Modify: `apps/markdown/tests/ai-tools.test.ts`
- Modify: `apps/markdown/src/renderer/i18n/strings.ts`
- Modify: `apps/markdown/src/renderer/styles.css`

**Interfaces:**

```ts
export interface SourcePatch {
  id: string
  origin: 'conversion' | 'ai'
  fragmentId: string
  expectedRaw: string
  nextRaw: string
  baseRevision: number
}

export interface SourceProtectionAccess {
  mode(): 'visual' | 'source'
  context(): string
  protectedIdsForOps(editor: Editor, ops: MdOp[]): string[]
  propose(fragmentId: string, expectedRaw: string, nextRaw: string): SourcePatch
  publish(patch: SourcePatch): void
}

export type PatchValidation =
  | { ok: true }
  | { ok: false; error: 'fragment-missing' | 'raw-changed' | 'revision-changed' }
```

- [ ] 先写 `source-patch.test.ts` 失败测试：创建 proposal 不改变 source/revision/dirty；确认应用后只替换目标 raw 并增一个 revision；fragment id、expectedRaw 或 baseRevision 任一过期都拒绝且 source 不变。
- [ ] 在 `ai-tools.test.ts` 写失败测试：`buildDocContext`/`read_blocks` 输出 protected id、reason 和 raw；一个 batch 中后续 op 命中 protected block 时整批零修改；source mode 下 `apply_ops`、`write_document`、`insert_image`、`generate_image` 都拒绝，读取工具仍可用。
- [ ] 写失败测试：新增 `propose_source_patch` 工具只有在输入 fragmentId/expectedRaw/nextRaw 完整且 fragment 当前存在时返回 proposal；结果 `mutated !== true`；确认由 UI 完成而非工具立即写文档。
- [ ] 运行 `npm test -w @genoffice/markdown -- --run tests/source-patch.test.ts tests/ai-tools.test.ts`，确认失败。
- [ ] 实现 `createSourcePatch`、`validateSourcePatch` 和 session 的 `applyConfirmedPatch`；patch id 使用内存序号，diff 文本不写入用户文件。
- [ ] 在 `MarkdownDocumentSession` 增加 `proposeFragmentReplacement(fragmentId, nextRaw)` 与 `applyConfirmedPatch(patch)`；两者只接受 `sourcePatch.ts` 的权威类型，避免 UI 自行拼接源码。
- [ ] 为 ops 增加无副作用的目标解析函数 `protectedIdsForOps`；在 `applyOps` 调 `runOps` 前检查整批所有 target。无法静态证明影响范围的 whole-document replace、跨块 replace 和 move 一律在存在 protected fragment 时拒绝。
- [ ] `buildDocContext` 对 atom 使用 `protected:<id>:<reason>` 标签；`read_blocks` 通过 session source accessor 返回 raw，不能依赖 TipTap serializer 是否理解 atom。
- [ ] 在 `AGENT_TOOLS` 加 `propose_source_patch`，description 明确“仅当用户明确点名/选中该 protected fragment”；executor 只验证并 `publish` proposal，返回 `mutated: false`。
- [ ] `MARKDOWN_RULES` 删除“HTML 会静默丢失”的过时描述，改为“可读取保护片段；普通工具只读；明确修改走 proposal + 用户确认”。
- [ ] 扩展 `MarkdownAiDeps`：提供 mode、session context、proposal publish；AiPanel 在 source mode 仍允许问答，但在 tool executor 层拒绝结构化写，不能只靠 prompt 约束。
- [ ] `SourcePatchCard` 显示 expectedRaw/nextRaw 的逐行 diff、确认和取消；确认调用 session，过期时显示专用文案并保留卡片供重新生成，不自动合并。
- [ ] “尝试转换”使用现有 codec 对 fragment raw 解析再序列化生成 `origin:'conversion'` proposal；parse/serialize 失败只显示失败并提供“编辑源码”，不改 source。
- [ ] 确认应用后通过单次 projection transaction 更新 TipTap，设置批准 meta 和一个 undo step；取消不触发 dirty/auto-save。
- [ ] 运行本任务测试、现有 `tests/ai-doc-writer.test.ts`、`npm run typecheck -w @genoffice/markdown`、主题检查和 `git diff --check`。
- [ ] 仅暂存本任务文件：`git add apps/markdown/src/renderer/markdown/sourcePatch.ts apps/markdown/src/renderer/markdown/documentSession.ts apps/markdown/src/renderer/ai/SourcePatchCard.tsx apps/markdown/src/renderer/App.tsx apps/markdown/src/renderer/ai/tools.ts apps/markdown/src/renderer/ai/markdown-skill.ts apps/markdown/src/renderer/ai/AiPanel.tsx apps/markdown/src/renderer/editor/ops.ts apps/markdown/src/renderer/i18n/strings.ts apps/markdown/src/renderer/styles.css apps/markdown/tests/source-patch.test.ts apps/markdown/tests/ai-tools.test.ts`；提交：`git commit -m "feat(markdown): confirm protected source patches"`。

---

## Task 8: 让 PDF、DOCX 与 Docs 导出安全呈现保护源码

**Files:**

- Modify: `apps/markdown/src/renderer/export/docxExport.ts`
- Modify: `apps/markdown/src/renderer/export/printHtml.ts`
- Modify: `apps/markdown/tests/docx-export.test.ts`
- Modify: `apps/markdown/tests/print-html.test.ts`

**Interfaces:**

```ts
function protectedRun(node: JSONContent): Run {
  return { text: String(node.attrs?.raw ?? ''), font: CODE_FONT }
}
```

- [ ] 先写 DOCX 失败测试：block HTML、inline HTML、HTML comment、旧 fenced div 都以原始源码文字出现；输出中没有执行后的 DOM 语义，现有 GFM/math/Mermaid 测试不变。
- [ ] 先写 print HTML 失败测试：保护节点的按钮/状态文案被移除，raw 中的 `<script>`、`<img onerror>`、`</style>` 只作为转义文本存在，不能成为可执行 element。
- [ ] 运行 `npm test -w @genoffice/markdown -- --run tests/docx-export.test.ts tests/print-html.test.ts`，确认失败。
- [ ] `runsFromInline` 增加 `protectedSourceInline` 分支；`walkBlock` 增加 `protectedSourceBlock` 分支，使用等宽字体保留换行，不尝试 HTML→DOCX 转换。
- [ ] `buildPrintHtml` 克隆后移除 `.protected-source-actions` 和交互属性；只保留 NodeView 已经以 text node 渲染的 `<code>` 内容，额外测试 raw 不会突破 `<body>`。
- [ ] 保持 Mermaid 的 `dangerouslySetInnerHTML` 路径只接受既有 renderer 生成的 SVG；保护节点不得复用该路径。
- [ ] 运行两组测试、`npm run typecheck -w @genoffice/markdown` 和 `git diff --check`。
- [ ] 仅暂存本任务文件：`git add apps/markdown/src/renderer/export/docxExport.ts apps/markdown/src/renderer/export/printHtml.ts apps/markdown/tests/docx-export.test.ts apps/markdown/tests/print-html.test.ts`；提交：`git commit -m "fix(markdown): export protected source as text"`。

---

## Task 9: 切换默认行为、删除有损入口并完成回归验收

**Files:**

- Modify: `apps/markdown/src/renderer/markdown/featureFlag.ts`
- Modify: `apps/markdown/src/renderer/App.tsx`
- Modify: `apps/markdown/src/renderer/editor/ops.ts`
- Modify: `apps/markdown/src/renderer/markdown/docText.ts`
- Modify: `apps/markdown/tests/doc-text.test.ts`
- Modify: `apps/markdown/tests/markdown-nodes.test.ts`
- Modify: `CONTEXT.md`

**Interfaces:**

最终默认值必须简单明确：

```ts
export function losslessMarkdownEnabled(): boolean {
  return true
}
```

- [ ] 先增加验收断言：默认调用 `losslessMarkdownEnabled()` 为 true；代码搜索不再发现 App/ops 调用 `stripLegacyFencedDivs`；未编辑 fixture 经真实 TipTap codec + session 保存逐字节相等。
- [ ] 运行 `npm test -w @genoffice/markdown -- --run tests/document-session.test.ts tests/markdown-nodes.test.ts tests/doc-text.test.ts`，确认默认开关/旧调用检查失败。
- [ ] 将 lossless session 设为唯一生产路径，删除 App 中迁移期开关分支和整篇 `getMarkdown()` 保存分支；保留 fail-safe 源码模式，不保留有损 fallback。
- [ ] 从 `ops.ts` 移除 `stripLegacyFencedDivs`：AI 新增内容仍只允许 GFM/math，但若出现不支持源码应由 session 保护或拒绝，不做静默 fence 剥离。
- [ ] 删除 `stripLegacyFencedDivs` 及其“迁移会改写文件”的测试；若仅测试工具仍需要 legacy 内容，改为断言扫描器生成 `legacy-fenced-div` protected unit。
- [ ] 更新 `CONTEXT.md`：记录 `MarkdownDocumentSession` 是 Markdown 文件事实来源、protected fragment 契约和保存 IPC 的实际 `text` 回包，避免后续代码重新引入 whole-document serialization。
- [ ] 运行定向测试：

```bash
npm test -w @genoffice/markdown -- --run \
  tests/source-scanner.test.ts \
  tests/source-projection.test.ts \
  tests/document-session.test.ts \
  tests/source-mode.test.tsx \
  tests/protected-change.test.ts \
  tests/source-patch.test.ts \
  tests/save-session.test.ts \
  tests/ai-tools.test.ts \
  tests/docx-export.test.ts \
  tests/print-html.test.ts \
  tests/asset-lifecycle.test.ts
```

- [ ] 运行完整 Markdown 验证：`npm test -w @genoffice/markdown`。
- [ ] 运行静态验证：`npm run typecheck -w @genoffice/markdown && npm run lint -- --quiet && npm run check:theme-colors && npm run check:english-comments`。
- [ ] 运行构建：`npm run build -w @genoffice/markdown`。
- [ ] 手动开发验证：用 `npm run dev -w @genoffice/markdown` 打开三份 fixture，分别执行零编辑保存、只改普通段落、从 protected node 进入源码、取消/确认删除、AI proposal 取消/确认、Save As 图片迁移、PDF/DOCX 导出；用 `git diff --no-index` 或 `cmp` 验证零编辑文件完全相同。
- [ ] 搜索禁止入口：

```bash
rg -n "stripLegacyFencedDivs|current\.getMarkdown\(\).*save|serializeDocText\(.*getMarkdown" apps/markdown/src
```

预期：无生产调用；`getMarkdown()` 只可存在于明确的局部 codec/AI 可编辑块序列化，不可直接形成保存请求全文。

- [ ] 运行 `git diff --check`，检查 `git status --short` 只包含本计划文件；`.superpowers/` 不得纳入提交。
- [ ] 仅暂存本任务文件：`git add apps/markdown/src/renderer/markdown/featureFlag.ts apps/markdown/src/renderer/App.tsx apps/markdown/src/renderer/editor/ops.ts apps/markdown/src/renderer/markdown/docText.ts apps/markdown/tests/doc-text.test.ts apps/markdown/tests/markdown-nodes.test.ts CONTEXT.md`；提交：`git commit -m "feat(markdown): enable lossless editing by default"`。

## Final Review Checklist

- [ ] **规格覆盖：** 将正式规格“必须自动化的断言”1–11 逐条映射到上述测试，任何未映射项补测试而不是写人工说明。
- [ ] **占位符扫描：** `rg -n "TBD|TODO|FIXME|implement later|后续实现" apps/markdown/src apps/markdown/tests`，确认本功能未留下占位实现。
- [ ] **类型一致性：** `SourceRange`、`ProtectedReason`、`SourcePatch`、`SaveTicket` 只保留一个权威定义，其他模块用 type import。
- [ ] **安全性：** raw HTML 仅经文本节点/转义导出；没有新 `dangerouslySetInnerHTML`；普通 AI 写和 source mode 写均有代码级拒绝测试。
- [ ] **并发性：** 保存 ticket 测试证明旧回包不覆盖新编辑；stale patch 测试证明旧 proposal 不自动合并。
- [ ] **精确性：** 未编辑 fixture 全部逐字节相等，单块编辑 diff 不越过安全窗口，Save As session source 与磁盘文本一致。
- [ ] **最终证据：** 在交付说明中列出实际运行过的命令及通过数量；不要只写“测试已通过”。
