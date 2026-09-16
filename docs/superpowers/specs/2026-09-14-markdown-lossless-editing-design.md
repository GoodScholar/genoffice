# Markdown Lossless Editing Foundation Design

**Date:** 2026-09-14

## Background

The previous Markdown path could preserve the document envelope—frontmatter, LF or CRLF style, UTF-8 BOM, and final-newline state—but the body did not have an equivalent source-preservation model. Whole-document TipTap serialization could silently remove or normalize raw HTML, comments, image dimensions, custom fenced blocks, list indentation, and whitespace that the visual editor did not understand.

This design introduces a lossless editing foundation. It is not a Typora clone and does not attempt to add every Markdown feature in one release.

## Goals

1. Opening and saving an untouched file writes exactly the original bytes.
2. Visual edits normalize only the safe source region the user changed.
3. Recognizable content outside the editable core remains visible as preserved source instead of degrading silently.
4. The application provides one full-document source mode.
5. AI can understand preserved fragments but cannot modify them without an explicit, confirmed source patch.
6. Existing TipTap editing, AI operations, atomic save behavior, and image lifecycle remain in use.

## Non-goals

- Reproducing Typora or supporting every Markdown dialect.
- Inferring arbitrary third-party extension semantics.
- Crash recovery, external file-change detection, or conflict merging.
- Workspace-wide search and folder management.
- User CSS, a theme marketplace, focus mode, typewriter mode, or advanced source-editor IDE features.
- Image resizing/upload configuration or advanced table-width editing.
- Replacing TipTap or rebuilding the current AI editing system.

## Product contract

### Editable core

The first editable core includes supported GFM blocks and inline syntax, task lists, tables, `$` and `$$` mathematics, Mermaid fenced code blocks, and frontmatter.

When a user changes a safe unit, the current serializer may normalize that unit—for example, list indentation may become four spaces. Unchanged units must retain their original source.

### Lossless compatibility

Lossless compatibility is a source-preservation contract, not a promise of universal visual rendering:

- untouched source is reused exactly;
- normalization is limited to the safe rewrite window;
- preserved fragments change only after an explicit edit, deletion, replacement, or confirmed conversion;
- Save As may rewrite known image destinations as an explicit file-operation side effect.

### Preserved fragments

The first phase protects:

- block and inline raw HTML;
- HTML comments;
- legacy `:::` fenced divs;
- source whose parse or rewrite boundary cannot be proven safe.

Precisely bounded inline HTML protects only the inline range. Incomplete tags, ambiguous nesting, or unreliable alignment expand protection to the containing Markdown unit. If no safe projection can be built, the whole document remains intact and opens in source mode.

Strict Markdown treats some extensions as ordinary text, so there is no reliable universal detector for unknown syntax. The system preserves untouched source bytes without claiming to understand every extension.

## Considered approaches

### A. Source-backed document session — selected

The complete source is authoritative. A session maps ordered source units to visual nodes, reuses unchanged raw slices, and serializes only changed safe units. TipTap, source mode, AI, and save operations share this session.

### B. Diff after whole-document serialization — rejected

Serializer formatting changes create many false differences, and a merge cannot be proven safe around unknown syntax or structural edits.

### C. New source-position-aware editing engine — rejected for this phase

A CST-first engine could provide stronger long-term guarantees, but replacing TipTap would also require rebuilding editing, history, AI operations, and exports.

## Architecture

### Core seam

`MarkdownDocumentSession` owns source segmentation, provenance, projection validation, safe rewriting, editor mode, dirty state, and the save baseline. Callers do not assemble source fragments themselves.

Conceptually, the interface provides:

```ts
interface MarkdownDocumentSession {
  view(): SessionView
  applyVisual(next: VisualProjection): SessionUpdate
  applySource(next: string): SessionUpdate
  enterSource(fragmentId?: string): SessionUpdate
  enterVisual(): SessionUpdate
  beginSave(): SaveTicket
  markSaved(actualText: string, ticket: SaveTicket): SessionView
  serialize(): string
}
```

Key constraints:

- `view()` returns the current source, visual projection, protected ranges, mode, revision, and dirty state.
- `applyVisual()` accepts a complete visual projection but rewrites only proven safe source groups.
- `applySource()` establishes the edited full source as the new authority and rebuilds the projection.
- `serialize()` is a pure read; save must not perform a late whole-document conversion.
- `markSaved()` receives the exact text written by the main process and rebases newer edits safely.
- The Markdown codec is injected so production and tests exercise the same seam.

### Source units and provenance

The scanner consumes lexer `raw` values monotonically against the original body. Each source unit records its raw source, trailing separator bytes, range, stable session-local id, projection fingerprint, and protected fragments.

Editable nodes carry a non-rendered `sourceId`. Protected nodes also carry their exact `raw` source and protection reason. Fingerprints recursively ignore provenance attributes while retaining semantic structure.

