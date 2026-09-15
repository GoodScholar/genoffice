import { afterEach, describe, expect, it } from 'vitest'
import { Editor, type JSONContent } from '@tiptap/core'
import { redo, undo } from '@tiptap/pm/history'
import {
  applyProjectionProvenance,
  completeSourceModeTransition,
  replaceEditorBaseline,
  restoreSourceHistoryTransaction,
  type SourceModeSnapshot,
} from '../src/renderer/App'
import { buildExtensions } from '../src/renderer/editor/extensions'
import {
  createMarkdownDocumentSession,
  type MarkdownDocumentSession,
} from '../src/renderer/markdown/documentSession'
import { createTiptapMarkdownCodec } from '../src/renderer/markdown/sourceProjection'

const SAMPLE = '# 标题\n\n- 项目一\n- **项目二**\n\n[链接](https://example.com)'

interface SourceRoundTripHarness {
  editor: Editor
  session: MarkdownDocumentSession
  enterSource(): ReturnType<MarkdownDocumentSession['applyVisual']>
  leaveSource(): ReturnType<typeof completeSourceModeTransition>
}

function withLinkTarget(node: JSONContent, target: string): JSONContent {
  const content = node.content?.map((child) => withLinkTarget(child, target))
  const marks = node.marks?.map((mark) =>
    mark.type === 'link' ? { ...mark, attrs: { ...mark.attrs, target } } : mark,
  )
  return { ...node, ...(content ? { content } : {}), ...(marks ? { marks } : {}) }
}

function createHarness(): SourceRoundTripHarness {
  const sessionRef: { current?: MarkdownDocumentSession } = {}
  let mode: 'visual' | 'source' = 'visual'
  let sourceStart: SourceModeSnapshot | undefined
  let syncingProjection = false
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: buildExtensions({
      slashController: { onOpen() {}, onUpdate() {}, onKeyDown: () => false, onClose() {} },
      slashItems: () => [],
      protectedSource: {
        onEditSource() {},
        onConvert() {},
        onConfirmChange() {},
        getCurrentSource: () => sessionRef.current?.serialize(),
      },
    }),
    content: '',
    onTransaction: ({ editor: updated, transaction }) => {
      if (sessionRef.current && !syncingProjection)
        restoreSourceHistoryTransaction(sessionRef.current, updated, transaction)
    },
    onUpdate: ({ editor: updated, transaction }) => {
      const session = sessionRef.current
      if (transaction.getMeta('uiOnly') || !session || syncingProjection || mode !== 'visual')
        return
      const update = session.applyVisual({
        doc: updated.getJSON(),
        frontmatterInner: session.view().visual.frontmatterInner,
      })
      if (!update.ok) {
        session.enterSource()
        mode = 'source'
        return
      }
      applyProjectionProvenance(updated, update.view.visual.doc)
    },
  })
  const session = createMarkdownDocumentSession('', createTiptapMarkdownCodec(editor))
  sessionRef.current = session
  syncingProjection = true
  replaceEditorBaseline(editor, session.view().visual.doc)
  syncingProjection = false

  return {
    editor,
    session,
    enterSource() {
      const projected = session.applyVisual({
        doc: editor.getJSON(),
        frontmatterInner: session.view().visual.frontmatterInner,
      })
      sourceStart = projected.ok
        ? { source: projected.view.source, visual: projected.view.visual }
        : undefined
      session.enterSource()
      mode = 'source'
      return projected
    },
    leaveSource() {
      if (!sourceStart) throw new Error('Source-mode start projection was rejected')
      syncingProjection = true
      try {
        const transition = completeSourceModeTransition(session, editor, sourceStart)
        if (transition.ok) {
          if (transition.changed) applyProjectionProvenance(editor, transition.view.visual.doc)
          sourceStart = undefined
          mode = 'visual'
        }
        return transition
      } finally {
        syncingProjection = false
      }
    },
  }
}

const editors: Editor[] = []

afterEach(() => {
  while (editors.length) editors.pop()!.destroy()
})

