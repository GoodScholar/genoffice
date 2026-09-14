import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Editor, Extension } from '@tiptap/core'
import { NodeSelection, type Transaction } from '@tiptap/pm/state'
import { redo, undo, undoDepth } from '@tiptap/pm/history'
import { Plugin } from '@tiptap/pm/state'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProtectedSourceView } from '../src/renderer/editor/ProtectedSourceView'
import { ProtectedChangeConfirm } from '../src/renderer/components/ProtectedChangeConfirm'
import {
  applyProtectedChange,
  APPROVED_PROTECTED_CHANGE,
  protectedSourceAuthority,
  type ProtectedChangeRequest,
} from '../src/renderer/editor/protectedSource'
import { buildExtensions } from '../src/renderer/editor/extensions'
import { applyProjectionProvenance, replaceEditorBaseline, restoreSourceHistoryTransaction } from '../src/renderer/App'
import { createMarkdownDocumentSession } from '../src/renderer/markdown/documentSession'
import { createTiptapMarkdownCodec } from '../src/renderer/markdown/sourceProjection'
import { SourceSnapshotStep } from '../src/renderer/markdown/sourceHistory'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root, host: HTMLDivElement }> = []

afterEach(() => {
  while (roots.length) {
    const mounted = roots.pop()!
    act(() => mounted.root.unmount())
    mounted.host.remove()
  }
})

function createEditor(onConfirmChange = vi.fn()): Editor {
  return new Editor({
    element: document.createElement('div'),
    extensions: buildExtensions({
      slashController: { onOpen() {}, onUpdate() {}, onKeyDown: () => false, onClose() {} },
      slashItems: () => [],
      protectedSource: {
        onEditSource() {},
        onConvert() {},
        onConfirmChange,
      },
    }),
    content: {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Before' }] },
        { type: 'protectedSourceBlock', attrs: { id: 'html-1', raw: '<details>raw</details>', reason: 'raw-html' } },
        { type: 'paragraph', content: [{ type: 'text', text: 'After' }] },
      ],
    },
  })
}

function createDuplicateProtectedEditor(onConfirmChange = vi.fn()): Editor {
  return new Editor({
    element: document.createElement('div'),
    extensions: buildExtensions({
      slashController: { onOpen() {}, onUpdate() {}, onKeyDown: () => false, onClose() {} },
      slashItems: () => [],
      protectedSource: { onEditSource() {}, onConvert() {}, onConfirmChange },
    }),
    content: {
      type: 'doc',
      content: [
        { type: 'protectedSourceBlock', attrs: { id: 'duplicate', raw: '<a>', reason: 'raw-html' } },
        { type: 'protectedSourceBlock', attrs: { id: 'duplicate', raw: '<a>', reason: 'raw-html' } },
      ],
    },
  })
}

function createLosslessEditor(source: string, onConfirmChange = vi.fn()): { editor: Editor, session: ReturnType<typeof createMarkdownDocumentSession> } {
  let session: ReturnType<typeof createMarkdownDocumentSession> | undefined
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: buildExtensions({
      slashController: { onOpen() {}, onUpdate() {}, onKeyDown: () => false, onClose() {} },
      slashItems: () => [],
      protectedSource: { onEditSource() {}, onConvert() {}, onConfirmChange, getCurrentSource: () => session?.serialize() },
    }),
    content: '',
  })
  session = createMarkdownDocumentSession(source, createTiptapMarkdownCodec(editor))
  replaceEditorBaseline(editor, session.view().visual.doc)
  editor.on('transaction', ({ transaction }) => restoreSourceHistoryTransaction(session, editor, transaction))
  return { editor, session }
}

function protectedPosition(editor: Editor): number {
  let found = -1
  editor.state.doc.descendants((node, pos) => {
    if (node.attrs.id === 'html-1') found = pos
  })
  if (found < 0) throw new Error('Protected atom not found')
  return found
}

function anyProtectedPosition(editor: Editor): number {
  let found = -1
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'protectedSourceBlock' || node.type.name === 'protectedSourceInline') found = pos
  })
  if (found < 0) throw new Error('Protected atom not found')
  return found
}

