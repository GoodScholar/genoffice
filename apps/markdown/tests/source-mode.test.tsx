import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import { redo, undo, undoDepth } from '@tiptap/pm/history'
import {
  completeSourceModeTransition,
  applyProjectionProvenance,
  replaceSourceModeVisualDocument,
  restoreSourceHistoryTransaction,
  replaceEditorBaseline,
  type SourceModeSnapshot,
} from '../src/renderer/App'
import { SourceEditor } from '../src/renderer/components/SourceEditor'
import { Ribbon } from '../src/renderer/components/Ribbon'
import { buildExtensions } from '../src/renderer/editor/extensions'
import { LocaleProvider } from '../src/renderer/i18n/locale'
import { createMarkdownDocumentSession } from '../src/renderer/markdown/documentSession'
import { createTiptapMarkdownCodec, type MarkdownCodec } from '../src/renderer/markdown/sourceProjection'
import { SourceSnapshotStep, sourceSnapshotFromTransaction } from '../src/renderer/markdown/sourceHistory'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root, host: HTMLDivElement }> = []

afterEach(() => {
  while (roots.length) {
    const mounted = roots.pop()!
    act(() => mounted.root.unmount())
    mounted.host.remove()
  }
})

function renderSourceEditor(props: React.ComponentProps<typeof SourceEditor>): HTMLTextAreaElement {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  roots.push({ root, host })
  act(() => root.render(<SourceEditor {...props} />))
  const textarea = host.querySelector('textarea')
  if (!textarea) throw new Error('SourceEditor did not render a textarea')
  return textarea
}

function renderComponent(element: React.ReactElement): HTMLElement {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  roots.push({ root, host })
  act(() => root.render(element))
  return host
}

describe('SourceEditor', () => {
  it('focuses and selects the supplied source range after mount', () => {
    const textarea = renderSourceEditor({
      value: '\uFEFFfirst\r\nsecond',
      selection: { from: 1, to: 6 },
      onChange: () => {},
      onExit: () => {},
    })

    expect(document.activeElement).toBe(textarea)
    expect(textarea.selectionStart).toBe(1)
    expect(textarea.selectionEnd).toBe(6)
  })

  it('maps a CRLF source range to the textarea selection offsets', () => {
    const source = '\uFEFFfirst\r\nsecond'
    const textarea = renderSourceEditor({
      value: source,
      selection: { from: source.indexOf('second'), to: source.length },
      onChange: () => {},
      onExit: () => {},
    })

    expect(textarea.value.slice(textarea.selectionStart, textarea.selectionEnd)).toBe('second')
  })

  it('returns BOM and CRLF source text unchanged', () => {
    const onChange = vi.fn()
    const source = '\uFEFFone\r\ntwo\r\n'
    const textarea = renderSourceEditor({
      value: source,
      onChange,
      onExit: () => {},
    })
    const edited = `${source}three`

    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, edited)
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })

    expect(onChange).toHaveBeenCalledWith(edited)
  })

  it('preserves untouched mixed line endings when editing the final character', () => {
    const onChange = vi.fn()
    const source = 'a\r\nb\nc'
    const textarea = renderSourceEditor({ value: source, onChange, onExit: () => {} })

    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'a\nb\nc!')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })

    expect(onChange).toHaveBeenCalledWith('a\r\nb\nc!')
  })

  it('does not intercept Cmd or Ctrl+S', () => {
    const textarea = renderSourceEditor({ value: 'text', onChange: () => {}, onExit: () => {} })

    for (const options of [{ metaKey: true }, { ctrlKey: true }]) {
      const event = new KeyboardEvent('keydown', { key: 's', bubbles: true, cancelable: true, ...options })
      textarea.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(false)
    }
  })
})