describe('real source-mode round trips', () => {
  it.each([
    ['heading', '# 标题'],
    ['bold paragraph', '**项目二**'],
    ['bold list item', '- **项目二**'],
    ['link', '[链接](https://example.com)'],
    ['combined report sample', SAMPLE],
  ])('keeps %s source byte-for-byte stable through repeated no-edit toggles', (_name, source) => {
    const harness = createHarness()
    editors.push(harness.editor)

    expect(harness.enterSource()).toMatchObject({ ok: true })
    expect(harness.session.applySource(source)).toMatchObject({ ok: true })
    expect(harness.leaveSource()).toMatchObject({ ok: true, changed: true })
    const beforeNoOps = harness.session.view()

    expect(harness.enterSource()).toMatchObject({ ok: true })
    expect(harness.leaveSource()).toMatchObject({ ok: true, changed: false })
    expect(harness.enterSource()).toMatchObject({ ok: true })
    expect(harness.leaveSource()).toMatchObject({ ok: true, changed: false })

    expect(harness.session.view()).toMatchObject({
      source,
      revision: beforeNoOps.revision,
      dirty: beforeNoOps.dirty,
      mode: 'visual',
    })
  })

  it.each([
    ['LF', SAMPLE],
    ['CRLF', SAMPLE.replaceAll('\n', '\r\n')],
  ])('preserves %s source bytes across a no-edit source-mode round trip', (_eol, source) => {
    const harness = createHarness()
    editors.push(harness.editor)

    harness.enterSource()
    harness.session.applySource(source)
    expect(harness.leaveSource()).toMatchObject({ ok: true, changed: true })
    const ticket = harness.session.beginSave()
    harness.session.markSaved(source, ticket)
    const beforeNoOp = harness.session.view()
    expect(beforeNoOp.dirty).toBe(false)
    expect(harness.enterSource()).toMatchObject({ ok: true })
    expect(harness.leaveSource()).toMatchObject({ ok: true, changed: false })

    expect(harness.session.view()).toMatchObject({
      source,
      revision: beforeNoOp.revision,
      dirty: beforeNoOp.dirty,
    })
  })

  it('retains protected source and restores its source snapshot through undo and redo', () => {
    const harness = createHarness()
    editors.push(harness.editor)
    const source = `${SAMPLE}\n\n<details>raw</details>\n`

    harness.enterSource()
    harness.session.applySource(source)
    expect(harness.leaveSource()).toMatchObject({ ok: true, changed: true })
    expect(JSON.stringify(harness.editor.getJSON())).toContain('protectedSourceBlock')
    expect(harness.session.serialize()).toBe(source)
    const beforeNoOp = harness.session.view()
    expect(harness.enterSource()).toMatchObject({ ok: true })
    expect(harness.leaveSource()).toMatchObject({ ok: true, changed: false })
    expect(harness.session.view()).toMatchObject({
      source,
      revision: beforeNoOp.revision,
      dirty: beforeNoOp.dirty,
    })

    expect(undo(harness.editor.state, harness.editor.view.dispatch)).toBe(true)
    expect(harness.session.serialize()).toBe('')
    expect(redo(harness.editor.state, harness.editor.view.dispatch)).toBe(true)
    expect(harness.session.serialize()).toBe(source)
  })

  it('rejects a non-default link target without changing the source session', () => {
    const harness = createHarness()
    editors.push(harness.editor)
    const source = '[链接](https://example.com)'

    harness.enterSource()
    harness.session.applySource(source)
    expect(harness.leaveSource()).toMatchObject({ ok: true, changed: true })
    const before = harness.session.view()
    const changedTarget = withLinkTarget(harness.editor.getJSON(), '_self')

    expect(
      harness.session.applyVisual({
        doc: changedTarget,
        frontmatterInner: before.visual.frontmatterInner,
      }),
    ).toMatchObject({
      ok: false,
      error: 'Visual projection cannot be represented by a safe source rewrite',
    })
    expect(harness.session.view()).toMatchObject({ source, revision: before.revision })
  })
})