function clipboardText(editor: Editor): (slice: ReturnType<NodeSelection['content']>) => string {
  let serializer: ((slice: ReturnType<NodeSelection['content']>) => string) | undefined
  editor.view.someProp('clipboardTextSerializer', (value) => {
    serializer = value as typeof serializer
    return true
  })
  return serializer ?? ((slice) => slice.content.textBetween(0, slice.content.size, '\n\n'))
}

describe('protected source change guard', () => {
  it('keeps protected atoms out of text selections and copies their raw source', () => {
    const editor = createEditor()
    const position = protectedPosition(editor)
    const atom = editor.state.doc.nodeAt(position)!

    expect(atom.isAtom).toBe(true)
    expect(atom.isLeaf).toBe(true)
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, position)))

    expect(editor.state.selection).toBeInstanceOf(NodeSelection)
    expect(clipboardText(editor)(editor.state.selection.content())).toBe('<details>raw</details>')
    editor.destroy()
  })

  it('allows a pure protected-fragment move without raising a confirmation', () => {
    const request = vi.fn()
    const editor = createEditor(request)
    const position = protectedPosition(editor)
    const atom = editor.state.doc.nodeAt(position)!
    const transaction = editor.state.tr.delete(position, position + atom.nodeSize).insert(0, atom)

    editor.view.dispatch(transaction)

    expect(request).not.toHaveBeenCalled()
    expect(editor.state.doc.firstChild?.attrs.id).toBe('html-1')
    editor.destroy()
  })

  it('allows only an authority-issued internal provenance update', () => {
    const editor = createEditor()
    const position = protectedPosition(editor)
    const atom = editor.state.doc.nodeAt(position)!
    const transaction = editor.state.tr.setNodeMarkup(position, undefined, { ...atom.attrs, id: 'html-2' })
    protectedSourceAuthority(editor).authorize(transaction)

    editor.view.dispatch(transaction)

    expect(editor.state.doc.nodeAt(position)?.attrs.id).toBe('html-2')
    editor.destroy()
  })

  it('authorizes App provenance synchronization without trusting its public meta', () => {
    const editor = createEditor()
    const position = protectedPosition(editor)
    const visual = editor.getJSON()
    const protectedNode = visual.content?.[1]!
    protectedNode.attrs = { ...protectedNode.attrs, id: 'html-2' }

    applyProjectionProvenance(editor, visual)

    expect(editor.state.doc.nodeAt(position)?.attrs.id).toBe('html-2')
    editor.destroy()
  })

  it('allows an authority-issued source snapshot transition', () => {
    const editor = createEditor()
    const replacement = editor.schema.nodeFromJSON({
      type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Before' }] }],
    })
    const transaction = editor.state.tr
      .replaceWith(0, editor.state.doc.content.size, replacement.content)
      .step(new SourceSnapshotStep('before', 'after'))
    protectedSourceAuthority(editor).authorize(transaction)

    editor.view.dispatch(transaction)

    expect(editor.getText()).toBe('Before')
    editor.destroy()
  })

  it.each([
    ['delete', undefined],
    ['cut', 'cut'],
  ])('blocks an unapproved protected %s without changing the document', (_kind, uiEvent) => {
    const request = vi.fn()
    const editor = createEditor(request)
    const before = editor.getJSON()
    const position = protectedPosition(editor)
    const atom = editor.state.doc.nodeAt(position)!
    let transaction = editor.state.tr.delete(position, position + atom.nodeSize)
    if (uiEvent) transaction = transaction.setMeta('uiEvent', uiEvent)

    editor.view.dispatch(transaction)

    expect(editor.getJSON()).toEqual(before)
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      ids: ['html-1'],
      kind: uiEvent ? 'cut' : 'delete',
      baseDoc: before,
      steps: expect.any(Array),
    }))
    editor.destroy()
  })

  it('rejects an evil document that reuses an approved undo source pair', () => {
    const requestSink = vi.fn()
    const { editor, session } = createLosslessEditor('<details>A</details>\n', requestSink)
    const position = anyProtectedPosition(editor)
    const atom = editor.state.doc.nodeAt(position)!
    editor.view.dispatch(editor.state.tr.setNodeMarkup(position, undefined, { ...atom.attrs, raw: '<details>B</details>' }))
    const request = requestSink.mock.calls[0][0] as ProtectedChangeRequest
    expect(applyProtectedChange(editor, request, session)).toEqual({ ok: true })
    const approvedSource = session.serialize()
    expect(undo(editor.state, editor.view.dispatch)).toBe(true)
    const restoredSource = session.serialize()
    const before = editor.getJSON()
    const evil = editor.schema.nodeFromJSON({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'EVIL' }] }] })

    editor.view.dispatch(editor.state.tr
      .replaceWith(0, editor.state.doc.content.size, evil.content)
      .step(new SourceSnapshotStep(approvedSource, restoredSource)))

    expect(editor.getJSON()).toEqual(before)
    expect(session.serialize()).toBe(restoredSource)
    editor.destroy()
  })

  it('does not let a source-aware history endpoint authorize a raw replacement without a snapshot', () => {
    const requestSink = vi.fn()
    const { editor, session } = createLosslessEditor('<details>A</details>\n', requestSink)
    const position = anyProtectedPosition(editor)
    const atom = editor.state.doc.nodeAt(position)!
    editor.view.dispatch(editor.state.tr.setNodeMarkup(position, undefined, { ...atom.attrs, raw: '<details>B</details>' }))
    const request = requestSink.mock.calls[0][0] as ProtectedChangeRequest
    expect(applyProtectedChange(editor, request, session)).toEqual({ ok: true })
    const before = editor.getJSON()
    const beforeSource = session.serialize()
    const original = editor.schema.nodeFromJSON(request.baseDoc)
    editor.view.dispatch(editor.state.tr.replaceWith(0, editor.state.doc.content.size, original.content))

    expect(editor.getJSON()).toEqual(before)
    expect(session.serialize()).toBe(beforeSource)
    expect(requestSink).toHaveBeenCalledTimes(2)
    editor.destroy()
  })

  it('keeps accepted transactions local to their editor state and baseline', () => {
    const extensions = buildExtensions({ slashController: { onOpen() {}, onUpdate() {}, onKeyDown: () => false, onClose() {} }, slashItems: () => [] })
    const content = { type: 'doc', content: [{ type: 'protectedSourceBlock', attrs: { id: 'local', raw: '<a>', reason: 'raw-html' } }] }
    const first = new Editor({ element: document.createElement('div'), extensions, content })
    const second = new Editor({ element: document.createElement('div'), extensions, content })
    const atom = first.state.doc.nodeAt(0)!
    const transaction = first.state.tr.delete(0, atom.nodeSize)
    protectedSourceAuthority(first).authorize(transaction)
    first.view.dispatch(transaction)

    expect(protectedSourceAuthority(first).accepts(transaction)).toBe(true)
    expect(protectedSourceAuthority(second).accepts(transaction)).toBe(false)
    replaceEditorBaseline(first, content)
    expect(protectedSourceAuthority(first).accepts(transaction)).toBe(false)
    first.destroy()
    second.destroy()
  })

  it('blocks a raw replacement and records it as a replace request', () => {
    const request = vi.fn()
    const editor = createEditor(request)
    const before = editor.getJSON()
    const position = protectedPosition(editor)
    const atom = editor.state.doc.nodeAt(position)!

    editor.view.dispatch(editor.state.tr.setNodeMarkup(position, undefined, { ...atom.attrs, raw: '<details>changed</details>' }))

    expect(editor.getJSON()).toEqual(before)
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ ids: ['html-1'], kind: 'replace' }))
    editor.destroy()
  })

  it.each([
    ['uiOnly', true],
    ['history$' as const, true],
  ])('does not trust a forged %s transaction meta', (meta, value) => {
    const request = vi.fn()
    const editor = createEditor(request)
    const before = editor.getJSON()
    const position = protectedPosition(editor)
    const atom = editor.state.doc.nodeAt(position)!

    editor.view.dispatch(editor.state.tr.delete(position, position + atom.nodeSize).setMeta(meta, value))

    expect(editor.getJSON()).toEqual(before)
    expect(request).toHaveBeenCalledOnce()
    editor.destroy()
  })

  it('classifies deleting an atom while inserting replacement content as replace', () => {
    const request = vi.fn()
    const editor = createEditor(request)
    const position = protectedPosition(editor)
    const atom = editor.state.doc.nodeAt(position)!
    const replacement = editor.schema.nodes.paragraph.create(null, editor.schema.text('Replacement'))

    editor.view.dispatch(editor.state.tr.delete(position, position + atom.nodeSize).insert(position, replacement))

    expect(request).toHaveBeenCalledWith(expect.objectContaining({ ids: ['html-1'], kind: 'replace' }))
    editor.destroy()
  })

  it('deduplicates repeated protected ids in a destructive multiset request', () => {
    const request = vi.fn()
    const editor = createDuplicateProtectedEditor(request)
    const first = 0
    const atom = editor.state.doc.nodeAt(first)!

    editor.view.dispatch(editor.state.tr.delete(first, first + atom.nodeSize))

    expect(request).toHaveBeenCalledWith(expect.objectContaining({ ids: ['duplicate'], kind: 'delete' }))
    editor.destroy()
  })

  it('keeps ProseMirror block separators while copying a selection containing an atom', () => {
    const editor = createEditor()
    const atom = editor.state.doc.nodeAt(protectedPosition(editor))!
    const slice = editor.state.doc.slice(0, editor.state.doc.content.size)

    expect(clipboardText(editor)(slice)).toBe(`Before\n\n${atom.attrs.raw}\n\nAfter`)
    editor.destroy()
  })

  it('preserves hard breaks when serializing a protected selection to the clipboard', () => {
    const editor = createEditor()
    const protectedNode = editor.state.doc.nodeAt(protectedPosition(editor))!
    const document = editor.schema.nodeFromJSON({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'First' }, { type: 'hardBreak' }, { type: 'text', text: 'Second' }] },
        protectedNode.toJSON(),
        { type: 'paragraph', content: [{ type: 'text', text: 'After' }] },
      ],
    })

    expect(clipboardText(editor)(document.slice(0, document.content.size))).toBe(`First\nSecond\n\n${protectedNode.attrs.raw}\n\nAfter`)
    editor.destroy()
  })

  it('rebuilds an approved request against the current document once and records one undo step', () => {
    const requestSink = vi.fn()
    const editor = createEditor(requestSink)
    const position = protectedPosition(editor)
    const atom = editor.state.doc.nodeAt(position)!
    editor.view.dispatch(editor.state.tr.delete(position, position + atom.nodeSize))
    const request = requestSink.mock.calls[0][0] as ProtectedChangeRequest

    expect(applyProtectedChange(editor, request)).toEqual({ ok: true })
    expect(editor.getText()).toBe('Before\n\nAfter')
    expect(undoDepth(editor.state)).toBe(1)
    expect(undo(editor.state, editor.view.dispatch)).toBe(true)
    expect(editor.state.doc.nodeAt(protectedPosition(editor))?.attrs.raw).toBe('<details>raw</details>')
    expect(undo(editor.state, editor.view.dispatch)).toBe(false)
    expect(redo(editor.state, editor.view.dispatch)).toBe(true)
    expect(requestSink).toHaveBeenCalledTimes(1)
    expect(() => protectedPosition(editor)).toThrow('Protected atom not found')
    editor.destroy()
  })

  it('commits an approved change to the session only after dispatch, then saves and restores it through undo/redo', () => {
    const requestSink = vi.fn()
    let session: ReturnType<typeof createMarkdownDocumentSession> | undefined
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: buildExtensions({
        slashController: { onOpen() {}, onUpdate() {}, onKeyDown: () => false, onClose() {} },
        slashItems: () => [],
        protectedSource: { onEditSource() {}, onConvert() {}, onConfirmChange: requestSink, getCurrentSource: () => session?.serialize() },
      }),
      content: '',
    })
    session = createMarkdownDocumentSession('Before\n\n<!-- raw -->\n', createTiptapMarkdownCodec(editor))
    editor.commands.setContent(session.view().visual.doc)
    editor.on('transaction', ({ transaction }) => restoreSourceHistoryTransaction(session, editor, transaction))
    const position = anyProtectedPosition(editor)
    const atom = editor.state.doc.nodeAt(position)!
    const beforeSource = session.serialize()

    editor.view.dispatch(editor.state.tr.delete(position, position + atom.nodeSize))
    const request = requestSink.mock.calls[0][0] as ProtectedChangeRequest
    expect(session.serialize()).toBe(beforeSource)

    expect(applyProtectedChange(editor, request, session)).toEqual({ ok: true })
    expect(session.serialize()).not.toContain('<!-- raw -->')
    expect(session.view().dirty).toBe(true)
    expect(session.beginSave().source).toBe(session.serialize())
    expect(undo(editor.state, editor.view.dispatch)).toBe(true)
    expect(session.serialize()).toBe(beforeSource)
    expect(redo(editor.state, editor.view.dispatch)).toBe(true)
    expect(session.serialize()).not.toContain('<!-- raw -->')
    editor.destroy()
  })

  it('isolates consecutive approved changes into separate source-aware history events', () => {
    const requestSink = vi.fn()
    const { editor, session } = createLosslessEditor('Before\n\n<details>one</details>\n\nMiddle\n\n<details>two</details>\n\nAfter\n', requestSink)
    const before = session.serialize()
    const sources: string[] = []

    for (let index = 0; index < 2; index += 1) {
      const position = anyProtectedPosition(editor)
      const atom = editor.state.doc.nodeAt(position)!
      editor.view.dispatch(editor.state.tr.delete(position, position + atom.nodeSize))
      const request = requestSink.mock.calls.at(-1)![0] as ProtectedChangeRequest
      expect(applyProtectedChange(editor, request, session)).toEqual({ ok: true })
      sources.push(session.serialize())
    }

    expect(undoDepth(editor.state)).toBe(2)
    expect(undo(editor.state, editor.view.dispatch)).toBe(true)
    expect(session.serialize()).toBe(sources[0])
    expect(undo(editor.state, editor.view.dispatch)).toBe(true)
    expect(session.serialize()).toBe(before)
    expect(redo(editor.state, editor.view.dispatch)).toBe(true)
    expect(session.serialize()).toBe(sources[0])
    expect(redo(editor.state, editor.view.dispatch)).toBe(true)
    expect(session.serialize()).toBe(sources[1])
    editor.destroy()
  })

  it('returns failure without changing a session when another plugin rejects an approved dispatch', () => {
    const requestSink = vi.fn()
    let rejectApproved = true
    const rejector = Extension.create({
      addProseMirrorPlugins() {
        return [new Plugin({
          filterTransaction(transaction) {
            return transaction.getMeta(APPROVED_PROTECTED_CHANGE) !== true || !rejectApproved
          },
        })]
      },
    })
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: [...buildExtensions({
        slashController: { onOpen() {}, onUpdate() {}, onKeyDown: () => false, onClose() {} },
        slashItems: () => [],
        protectedSource: { onEditSource() {}, onConvert() {}, onConfirmChange: requestSink },
      }), rejector],
      content: '',
    })
    const session = createMarkdownDocumentSession('<!-- raw -->\n', createTiptapMarkdownCodec(editor))
    editor.commands.setContent(session.view().visual.doc)
    editor.on('transaction', ({ transaction }) => restoreSourceHistoryTransaction(session, editor, transaction))
    const position = anyProtectedPosition(editor)
    const atom = editor.state.doc.nodeAt(position)!
    const beforeDoc = editor.getJSON()
    const beforeSource = session.serialize()
    editor.view.dispatch(editor.state.tr.delete(position, position + atom.nodeSize))
    const request = requestSink.mock.calls[0][0] as ProtectedChangeRequest

    expect(applyProtectedChange(editor, request, session)).toEqual({ ok: false, error: 'Protected change was rejected' })
    expect(editor.getJSON()).toEqual(beforeDoc)
    expect(session.serialize()).toBe(beforeSource)
    rejectApproved = false
    expect(applyProtectedChange(editor, request, session)).toEqual({ ok: true })
    editor.destroy()
  })

  it('discards a pending signature when an append transaction throws, then retries cleanly', () => {
    const requestSink = vi.fn()
    let throwAppend = true
    let failedRoot: Transaction | undefined
    const throwingAppender = Extension.create({
      addProseMirrorPlugins() {
        return [new Plugin({
          appendTransaction(transactions) {
            if (throwAppend && transactions.some((transaction) => transaction.getMeta(APPROVED_PROTECTED_CHANGE) === true)) {
              failedRoot = transactions.find((transaction) => transaction.getMeta(APPROVED_PROTECTED_CHANGE) === true)
              throw new Error('append failed')
            }
            return null
          },
        })]
      },
    })
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: [...buildExtensions({ slashController: { onOpen() {}, onUpdate() {}, onKeyDown: () => false, onClose() {} }, slashItems: () => [], protectedSource: { onEditSource() {}, onConvert() {}, onConfirmChange: requestSink } }), throwingAppender],
      content: '',
    })
    const session = createMarkdownDocumentSession('<!-- raw -->\n', createTiptapMarkdownCodec(editor))
    replaceEditorBaseline(editor, session.view().visual.doc)
    editor.on('transaction', ({ transaction }) => restoreSourceHistoryTransaction(session, editor, transaction))
    const position = anyProtectedPosition(editor)
    const atom = editor.state.doc.nodeAt(position)!
    const beforeSource = session.serialize()
    editor.view.dispatch(editor.state.tr.delete(position, position + atom.nodeSize))
    const request = requestSink.mock.calls[0][0] as ProtectedChangeRequest

    expect(applyProtectedChange(editor, request, session)).toMatchObject({ ok: false })
    expect(session.serialize()).toBe(beforeSource)
    throwAppend = false
    const beforeRetry = editor.getJSON()
    editor.view.dispatch(failedRoot!)
    expect(editor.getJSON()).toEqual(beforeRetry)
    expect(applyProtectedChange(editor, request, session)).toEqual({ ok: true })
    editor.destroy()
  })

  it('finalizes one approved event after an appended visual change and restores its final source', () => {
    const requestSink = vi.fn()
    let session: ReturnType<typeof createMarkdownDocumentSession> | undefined
    const appender = Extension.create({
      addProseMirrorPlugins() {
        return [new Plugin({
          appendTransaction(transactions, _oldState, state) {
            if (!transactions.some((transaction) => transaction.getMeta(APPROVED_PROTECTED_CHANGE) === true)) return null
            return state.tr.insertText(' X', state.doc.content.size - 1)
          },
        })]
      },
    })
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: [...buildExtensions({
        slashController: { onOpen() {}, onUpdate() {}, onKeyDown: () => false, onClose() {} },
        slashItems: () => [],
        protectedSource: { onEditSource() {}, onConvert() {}, onConfirmChange: requestSink, getCurrentSource: () => session?.serialize() },
      }), appender],
      content: '',
    })
    session = createMarkdownDocumentSession('Before\n\n<!-- raw -->\n', createTiptapMarkdownCodec(editor))
    replaceEditorBaseline(editor, session.view().visual.doc)
    editor.on('transaction', ({ transaction }) => restoreSourceHistoryTransaction(session, editor, transaction))
    editor.on('update', ({ editor: updated }) => {
      session?.applyVisual({ doc: updated.getJSON(), frontmatterInner: session.view().visual.frontmatterInner })
    })
    const position = anyProtectedPosition(editor)
    const atom = editor.state.doc.nodeAt(position)!
    editor.view.dispatch(editor.state.tr.delete(position, position + atom.nodeSize))
    const request = requestSink.mock.calls[0][0] as ProtectedChangeRequest

    expect(applyProtectedChange(editor, request, session)).toEqual({ ok: true })
    const finalSource = session.serialize()
    expect(finalSource).toContain(' X')
    expect(undo(editor.state, editor.view.dispatch)).toBe(true)
    expect(session.serialize()).toContain('<!-- raw -->')
    expect(redo(editor.state, editor.view.dispatch)).toBe(true)
    expect(session.serialize()).toBe(finalSource)
    editor.destroy()
  })

  it('rejects an appended transaction that expands an approval to another protected atom', () => {
    const requestSink = vi.fn()
    let session: ReturnType<typeof createMarkdownDocumentSession> | undefined
    let appended = 0
    const destructiveAppender = Extension.create({
      addProseMirrorPlugins() {
        return [new Plugin({
          appendTransaction(transactions, _oldState, state) {
            if (!transactions.some((transaction) => transaction.getMeta(APPROVED_PROTECTED_CHANGE) === true)) return null
            appended += 1
            let protectedPos = -1
            let protectedSize = 0
            state.doc.descendants((node, pos) => {
              if (protectedPos < 0 && node.type.name === 'protectedSourceBlock') {
                protectedPos = pos
                protectedSize = node.nodeSize
              }
            })
            return protectedPos < 0 ? null : state.tr.delete(protectedPos, protectedPos + protectedSize)
          },
        })]
      },
    })
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: [...buildExtensions({
        slashController: { onOpen() {}, onUpdate() {}, onKeyDown: () => false, onClose() {} },
        slashItems: () => [],
        protectedSource: { onEditSource() {}, onConvert() {}, onConfirmChange: requestSink, getCurrentSource: () => session?.serialize() },
      }), destructiveAppender],
      content: '',
    })
    session = createMarkdownDocumentSession('<details>A</details>\n\n<details>B</details>\n', createTiptapMarkdownCodec(editor))
    replaceEditorBaseline(editor, session.view().visual.doc)
    editor.on('transaction', ({ transaction }) => restoreSourceHistoryTransaction(session, editor, transaction))
    let protectedCount = 0
    editor.state.doc.descendants((node) => { if (node.type.name === 'protectedSourceBlock') protectedCount += 1 })
    expect(protectedCount).toBe(2)
    const beforeDoc = editor.getJSON()
    const beforeSource = session.serialize()
    const position = anyProtectedPosition(editor)
    const atom = editor.state.doc.nodeAt(position)!
    editor.view.dispatch(editor.state.tr.delete(position, position + atom.nodeSize))
    const request = requestSink.mock.calls[0][0] as ProtectedChangeRequest

    const result = applyProtectedChange(editor, request, session)
    expect(appended).toBe(1)
    expect(result).toMatchObject({ ok: false })
    expect(editor.getJSON()).toEqual(beforeDoc)
    expect(session.serialize()).toBe(beforeSource)
    editor.destroy()
  })

  it('keeps recent source-aware approvals reversible after 125 isolated events', () => {
    const requestSink = vi.fn()
    const source = Array.from({ length: 125 }, (_, index) => `<!-- raw-${index} -->`).join('\n\n') + '\n'
    const { editor, session } = createLosslessEditor(source, requestSink)

    for (let index = 0; index < 125; index += 1) {
      const position = anyProtectedPosition(editor)
      const atom = editor.state.doc.nodeAt(position)!
      editor.view.dispatch(editor.state.tr.delete(position, position + atom.nodeSize))
      const request = requestSink.mock.calls.at(-1)![0] as ProtectedChangeRequest
      expect(applyProtectedChange(editor, request, session)).toEqual({ ok: true })
    }
    for (let index = 0; index < 104; index += 1) expect(undo(editor.state, editor.view.dispatch)).toBe(true)
    for (let index = 0; index < 104; index += 1) expect(redo(editor.state, editor.view.dispatch)).toBe(true)
    expect(session.serialize()).toBe('')
    editor.destroy()
  })

  it('serializes an approved protected block raw replacement into source and history', () => {
    const requestSink = vi.fn()
    const { editor, session } = createLosslessEditor('<details>A</details>\n', requestSink)
    const position = anyProtectedPosition(editor)
    const atom = editor.state.doc.nodeAt(position)!
    editor.view.dispatch(editor.state.tr.setNodeMarkup(position, undefined, { ...atom.attrs, raw: '<details>B</details>' }))
    const request = requestSink.mock.calls[0][0] as ProtectedChangeRequest

    expect(applyProtectedChange(editor, request, session)).toEqual({ ok: true })
    expect(session.beginSave().source).toContain('<details>B</details>')
    expect(undo(editor.state, editor.view.dispatch)).toBe(true)
    expect(session.serialize()).toContain('<details>A</details>')
    expect(redo(editor.state, editor.view.dispatch)).toBe(true)
    expect(session.serialize()).toContain('<details>B</details>')
    editor.destroy()
  })

  it('treats deletion of one same-id different-raw instance as delete', () => {
    const request = vi.fn()
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: buildExtensions({ slashController: { onOpen() {}, onUpdate() {}, onKeyDown: () => false, onClose() {} }, slashItems: () => [], protectedSource: { onEditSource() {}, onConvert() {}, onConfirmChange: request } }),
      content: { type: 'doc', content: [
        { type: 'protectedSourceBlock', attrs: { id: 'duplicate', raw: '<a>', reason: 'raw-html' } },
        { type: 'protectedSourceBlock', attrs: { id: 'duplicate', raw: '<b>', reason: 'raw-html' } },
      ] },
    })
    const atom = editor.state.doc.nodeAt(0)!
    editor.view.dispatch(editor.state.tr.delete(0, atom.nodeSize))

    expect(request).toHaveBeenCalledWith(expect.objectContaining({ ids: ['duplicate'], kind: 'delete' }))
    editor.destroy()
  })

  it('does not share an authority between editors made from one extensions array', () => {
    const onConfirmChange = vi.fn()
    const extensions = buildExtensions({
      slashController: { onOpen() {}, onUpdate() {}, onKeyDown: () => false, onClose() {} },
      slashItems: () => [],
      protectedSource: { onEditSource() {}, onConvert() {}, onConfirmChange },
    })
    const content = { type: 'doc', content: [{ type: 'protectedSourceBlock', attrs: { id: 'shared', raw: '<a>', reason: 'raw-html' } }] }
    const first = new Editor({ element: document.createElement('div'), extensions, content })
    const second = new Editor({ element: document.createElement('div'), extensions, content })
    const before = second.getJSON()
    const atom = second.state.doc.nodeAt(0)!
    const transaction = second.state.tr.delete(0, atom.nodeSize)
    protectedSourceAuthority(first).authorize(transaction)

    second.view.dispatch(transaction)

    expect(second.getJSON()).toEqual(before)
    expect(onConfirmChange).toHaveBeenCalledOnce()
    first.destroy()
    second.destroy()
  })

  it('rejects a stale request instead of replaying its old transaction', () => {
    const requestSink = vi.fn()
    const editor = createEditor(requestSink)
    const position = protectedPosition(editor)
    const atom = editor.state.doc.nodeAt(position)!
    editor.view.dispatch(editor.state.tr.delete(position, position + atom.nodeSize))
    const request = requestSink.mock.calls[0][0] as ProtectedChangeRequest
    editor.commands.insertContentAt(1, 'Changed ')

    expect(applyProtectedChange(editor, request)).toEqual({ ok: false, error: 'Protected change is stale' })
    expect(editor.state.doc.nodeAt(protectedPosition(editor))?.attrs.raw).toBe('<details>raw</details>')
    editor.destroy()
  })
})

