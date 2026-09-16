import { afterAll, describe, expect, it, vi } from 'vitest'
import { Editor, type JSONContent } from '@tiptap/core'
import { buildExtensions } from '../src/renderer/editor/extensions'
import { createMarkdownDocumentSession } from '../src/renderer/markdown/documentSession'
import {
  createTiptapMarkdownCodec,
  type VisualProjection,
} from '../src/renderer/markdown/sourceProjection'
import { losslessMarkdownEnabled } from '../src/renderer/markdown/featureFlag'
import {
  applyProjectionProvenance,
  requestSourceBackedSave,
  synchronizeSourceBackedSave,
} from '../src/renderer/App'

const editors: Editor[] = []
afterAll(() => editors.forEach((editor) => editor.destroy()))

function createSession(source: string) {
  const editor = new Editor({
    extensions: buildExtensions({
      slashController: {
        onOpen: () => {},
        onUpdate: () => {},
        onKeyDown: () => false,
        onClose: () => {},
      },
      slashItems: () => [],
    }),
    content: '',
  })
  editors.push(editor)
  return createMarkdownDocumentSession(source, createTiptapMarkdownCodec(editor))
}

function createHarness(source: string) {
  const editor = new Editor({
    extensions: buildExtensions({
      slashController: {
        onOpen: () => {},
        onUpdate: () => {},
        onKeyDown: () => false,
        onClose: () => {},
      },
      slashItems: () => [],
    }),
    content: '',
  })
  editors.push(editor)
  const session = createMarkdownDocumentSession(source, createTiptapMarkdownCodec(editor))
  editor.chain().setMeta('addToHistory', false).setContent(session.view().visual.doc).run()
  return { editor, session }
}

function replaceEditorText(editor: Editor, from: string, to: string): void {
  let range: { from: number; to: number } | undefined
  editor.state.doc.descendants((node, pos) => {
    if (range || !node.isText || node.text !== from) return
    range = { from: pos, to: pos + from.length }
  })
  if (!range) throw new Error(`Missing ${from}`)
  editor.view.dispatch(editor.state.tr.insertText(to, range.from, range.to))
}

function replaceText(visual: VisualProjection, from: string, to: string): VisualProjection {
  const visit = (node: JSONContent): JSONContent => {
    if (node.type === 'text' && typeof node.text === 'string') {
      return { ...node, text: node.text.replace(from, to) }
    }
    return node.content ? { ...node, content: node.content.map(visit) } : node
  }
  return JSON.parse(JSON.stringify({ ...visual, doc: visit(visual.doc) })) as VisualProjection
}

