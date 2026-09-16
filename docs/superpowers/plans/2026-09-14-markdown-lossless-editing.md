# Markdown Lossless Editing Foundation Implementation Plan

> **Execution note:** Implement tasks in order with test-first checkpoints. Every task must preserve unrelated source bytes and fail closed when a safe rewrite cannot be proven.

**Goal:** Make untouched Markdown open/save byte-identical while ensuring the visual editor, source mode, AI tools, and save path share one region-level lossless session.

**Architecture:** The complete source is authoritative. `MarkdownDocumentSession` maps lexer-backed source units to TipTap nodes, reuses unchanged raw slices, serializes only edited safe groups, and represents uncertain syntax as protected source atoms.

**Stack:** TypeScript 5.9, React 19, TipTap/ProseMirror 3.31, the TipTap Markdown lexer/serializer, Electron IPC, Vitest, jsdom, and Playwright.

## Global constraints

- The session is the only save source; never fall back to whole-document `editor.getMarkdown()`.
- Untouched units reuse their original `raw` and separator bytes.
- Unsafe or ambiguous ranges expand protection or fall back to source mode.
- Protected deletion, replacement, conversion, and AI patches require confirmation.
- Ordinary AI operations preflight the complete operation and fail atomically if they touch protected content.
- Save As rebases only the exact image rewrites returned by the main process.
- Generated trailing paragraphs are ignored only while they remain empty and explicitly marked.
- Each task runs its focused tests and `git diff --check` before integration.

## Main files

### Core source model

- `apps/markdown/src/renderer/markdown/docText.ts`
- `apps/markdown/src/renderer/markdown/sourceScanner.ts`
- `apps/markdown/src/renderer/markdown/sourceProjection.ts`
- `apps/markdown/src/renderer/markdown/documentSession.ts`
- `apps/markdown/src/renderer/markdown/sourceHistory.ts`
- `apps/markdown/src/renderer/markdown/sourcePatch.ts`

### Editor integration

- `apps/markdown/src/renderer/App.tsx`
- `apps/markdown/src/renderer/editor/extensions.ts`
- `apps/markdown/src/renderer/editor/protectedSource.ts`
- `apps/markdown/src/renderer/editor/generatedTrailingNode.ts`
- `apps/markdown/src/renderer/editor/ProtectedSourceView.tsx`
- `apps/markdown/src/renderer/components/SourceEditor.tsx`
- `apps/markdown/src/renderer/components/ProtectedChangeConfirm.tsx`
- `apps/markdown/src/renderer/components/Ribbon.tsx`

### AI, save, and export

- `apps/markdown/src/renderer/ai/tools.ts`
- `apps/markdown/src/renderer/ai/AiPanel.tsx`
- `apps/markdown/src/renderer/ai/SourcePatchCard.tsx`
- `apps/markdown/src/shared/ipc.ts`
- `apps/markdown/src/main/markdown-main.ts`
- `apps/markdown/src/renderer/export/docxExport.ts`
- `apps/markdown/src/renderer/export/printHtml.ts`

## Task 1: Establish the lossless corpus and scanner

1. Add fixtures for core GFM, Typora-style/raw HTML, legacy fenced divs, malformed markup, mathematics, Mermaid, and image attributes.
2. Add scanner tests for monotonic `raw` coverage, separator ownership, CRLF offsets, fenced-code exclusion, inline HTML boundaries, malformed input, and lexer failure.
3. Parse the document envelope without normalizing BOM, EOL style, frontmatter, body, or final-newline state.
4. Consume lexer source monotonically; never use `indexOf` to skip unknown bytes.
5. Assign stable session-local ids and protect HTML, comments, legacy `:::` blocks, and ambiguous units.
6. Verify that list tokens owning leading blank lines do not overlap a preceding protected range.

**Checkpoint:** scanner and document-envelope tests pass for LF, CRLF, BOM, emoji offsets, empty input, and malformed input.

## Task 2: Add provenance and protected projection

1. Add non-rendered `sourceId` attributes to editable block nodes.
2. Define block and inline protected atoms carrying id, exact raw source, and reason.
3. Project protected blocks directly and use unique sentinels to restore precisely bounded inline fragments after Markdown parsing.
4. Compute stable fingerprints with provenance removed but semantic structure retained.
5. Serialize changed groups through sentinels and reject missing, duplicated, or newly introduced markers.
6. Register protected extensions and render source with escaped text only.

**Checkpoint:** projection tests prove exact raw retention, shared provenance for multi-node units, and safe handling of malformed fragments.

## Task 3: Implement `MarkdownDocumentSession`