describe('source-mode visual handoff', () => {
  it('keeps a no-edit round trip clean and rebuilds the visual document from edited source', () => {
    const editor = new Editor({
      extensions: buildExtensions({
        slashController: { onOpen: () => {}, onUpdate: () => {}, onKeyDown: () => false, onClose: () => {} },
        slashItems: () => [],
      }),
      content: '',
    })
    const codec: MarkdownCodec = {
      lex: (source) => [{ type: 'paragraph', raw: source }],
      parse: (source) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: source.trim() }] }] }),
      serialize: (doc) => String(doc.content?.[0]?.content?.[0]?.text ?? ''),
    }
    const session = createMarkdownDocumentSession('Before.\n', codec)

    expect(session.enterSource()).toMatchObject({ ok: true })
    expect(session.enterVisual()).toMatchObject({ ok: true })
    expect(session.view()).toMatchObject({ dirty: false, revision: 0, mode: 'visual' })

    expect(session.enterSource()).toMatchObject({ ok: true })
    expect(session.applySource('After.\n')).toMatchObject({ ok: true })
    const visual = session.enterVisual()
    expect(visual).toMatchObject({ ok: true, view: expect.objectContaining({ mode: 'visual' }) })
    expect(session.view().visual.doc).toMatchObject({
      type: 'doc',
      content: [expect.objectContaining({ type: 'paragraph', content: [{ type: 'text', text: 'After.' }] })],
    })
    replaceSourceModeVisualDocument(editor, session.view().visual.doc, 'Before.\n', 'After.\n')

    expect(editor.getText()).toBe('After.')
    editor.destroy()
  })

  it('retains unprojectable source in source mode for saving', () => {
    const editor = new Editor({
      extensions: buildExtensions({
        slashController: { onOpen: () => {}, onUpdate: () => {}, onKeyDown: () => false, onClose: () => {} },
        slashItems: () => [],
      }),
      content: '',
    })
    const codec = createTiptapMarkdownCodec(editor)
    const session = createMarkdownDocumentSession('Before.', { ...codec, lex: () => { throw new Error('cannot project') } })

    const update = session.applySource('\uFEFFsource\r\nthat must stay')

    expect(update).toMatchObject({ ok: false, view: expect.objectContaining({ mode: 'source' }) })
    expect(session.serialize()).toBe('\uFEFFsource\r\nthat must stay')
    editor.destroy()
  })
})