On a visual update:

- an unchanged group reuses its original `raw` and separator bytes;
- a changed editable group is serialized through the codec;
- a new group receives a canonical local boundary;
- deleted groups are omitted;
- moved unchanged groups move their original bytes;
- ambiguous structural changes fail closed instead of rewriting a wider document silently.

Whitespace and separators are source data. They enter a rewrite window only when the structural edit requires it.

### Adapters

Four adapters share the session:

1. The visual adapter projects editable units into TipTap and preserved fragments into protected atoms.
2. The source adapter edits the complete source and can select a preserved fragment's exact range.
3. The AI adapter reads complete context, preflights ordinary operations, and uses confirmed source patches for preserved fragments.
4. The save adapter sends `session.beginSave().source` through the existing atomic IPC path and rebases the returned text.

## Mode and data flow

### Open

1. The main process reads the exact UTF-8 text.
2. The session parses the envelope, scans source units, and identifies protection ranges.
3. The visual adapter creates a TipTap projection without adding an undo event or dirtying the file.
4. If projection cannot be proven safe, the exact input opens in source mode.

### Visual editing

1. A TipTap transaction updates the visual document.
2. The adapter submits the full projection to `applyVisual()`.
3. The session validates protected bytes and rewrites only changed safe groups.
4. Dirty state is based on serialized session source versus the last successful save baseline.

Generated trailing paragraphs have reserved provenance. The session may temporarily retain an empty structural node while source remains unchanged, but typed content must immediately become ordinary source-backed content.

### Source mode

Entering source mode first synchronizes the current visual projection. The editor shows the complete source, including frontmatter and protected fragments. Entering from a fragment selects its range.

Returning to visual mode reparses the source. A no-op switch preserves history and dirty state. A source edit becomes one visual-editor undo step. Internal projection failure leaves the user in source mode with all input intact.

### Save and Save As

The renderer begins a save with a revision-bearing ticket. The main process performs its existing authorization, image handling, and atomic write, then returns the exact written text. The session updates its baseline only for the matching ticket and preserves newer in-flight edits. Save As may rebase known image destination changes without overwriting concurrent content edits.

## Protected-fragment interaction

Protected blocks show escaped original source with a clear protected state. They provide explicit actions to edit source or propose conversion. The caret cannot enter the fragment, and ordinary deletion, replacement, cutting, or structural operations require confirmation.

Moving a protected block may change its position but not its raw bytes. Failed conversion changes nothing and offers source mode as the fallback.

## AI protection

AI context may include protected source with stable fragment identifiers and read-only instructions. Ordinary index-based operations preflight their complete range and reject the entire batch if it touches protected content.

An explicit request to modify a preserved fragment may create a source patch containing the fragment id, expected old source, proposed source, origin, and revision. The UI displays a diff. Confirmation applies the patch only if the id, revision, and expected source remain current; stale patches fail without changing the document.

## Error handling

- Scanner coverage gaps, lexer exceptions, or unsafe projection fall back to source mode while preserving the exact input.
- A protected-fragment mismatch rejects the visual update and does not alter session state.
- Source-mode parse failure retains the edited source and reports why visual mode is unavailable.
- Save failure keeps the document dirty and does not move the baseline.
- A stale save result may update only proven external rewrites, such as known image destinations; conflicts remain dirty.

## Export behavior

PDF, print HTML, and DOCX exports render protected source as escaped text and remove editor-only controls. Exports never execute raw HTML or silently convert unsupported syntax.

## Test and acceptance strategy

The lossless corpus covers core GFM, frontmatter, CRLF, BOM, no-final-newline input, mathematics, Mermaid, raw HTML, comments, legacy fenced divs, malformed markup, image attributes, and mixed safe/protected content.

Required automated assertions include:

- untouched open/save is byte-identical;
- editing one safe unit leaves all other units unchanged;
- protected content cannot change without confirmation;
- source mode selects fragment ranges and preserves failed input;
- undo and redo work across visual/source transitions;
- AI operations fail atomically around protected content;
- save tickets preserve concurrent edits and exact main-process rewrites;
- generated trailing nodes, list transitions, and slash commands remain in visual mode;
- print and DOCX exports present protected source safely.

Unit tests cover scanning, projection, sessions, history, AI patches, and saves. Renderer tests cover mode switching and confirmation UI. Electron E2E covers real opening, editing, slash commands, saving, layout, and argv file handling.

## Migration and rollout

The source-backed path replaces the lossy whole-document save path. Development assertions compare projected state and serialized source, while production behavior fails closed. Feature completion requires removing destructive legacy stripping and every save fallback to `editor.getMarkdown()`.

## Follow-up specifications

Separate work may cover richer source-editor features, external change/conflict handling, workspace search, Typora-style themes, image manipulation, advanced table editing, and additional export controls.