describe('ProtectedSourceView', () => {
  it('renders raw HTML as text and keeps conversion unavailable without a proposal service', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    roots.push({ root, host })

    act(() => root.render(createElement(ProtectedSourceView, {
      node: { attrs: { id: 'html-1', raw: '<img src=x onerror=alert(1)>', reason: 'raw-html' }, isInline: false } as never,
      editor: { isEditable: true } as never,
      onEditSource: () => {},
      onConvert: () => {},
    })))

    expect(host.textContent).toContain('<img src=x onerror=alert(1)>')
    expect(host.querySelector('img')).toBeNull()
    expect(host.querySelector<HTMLButtonElement>('[data-protected-convert]')?.disabled).toBe(true)
  })
})

describe('ProtectedChangeConfirm', () => {
  it('reports the affected count and clears only the pending request when cancelled', () => {
    const editor = createEditor()
    const dismiss = vi.fn()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    roots.push({ root, host })
    const request: ProtectedChangeRequest = {
      ids: ['html-1'],
      kind: 'delete',
      baseDoc: editor.getJSON(),
      steps: [],
    }

    act(() => root.render(createElement(ProtectedChangeConfirm, { editor, request, onDismiss: dismiss })))

    expect(host.querySelector('[role="dialog"]')?.textContent).toContain('1')
    const cancel = host.querySelector<HTMLButtonElement>('[data-protected-change-cancel]')!
    act(() => cancel.click())
    expect(dismiss).toHaveBeenCalledOnce()
    editor.destroy()
  })
})