describe('source-backed save sessions', () => {
  it('enables the lossless path by default', () => {
    expect(losslessMarkdownEnabled()).toBe(true)
  })

  it('clears dirty after an unchanged save uses the text actually written', () => {
    const session = createSession('First.\n')
    const ticket = session.beginSave()

    expect(session.markSaved(ticket.source, ticket)).toMatchObject({
      dirty: false,
      source: 'First.\n',
    })
  })

  it('keeps dirty when a visual edit lands while save is in flight', () => {
    const session = createSession('First.\n\nSecond.')
    const ticket = session.beginSave()
    const visual = replaceText(session.view().visual, 'Second.', 'Newer.')
    expect(JSON.stringify(visual)).toContain('Newer.')
    expect(session.applyVisual(visual).ok).toBe(true)
    expect(session.serialize()).toBe('First.\n\nNewer.')

    expect(session.markSaved(ticket.source, ticket)).toMatchObject({
      dirty: true,
      source: 'First.\n\nNewer.',
    })
  })

  it('rebases Save As image rewrites without replacing newer source text', () => {
    const session = createSession('![image](old.png)\n\nSecond.')
    const ticket = session.beginSave()
    const visual = replaceText(session.view().visual, 'Second.', 'Newer.')
    expect(JSON.stringify(visual)).toContain('Newer.')
    expect(session.applyVisual(visual).ok).toBe(true)
    expect(session.serialize()).toContain('Newer.')

    expect(session.markSaved('![image](assets/image.png)\n\nSecond.', ticket)).toMatchObject({
      dirty: true,
      source: '![image](assets/image.png)\n\nNewer.',
    })
  })

  it('keeps an existing undo step after synchronizing save projection provenance', () => {
    const { editor, session } = createHarness('First.\n\nSecond.')
    replaceEditorText(editor, 'Second.', 'Changed.')
    const update = session.applyVisual({ doc: editor.getJSON(), frontmatterInner: '' })
    expect(update.ok).toBe(true)

    applyProjectionProvenance(editor, session.view().visual.doc)
    expect(editor.commands.undo()).toBe(true)
    expect(editor.state.doc.textContent).toContain('Second.')
  })

  it('keeps consecutive visual edits source-backed after provenance changes around protected HTML', () => {
    const { editor, session } = createHarness('Before <u>protected</u> after.\n\nSecond.')
    editor.commands.insertContentAt(0, {
      type: 'paragraph',
      content: [{ type: 'text', text: 'Inserted.' }],
    })
    const first = session.applyVisual({ doc: editor.getJSON(), frontmatterInner: '' })
    expect(first.ok).toBe(true)
    applyProjectionProvenance(editor, session.view().visual.doc)

    replaceEditorText(editor, 'Second.', 'Changed.')
    const second = session.applyVisual({ doc: editor.getJSON(), frontmatterInner: '' })
    expect(second).toMatchObject({ ok: true, view: { mode: 'visual' } })
    expect(session.serialize()).toContain('Changed.')
  })

  it('enters source fallback and does not invoke IPC when save consistency validation fails', async () => {
    const session = createSession('First.')
    const save = vi.fn(async () => ({ ok: true as const, path: '/tmp/note.md', text: 'First.' }))
    const onFailure = vi.fn()
    session.beginSave = () => {
      throw new Error('inconsistent source')
    }

    await expect(
      requestSourceBackedSave(session, createHarness('First.').editor, 'save', save, onFailure),
    ).rejects.toThrow('inconsistent source')
    expect(save).not.toHaveBeenCalled()
    expect(onFailure).toHaveBeenCalledOnce()
    expect(session.view().mode).toBe('source')
  })

  it('reports an IPC rejection once without leaving visual mode', async () => {
    const { editor, session } = createHarness('First.')
    const save = vi.fn(async () => {
      throw new Error('disk unavailable')
    })
    const onFailure = vi.fn()

    await expect(requestSourceBackedSave(session, editor, 'save', save, onFailure)).rejects.toThrow(
      'disk unavailable',
    )
    expect(save).toHaveBeenCalledOnce()
    expect(onFailure).toHaveBeenCalledOnce()
    expect(session.view().mode).toBe('visual')
  })

  it('keeps live image attrs synchronized with a concurrent Save As alt edit', () => {
    const { editor, session } = createHarness('![image](old.png)')
    const ticket = session.beginSave()
    const visual = JSON.parse(JSON.stringify(session.view().visual)) as VisualProjection
    visual.doc.content![0]!.attrs = { ...visual.doc.content![0]!.attrs, alt: 'edited alt' }
    const update = session.applyVisual(visual)
    expect(update).toEqual(expect.objectContaining({ ok: true }))
    editor.chain().setMeta('addToHistory', false).setContent(session.view().visual.doc).run()

    const saved = synchronizeSourceBackedSave(session, editor, ticket, {
      ok: true,
      path: '/tmp/copy.md',
      text: '![image](assets/image.png)',
      imageRewrites: [{ from: 'old.png', to: 'assets/image.png' }],
    })
    expect(saved).toMatchObject({ dirty: true, source: '![edited alt](assets/image.png)' })
    expect(editor.state.doc.firstChild?.attrs).toMatchObject({
      alt: 'edited alt',
      src: 'assets/image.png',
    })
  })
})