describe('source-mode history checkpoint', () => {
  it('restores an empty source snapshot through a real history transaction', () => {
    const editor = new Editor({ element: document.createElement('div'), extensions: buildExtensions({ slashController: { onOpen() {}, onUpdate() {}, onKeyDown: () => false, onClose() {} }, slashItems: () => [] }), content: '' })
    const codec: MarkdownCodec = { lex: (source) => source ? [{ type: 'paragraph', raw: source }] : [], parse: (source) => ({ type: 'doc', content: source ? [{ type: 'paragraph', content: [{ type: 'text', text: source.trim() }] }] : [] }), serialize: () => '' }
    const session = createMarkdownDocumentSession('', codec)
    const before: SourceModeSnapshot = { source: '', visual: session.view().visual }
    session.enterSource()
    session.applySource('---\ntitle: after\n---\n\nBody\n')
    completeSourceModeTransition(session, editor, before)
    editor.on('transaction', ({ transaction }) => restoreSourceHistoryTransaction(session, transaction))

    expect(undo(editor.state, editor.view.dispatch)).toBe(true)
    expect(session.view()).toMatchObject({ source: '', dirty: false, mode: 'visual' })
    expect(redo(editor.state, editor.view.dispatch)).toBe(true)
    expect(session.view().source).toContain('title: after')
    editor.destroy()
  })
  it('resets history when replacing an editor baseline', () => {
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: buildExtensions({ slashController: { onOpen() {}, onUpdate() {}, onKeyDown: () => false, onClose() {} }, slashItems: () => [] }),
      content: 'Old', contentType: 'markdown',
    })
    editor.commands.setContent('Changed', { contentType: 'markdown' })
    expect(undoDepth(editor.state)).toBeGreaterThan(0)

    replaceEditorBaseline(editor, { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'New' }] }] })

    expect(editor.getText()).toBe('New')
    expect(undoDepth(editor.state)).toBe(0)
    expect(undo(editor.state, editor.view.dispatch)).toBe(false)
    editor.destroy()
  })

  it('creates a valid editable empty document baseline without history', () => {
    const editor = new Editor({ element: document.createElement('div'), extensions: buildExtensions({ slashController: { onOpen() {}, onUpdate() {}, onKeyDown: () => false, onClose() {} }, slashItems: () => [] }), content: 'Old', contentType: 'markdown' })
    replaceEditorBaseline(editor, { type: 'doc', content: [] })

    expect(() => editor.state.doc.check()).not.toThrow()
    expect(editor.state.doc.firstChild?.type.name).toBe('paragraph')
    expect(() => editor.state.doc.resolve(1)).not.toThrow()
    expect(undoDepth(editor.state)).toBe(0)
    expect(redo(editor.state, editor.view.dispatch)).toBe(false)
    editor.destroy()
  })

  it('rejects an invalid non-empty baseline without mutating editor state or history', () => {
    const editor = new Editor({ element: document.createElement('div'), extensions: buildExtensions({ slashController: { onOpen() {}, onUpdate() {}, onKeyDown: () => false, onClose() {} }, slashItems: () => [] }), content: 'Keep', contentType: 'markdown' })
    editor.commands.setContent('Keep changed', { contentType: 'markdown' })
    const beforeDoc = editor.state.doc
    const beforeSelection = editor.state.selection
    const beforeUndo = undoDepth(editor.state)

    expect(() => replaceEditorBaseline(editor, { type: 'doc', content: [{ type: 'text', text: 'invalid top-level text' }] })).toThrow()
    expect(editor.state.doc).toBe(beforeDoc)
    expect(editor.state.selection).toBe(beforeSelection)
    expect(undoDepth(editor.state)).toBe(beforeUndo)
    editor.destroy()
  })
  it('serializes an invertible no-document source snapshot step in the history transaction', () => {
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: buildExtensions({ slashController: { onOpen() {}, onUpdate() {}, onKeyDown: () => false, onClose() {} }, slashItems: () => [] }),
      content: 'Body', contentType: 'markdown',
    })
    const transaction = editor.state.tr.step(new SourceSnapshotStep('before', 'after'))
    expect(transaction.doc).toBe(editor.state.doc)
    expect(sourceSnapshotFromTransaction(transaction)).toEqual('after')
    expect(transaction.steps[0]!.invert(editor.state.doc).toJSON()).toMatchObject({ source: 'before' })
    editor.destroy()
  })
  it('does not dispatch or add history for an unchanged source round trip', () => {
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: buildExtensions({
        slashController: { onOpen: () => {}, onUpdate: () => {}, onKeyDown: () => false, onClose: () => {} },
        slashItems: () => [],
      }),
      content: 'Before.',
      contentType: 'markdown',
    })
    const codec: MarkdownCodec = {
      lex: (source) => [{ type: 'paragraph', raw: source }],
      parse: (source) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: source.trim() }] }] }),
      serialize: (doc) => String(doc.content?.[0]?.content?.[0]?.text ?? ''),
    }
    const session = createMarkdownDocumentSession('Before.\n', codec)
    const start: SourceModeSnapshot = { source: session.view().source, visual: session.view().visual }
    session.enterSource()
    const dispatch = vi.spyOn(editor.view, 'dispatch')

    const transition = completeSourceModeTransition(session, editor, start)

    expect(transition).toMatchObject({ ok: true, changed: false })
    expect(dispatch).not.toHaveBeenCalled()
    expect(undoDepth(editor.state)).toBe(0)
    editor.destroy()
  })

  it('keeps the source replacement separate and restores body plus frontmatter through real undo and redo', () => {
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: buildExtensions({
        slashController: { onOpen: () => {}, onUpdate: () => {}, onKeyDown: () => false, onClose: () => {} },
        slashItems: () => [],
      }),
      content: 'Old.',
      contentType: 'markdown',
    })
    const codec: MarkdownCodec = {
      lex: (source) => [{ type: 'paragraph', raw: source }],
      parse: (source) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: source.trim().replace(/^---[\s\S]*?---\s*/, '') }] }] }),
      serialize: (doc) => String(doc.content?.[0]?.content?.[0]?.text ?? ''),
    }
    const session = createMarkdownDocumentSession('---\ntitle: before\n---\n\nBefore.\n', codec)
    editor.commands.setContent(session.view().visual.doc)
    const start: SourceModeSnapshot = { source: session.view().source, visual: session.view().visual }
    editor.commands.setContent('Before visual edit.', { contentType: 'markdown' })
    const visualUpdate = session.applyVisual({ doc: editor.getJSON(), frontmatterInner: 'title: before' })
    if (!visualUpdate.ok) throw new Error(visualUpdate.error)
    applyProjectionProvenance(editor, visualUpdate.view.visual.doc)
    const visualStart: SourceModeSnapshot = { source: session.view().source, visual: session.view().visual }

    session.enterSource()
    session.applySource('---\ntitle: after\n---\n\nAfter source edit.\n')
    const transition = completeSourceModeTransition(session, editor, visualStart)
    expect(transition).toMatchObject({ ok: true, changed: true })
    expect(undoDepth(editor.state)).toBe(2)
    let restored: ReturnType<typeof restoreSourceHistoryTransaction>
    editor.on('transaction', ({ transaction }) => {
      restored = restoreSourceHistoryTransaction(session, transaction)
    })
    expect(undo(editor.state, editor.view.dispatch)).toBe(true)
    expect(editor.getText()).toBe('Before visual edit.')
    expect(restored).toBeDefined()
    expect(session.view()).toMatchObject({ source: visualStart.source, mode: 'visual' })
    expect(session.view().visual.frontmatterInner).toBe('title: before')
    expect(editor.getText()).toBe('Before visual edit.')
    expect(redo(editor.state, editor.view.dispatch)).toBe(true)
    expect(restored).toBeDefined()
    expect(session.view()).toMatchObject({ source: '---\ntitle: after\n---\n\nAfter source edit.\n', mode: 'visual' })
    expect(session.view().visual.frontmatterInner).toBe('title: after')
    expect(editor.getText()).toBe('After source edit.')
    expect(start.source).toContain('title: before')
    editor.destroy()
  })
})

