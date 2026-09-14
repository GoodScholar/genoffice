# GenOffice

GenOffice 是一套以 AI 辅助为差异化能力的办公应用。本上下文统一描述 Markdown 产品边界与文档兼容性语言。

## Language

**AI 优先 Markdown 编辑器**：
以 AI 辅助创作和编辑为核心差异，同时提供可靠的 Markdown 文档体验；目标不是完整复制某个现有编辑器。
_Avoid_: Typora 克隆、全面 Typora 对齐

**可编辑核心**：
可由可视化编辑器直接理解、呈现和修改的 Markdown 内容；第一阶段以 GFM 为核心。
_Avoid_: 全部 Markdown、所有 Typora 语法

**无损兼容**：
未被用户编辑的内容保持原样；可编辑核心只允许在用户修改的区域内规范化，其他内容不得静默降级。
_Avoid_: 全量可视化支持、语义近似、全文规范化

**保留片段**：
可编辑核心之外、必须逐字保留的文档内容；只有用户明确编辑或确认转换时才允许改变。
_Avoid_: 不支持内容、可丢弃内容

**受保护源码呈现**：
保留片段在可视化编辑器中的默认形态；直接显示原始源码并阻止普通富文本编辑，同时提供明确的源码编辑或转换入口。
_Avoid_: 猜测性渲染、静默转换、整篇文档回退源码模式

**源码模式**：
整篇文档唯一的源码编辑入口；从保留片段进入时自动定位并选中对应源码，返回可视化模式后重新识别可编辑核心与保留片段。
_Avoid_: 片段专用源码编辑器、多套源码编辑逻辑

**AI 保护边界**：
AI 可以读取保留片段以理解文档，但默认不得修改；只有用户明确选中或点名片段时，AI 才能生成源码差异，并在用户确认后应用。
_Avoid_: AI 自主改写未知语法、对保留片段静默应用修改、完全隐藏片段上下文

## Markdown source authority

`MarkdownDocumentSession` is the sole source of truth for an open Markdown file. The visual editor only renders its session projection; saves must send `session.beginSave().source` through IPC and must never fall back to `getMarkdown()` or whole-document TipTap serialization.

The scanner must project preserved fragments into protected nodes with their original `raw` text and stable ids. Unconfirmed visual operations cannot delete, modify, or rewrite those bytes; edits to ordinary content are limited to a safe local source window.

The successful Markdown-save IPC response `text` is the exact text written by the main process. The session uses it to synchronize the save baseline and retains any newer in-flight edits instead of overwriting them with an older response.