1. Store the exact source, envelope, ordered units, visual projection, revision, dirty baseline, mode, and protected ranges.
2. Reuse unchanged unit text; serialize changed editable groups only.
3. Preserve source-owned leading/trailing boundaries when a lexer token owns blank lines.
4. Support local insertion, deletion, movement, and replacement without rewriting unrelated units.
5. Treat generated and user-created trailing empty paragraphs separately.
6. Reject protected mismatches, unknown protected ids, and projections that cannot be recreated from the proposed source.
7. Support source edits, source-to-visual validation, history restoration, and revision-bearing save tickets.
8. Rebase exact main-process image rewrites while preserving concurrent editor changes.

**Checkpoint:** document-session tests cover no-op round trips, local rewrites, protected adjacency, empty nodes, list transitions, undo/redo, save races, and CRLF/BOM inputs.

## Task 4: Route renderer save through the session

1. Create a session when a file opens and set TipTap content from its visual projection without dirtying history.
2. Submit visual updates to `applyVisual()` and refresh provenance without replacing the editor document.
3. Begin every save with `session.beginSave()` and send its source through IPC.
4. Return the exact written `text` from the main process.
5. Call `markSaved(result.text, ticket, rewrites)` only after a successful write.
6. Keep the document dirty when a newer edit exists or the returned source conflicts.

**Checkpoint:** save tests prove exact no-op saves, Save As image rebasing, failed-save behavior, and concurrent-edit preservation.

## Task 5: Add full-document source mode

1. Provide one source editor for the entire file with selection support, undo/redo, line numbers, search, and Markdown highlighting.
2. Entering source mode synchronizes pending visual edits and optionally selects a fragment range.
3. Returning to visual mode validates the source and applies the result as one visual history event.
4. A no-op mode switch preserves dirty state and history.
5. Failed projection keeps all input in source mode with a clear error.
6. Disable visual-only ribbon and structural commands while source mode is active.

**Checkpoint:** source-mode tests cover no-op switching, edits, invalid input, protected ranges, selection, history, and visual-document replacement.

## Task 6: Complete protected-fragment interaction

1. Render protected blocks and inline atoms with clear source styling and explicit edit/convert actions.
2. Prevent caret entry and unauthorized structural mutation.
3. Detect deletion, replacement, cut, and range operations before dispatch.
4. Present a confirmation dialog with escaped old/new source and apply the authorized transaction only after confirmation.
5. Keep dragging and block controls outside editable text so they cannot overlap content.

**Checkpoint:** protected-change tests cover keyboard deletion, selection replacement, drag/move, stale confirmation, and focus behavior.

## Task 7: Unify conversion and AI source patches

1. Represent proposed protected changes as revision-bound patches with fragment id, expected raw source, proposed raw source, and origin.
2. Use the same preview, confirmation, stale validation, and application path for manual conversion and AI.
3. Expose protected context to AI as read-only source.
4. Reject ordinary AI operations that touch protected nodes or run while source mode is active.
5. Allow an explicit fragment request to propose—but never automatically apply—a source patch.

**Checkpoint:** AI and source-patch tests prove atomic rejection, preview immutability, stale-patch failure, confirmed application, and history restoration.

## Task 8: Export protected source safely

1. Print/PDF HTML must remove editor controls and render protected raw source as escaped text.
2. DOCX export must emit readable source text for protected blocks and inline fragments.
3. No export path may execute raw HTML or drop preserved fragments.

**Checkpoint:** print and DOCX tests cover block/inline fragments and control stripping.

## Task 9: Remove lossy paths and complete regression coverage

1. Remove destructive legacy fenced-div stripping from open and AI paths.
2. Remove all save fallbacks to whole-document TipTap serialization.
3. Enable the source-backed path by default.
4. Add Electron E2E for protected legacy content, slash-command task lists, argv files, frontmatter, source layout, zoom, and saving.
5. Run full formatting, lint, typecheck, unit, build, and E2E checks.

## Final review checklist

- [ ] Untouched Markdown saves byte-for-byte unchanged.
- [ ] Safe edits rewrite only the intended source unit and required local boundary.
- [ ] Protected raw source changes only after explicit confirmation.
- [ ] Visual/source transitions preserve input, dirty state, and undo history.
- [ ] Slash commands and empty task/list transitions stay in visual mode.
- [ ] AI cannot bypass protection or apply stale patches.
- [ ] Save results cannot overwrite newer edits.
- [ ] PDF, print, and DOCX retain protected content safely.
- [ ] No diagnostic logging or generated test artifacts are committed.
- [ ] Formatting, English-documentation, theme-color, lint, typecheck, unit, build, and relevant E2E gates pass.
