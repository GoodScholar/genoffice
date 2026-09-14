import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import { replaceSourceModeVisualDocument } from '../src/renderer/App'
import { SourceEditor } from '../src/renderer/components/SourceEditor'
import { buildExtensions } from '../src/renderer/editor/extensions'
import { createMarkdownDocumentSession } from '../src/renderer/markdown/documentSession'
import { createTiptapMarkdownCodec, type MarkdownCodec } from '../src/renderer/markdown/sourceProjection'

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
    replaceSourceModeVisualDocument(editor, session.view().visual.doc)

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
