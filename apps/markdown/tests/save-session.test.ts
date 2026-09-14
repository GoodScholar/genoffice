import { afterAll, describe, expect, it } from 'vitest'
import { Editor, type JSONContent } from '@tiptap/core'
import { buildExtensions } from '../src/renderer/editor/extensions'
import { createMarkdownDocumentSession } from '../src/renderer/markdown/documentSession'
import { createTiptapMarkdownCodec, type VisualProjection } from '../src/renderer/markdown/sourceProjection'
import { losslessMarkdownEnabled } from '../src/renderer/markdown/featureFlag'

const editors: Editor[] = []
afterAll(() => editors.forEach((editor) => editor.destroy()))

function createSession(source: string) {
  const editor = new Editor({
    extensions: buildExtensions({
      slashController: { onOpen: () => {}, onUpdate: () => {}, onKeyDown: () => false, onClose: () => {} },
      slashItems: () => [],
    }),
    content: '',
  })
  editors.push(editor)
  return createMarkdownDocumentSession(source, createTiptapMarkdownCodec(editor))
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
  it('enables the lossless path only for the development query flag', () => {
    expect(losslessMarkdownEnabled('?losslessMarkdown=1', true)).toBe(true)
    expect(losslessMarkdownEnabled('?losslessMarkdown=1', false)).toBe(false)
    expect(losslessMarkdownEnabled('?losslessMarkdown=0', true)).toBe(false)
  })

  it('clears dirty after an unchanged save uses the text actually written', () => {
    const session = createSession('First.\n')
    const ticket = session.beginSave()

    expect(session.markSaved(ticket.source, ticket)).toMatchObject({ dirty: false, source: 'First.\n' })
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
})