describe('source-mode ribbon', () => {
  it('disables frontmatter and outline controls in source mode', () => {
    ;(window as unknown as { markdownApi: { onLanguageChanged: () => () => void } }).markdownApi = {
      onLanguageChanged: () => () => {},
    }
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: buildExtensions({
        slashController: { onOpen: () => {}, onUpdate: () => {}, onKeyDown: () => false, onClose: () => {} },
        slashItems: () => [],
      }),
      content: 'Body',
    })
    const host = renderComponent(
      <LocaleProvider initial="zh">
        <Ribbon
          editor={editor}
          mode="source"
          onModeChange={() => {}}
          disabled={false}
          dirty
          onSave={() => {}}
          onFind={() => {}}
          autoSave={false}
          onToggleAutoSave={() => {}}
          imageEnabled
          onInsertImage={() => {}}
          frontmatterOpen={false}
          onToggleFrontmatter={() => {}}
          outlineOpen={false}
          onToggleOutline={() => {}}
          hasOutline
          aiOpen={false}
          onToggleAi={() => {}}
          onAiPreset={() => {}}
        />
      </LocaleProvider>,
    )

    const buttonByLabel = (label: string) => host.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement
    expect(buttonByLabel('属性').disabled).toBe(true)
    expect(buttonByLabel('大纲').disabled).toBe(true)
    editor.destroy()
  })
})
