# GenOffice

GenOffice is an office suite differentiated by AI-assisted authoring. This context defines the product boundaries and compatibility vocabulary for Markdown work.

## Language

**AI-first Markdown editor**:
AI-assisted writing and editing are the primary differentiators, backed by a dependable Markdown editing experience. The goal is not to reproduce another editor in full.
_Avoid_: Typora clone, complete Typora parity

**Editable core**:
Markdown that the visual editor can understand, render, and modify directly. The first phase focuses on GFM.
_Avoid_: every Markdown dialect, every Typora extension

**Lossless compatibility**:
Untouched content remains byte-for-byte unchanged. The editable core may be normalized only inside source regions that the user actually edits; other content must never degrade silently.
_Avoid_: universal visual support, approximate semantics, whole-document normalization

**Preserved fragment**:
Content outside the editable core that must be retained exactly. It may change only when the user explicitly edits it or confirms a conversion.
_Avoid_: unsupported content, disposable content

**Protected source presentation**:
The default visual representation of a preserved fragment. It displays the original source, blocks ordinary rich-text edits, and provides explicit source-editing or conversion actions.
_Avoid_: speculative rendering, silent conversion, forcing the entire document into source mode

**Source mode**:
The single full-document source editor. Entering it from a preserved fragment selects that fragment's source range; returning to visual mode re-identifies the editable core and preserved fragments.
_Avoid_: fragment-specific source editors, multiple source-editing implementations

**AI protection boundary**:
AI may read preserved fragments to understand the document, but cannot modify them by default. Only an explicit user selection or reference may produce a source diff, and applying that diff requires user confirmation.
_Avoid_: autonomous rewrites of unknown syntax, silent AI edits to preserved fragments, hiding fragment context from AI completely

## Markdown source authority

`MarkdownDocumentSession` is the sole source of truth for an open Markdown file. The visual editor only renders its session projection; saves must send `session.beginSave().source` through IPC and must never fall back to `getMarkdown()` or whole-document TipTap serialization.

The scanner must project preserved fragments into protected nodes with their original `raw` text and stable ids. Unconfirmed visual operations cannot delete, modify, or rewrite those bytes; edits to ordinary content are limited to a safe local source window.

The editor may append one empty paragraph for a caret after a non-text block. That paragraph carries explicit generated-node provenance and is ignored only while it remains empty; ordinary empty paragraphs and all user edits remain subject to normal safe projection checks.

The successful Markdown-save IPC response `text` is the exact text written by the main process. The session uses it to synchronize the save baseline and retains any newer in-flight edits instead of overwriting them with an older response.
