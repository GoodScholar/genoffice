import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Editor } from '@tiptap/core'
import { NodeSelection } from '@tiptap/pm/state'
import { redo, undo, undoDepth } from '@tiptap/pm/history'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProtectedSourceView } from '../src/renderer/editor/ProtectedSourceView'
import { ProtectedChangeConfirm } from '../src/renderer/components/ProtectedChangeConfirm'
import {
  applyProtectedChange,
  protectedSourceAuthority,
  type ProtectedChangeRequest,
} from '../src/renderer/editor/protectedSource'
import { buildExtensions } from '../src/renderer/editor/extensions'
import { applyProjectionProvenance } from '../src/renderer/App'
import { restoreSourceHistoryTransaction } from '../src/renderer/App'
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
    expect(() => protectedPosition(editor)).toThrow('Protected atom not found')
    editor.destroy()
  })

  it('commits an approved change to the session only after dispatch, then saves and restores it through undo/redo', () => {
    const requestSink = vi.fn()
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: buildExtensions({
        slashController: { onOpen() {}, onUpdate() {}, onKeyDown: () => false, onClose() {} },
        slashItems: () => [],
        protectedSource: { onEditSource() {}, onConvert() {}, onConfirmChange: requestSink },
      }),
      content: '',
    })
    const session = createMarkdownDocumentSession('Before\n\n<!-- raw -->\n', createTiptapMarkdownCodec(editor))
    editor.commands.setContent(session.view().visual.doc)
    editor.on('transaction', ({ transaction }) => restoreSourceHistoryTransaction(session, transaction))
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
