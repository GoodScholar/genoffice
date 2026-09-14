import { afterAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Editor, type JSONContent } from '@tiptap/core'
import { buildExtensions } from '../src/renderer/editor/extensions'
import { replaceEditorBaseline } from '../src/renderer/App'
import { createMarkdownDocumentSession } from '../src/renderer/markdown/documentSession'
import { createTiptapMarkdownCodec, type MarkdownCodec, type VisualProjection } from '../src/renderer/markdown/sourceProjection'
import {
  GENERATED_TRAILING_NODE_SOURCE_ID,
  USER_TRAILING_EMPTY_PARAGRAPH_SOURCE_ID,
} from '../src/renderer/markdown/generatedTrailingNode'

const editors: Editor[] = []
afterAll(() => editors.forEach((editor) => editor.destroy()))

function createCodec(): MarkdownCodec {
  const editor = new Editor({
    extensions: buildExtensions({
      slashController: { onOpen: () => {}, onUpdate: () => {}, onKeyDown: () => false, onClose: () => {} },
      slashItems: () => [],
    }),
    content: '',
  })
  editors.push(editor)
  return createTiptapMarkdownCodec(editor)
}

function fixture(name: string): string {
  return readFileSync(join(__dirname, 'fixtures/lossless', name), 'utf8')
}

function withCrLf(source: string): string {
  return source.replace(/\n/g, '\r\n')
}

function withoutFinalNewline(source: string): string {
  return source.replace(/\r?\n$/, '')
}

function cloneVisual(visual: VisualProjection): VisualProjection {
  return JSON.parse(JSON.stringify(visual)) as VisualProjection
}

function nodesForSourceId(visual: VisualProjection, sourceId: string): JSONContent[] {
  return (visual.doc.content ?? []).filter((node) => node.attrs?.sourceId === sourceId)
}

function replaceText(node: JSONContent, from: string, to: string): JSONContent {
  if (node.type === 'text' && typeof node.text === 'string') return { ...node, text: node.text.replace(from, to) }
  return node.content ? { ...node, content: node.content.map((child) => replaceText(child, from, to)) } : node
}

function visualWithText(visual: VisualProjection, from: string, to: string): VisualProjection {
  const next = cloneVisual(visual)
  next.doc.content = (next.doc.content ?? []).map((node) => replaceText(node, from, to))
  return next
}

function visualWithImageAlt(visual: VisualProjection, alt: string): VisualProjection {
  const visit = (node: JSONContent): JSONContent => {
    if (node.type === 'image') return { ...node, attrs: { ...node.attrs, alt } }
    return node.content ? { ...node, content: node.content.map(visit) } : node
  }
  return { ...visual, doc: visit(visual.doc) }
}

function withoutProtected(node: JSONContent): JSONContent | null {
  if (node.type === 'protectedSourceInline' || node.type === 'protectedSourceBlock') return null
  return node.content
    ? { ...node, content: node.content.map(withoutProtected).filter((child): child is JSONContent => child !== null) }
    : node
}

describe('MarkdownDocumentSession', () => {
  it.each([
    'core-gfm.md',
    'typora-html.md',
    'legacy-and-malformed.md',
  ])('round-trips %s and its envelope variants exactly', (name) => {
    const source = fixture(name)
    const variants = [source, withCrLf(source), `\uFEFF${source}`, withoutFinalNewline(source)]

    for (const input of variants) {
      const session = createMarkdownDocumentSession(input, createCodec())
      expect(session.serialize()).toBe(input)
      expect(session.view()).toMatchObject({ source: input, dirty: false })
    }
  })

  it('opens the core GFM fixture in visual mode', () => {
    const session = createMarkdownDocumentSession(fixture('core-gfm.md'), createCodec())

    expect(session.view().mode).toBe('visual')
    expect(session.view().fallbackReason).toBeUndefined()
  })

  it('reuses untouched raw frontmatter without changing revision', () => {
    const source = '---\r\ntitle: exact\r\n---\r\n\r\nBody.\r\n'
    const session = createMarkdownDocumentSession(source, createCodec())
    const view = session.view()

    expect(session.applyVisual(view.visual)).toMatchObject({ ok: true })
    expect(session.view()).toMatchObject({ revision: 0, dirty: false })
    expect(session.serialize()).toBe(source)
  })

  it.each([
    ['LF', '\n'],
    ['CRLF', '\r\n'],
  ])('rewrites edited frontmatter with %s EOL while preserving the body', (_name, eol) => {
    const source = `---${eol}title: before${eol}---${eol}${eol}Before <u>protected</u> after.${eol}`
    const session = createMarkdownDocumentSession(source, createCodec())
    const original = session.view()

    expect(session.applyVisual({ ...original.visual, frontmatterInner: 'title: after' })).toMatchObject({ ok: true })
    expect(session.view()).toMatchObject({ revision: 1, dirty: true })
    expect(session.serialize()).toBe(`---${eol}title: after${eol}---${eol}${eol}Before <u>protected</u> after.${eol}`)
    expect(session.view().protectedFragments.map(({ raw, reason, display }) => ({ raw, reason, display }))).toEqual(
      original.protectedFragments.map(({ raw, reason, display }) => ({ raw, reason, display })),
    )
  })

  it('removes explicitly cleared frontmatter while preserving the body raw', () => {
    const source = '---\ntitle: before\n---\n\nBefore <u>protected</u> after.\n'
    const session = createMarkdownDocumentSession(source, createCodec())

    expect(session.applyVisual({ ...session.view().visual, frontmatterInner: '' })).toMatchObject({ ok: true })
    expect(session.serialize()).toBe('Before <u>protected</u> after.\n')
    expect(session.view()).toMatchObject({ revision: 1, dirty: true })
  })

  it('rewrites only the edited group while keeping surrounding raw source and document boundaries', () => {
    const source = withCrLf('| A | B |\n| :--- | ---: |\n| one | two |\n\n\nFirst paragraph.\n\n<div data-x="raw">keep</div>\n\nSecond paragraph.')
    const session = createMarkdownDocumentSession(source, createCodec())
    const update = session.applyVisual(visualWithText(session.view().visual, 'Second paragraph.', 'Changed paragraph.'))

    expect(update.ok).toBe(true)
    expect(session.serialize()).toBe(withCrLf('| A | B |\n| :--- | ---: |\n| one | two |\n\n\nFirst paragraph.\n\n<div data-x="raw">keep</div>\n\nChanged paragraph.'))
  })

  it('moves an unchanged unit with its original trailing separator and removes a deleted unit separator', () => {
    const source = 'First.\n\n\nSecond.\n\nThird.\n'
    const session = createMarkdownDocumentSession(source, createCodec())
    const original = session.view().visual
    const next = cloneVisual(original)
    next.doc.content = [
      ...nodesForSourceId(original, 's0-b1'),
      ...nodesForSourceId(original, 's0-b0'),
      ...nodesForSourceId(original, 's0-b2'),
    ]

    expect(session.applyVisual(next).ok).toBe(true)
    expect(session.serialize()).toBe('Second.\n\nFirst.\n\n\nThird.\n')

    const deleted = cloneVisual(session.view().visual)
    deleted.doc.content = (deleted.doc.content ?? []).filter((node) => node.attrs?.sourceId !== 's0-b1')
    expect(session.applyVisual(deleted).ok).toBe(true)
    expect(session.serialize()).toBe('Second.\n\nThird.\n')
  })

  it('uses the document EOL only at a new top-level insertion boundary', () => {
    const source = 'First.'
    const session = createMarkdownDocumentSession(source, createCodec())
    const next = cloneVisual(session.view().visual)
    next.doc.content = [
      ...(next.doc.content ?? []),
      { type: 'paragraph', content: [{ type: 'text', text: 'New paragraph.' }] },
    ]

    expect(session.applyVisual(next).ok).toBe(true)
    expect(session.serialize()).toBe('First.\n\nNew paragraph.')
  })

  it('creates only the required canonical boundary when an EOF unit moves before another unit', () => {
    const session = createMarkdownDocumentSession('First.\n\nLast.', createCodec())
    const original = session.view().visual
    const next = cloneVisual(original)
    next.doc.content = [
      ...nodesForSourceId(original, 's0-b1'),
      ...nodesForSourceId(original, 's0-b0'),
    ]

    expect(session.applyVisual(next).ok).toBe(true)
    expect(session.serialize()).toBe('Last.\n\nFirst.')
    expect(session.view().visual.doc.content?.map((node) => node.content?.[0]?.text)).toEqual(['Last.', 'First.'])
  })

  it('rewrites a real TipTap edit before a protected details block without changing protected source', () => {
    const source = 'Old\n\n<details>P</details>\n\nTail\n'
    const editor = new Editor({
      extensions: buildExtensions({
        slashController: { onOpen: () => {}, onUpdate: () => {}, onKeyDown: () => false, onClose: () => {} },
        slashItems: () => [],
      }),
      content: '',
    })
    editors.push(editor)
    const session = createMarkdownDocumentSession(source, createTiptapMarkdownCodec(editor))
    editor.commands.setContent(session.view().visual.doc)
    editor.commands.setContent(visualWithText(session.view().visual, 'Old', 'NEW').doc)

    const update = session.applyVisual({ doc: editor.getJSON(), frontmatterInner: session.view().visual.frontmatterInner })
    expect(update).toMatchObject({ ok: true })
    expect(session.serialize()).toBe('NEW\n\n<details>P</details>\n\nTail\n')
  })

  it.each([
    ['LF', 'Old\n\n', 'Old\n\nNew paragraph\n'],
    ['CRLF', 'Old\r\n\r\n', 'Old\r\n\r\nNew paragraph\r\n'],
    ['protected before', '<details>P</details>\n\nOld\n\n', '<details>P</details>\n\nOld\n\nNew paragraph\n'],
  ])('writes a real TipTap-inserted paragraph with %s boundaries', (_name, source, expected) => {
    const editor = new Editor({
      extensions: buildExtensions({
        slashController: { onOpen: () => {}, onUpdate: () => {}, onKeyDown: () => false, onClose: () => {} },
        slashItems: () => [],
      }),
      content: '',
    })
    editors.push(editor)
    const session = createMarkdownDocumentSession(source, createTiptapMarkdownCodec(editor))
    editor.commands.setContent(session.view().visual.doc)
    editor.commands.insertContentAt(editor.state.doc.content.size, {
      type: 'paragraph',
      content: [{ type: 'text', text: 'New paragraph' }],
    })

    expect(editor.getJSON().content?.at(-1)?.attrs?.sourceId).toBeNull()
    expect(session.applyVisual({ doc: editor.getJSON(), frontmatterInner: '' })).toMatchObject({ ok: true })
    expect(session.serialize()).toBe(expected)
  })

  it.each([
    ['heading', { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Added heading' }] }, '## Added heading'],
    ['bullet list', { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Added item' }] }] }] }, '- Added item'],
  ])('writes a real TipTap-inserted %s with null provenance', (_name, node, expected) => {
    const editor = new Editor({
      extensions: buildExtensions({
        slashController: { onOpen: () => {}, onUpdate: () => {}, onKeyDown: () => false, onClose: () => {} },
        slashItems: () => [],
      }),
      content: '',
    })
    editors.push(editor)
    const session = createMarkdownDocumentSession('Old\n\n', createTiptapMarkdownCodec(editor))
    editor.commands.setContent(session.view().visual.doc)
    editor.commands.insertContentAt(editor.state.doc.content.size, node)

    expect(editor.getJSON().content?.at(-2)?.attrs?.sourceId).toBeNull()
    expect(editor.getJSON().content?.at(-1)?.attrs?.sourceId).toBe(GENERATED_TRAILING_NODE_SOURCE_ID)
    expect(session.applyVisual({ doc: editor.getJSON(), frontmatterInner: '' })).toMatchObject({ ok: true })
    expect(session.serialize()).toContain(expected)
  })

  it('writes a new paragraph before a protected trailing block without rewriting its raw source', () => {
    const source = 'Old\n\n<details>P</details>\n'
    const editor = new Editor({
      extensions: buildExtensions({
        slashController: { onOpen: () => {}, onUpdate: () => {}, onKeyDown: () => false, onClose: () => {} },
        slashItems: () => [],
      }),
      content: '',
    })
    editors.push(editor)
    const session = createMarkdownDocumentSession(source, createTiptapMarkdownCodec(editor))
    editor.commands.setContent(session.view().visual.doc)
    editor.commands.insertContentAt(editor.state.doc.firstChild!.nodeSize, {
      type: 'paragraph',
      content: [{ type: 'text', text: 'New paragraph' }],
    })

    expect(session.applyVisual({ doc: editor.getJSON(), frontmatterInner: '' })).toMatchObject({ ok: true })
    expect(session.serialize()).toBe('Old\n\nNew paragraph\n\n<details>P</details>\n')
  })

  it('retains a user-inserted empty paragraph as an explicit, editable source separator', () => {
    const editor = new Editor({
      extensions: buildExtensions({
        slashController: { onOpen: () => {}, onUpdate: () => {}, onKeyDown: () => false, onClose: () => {} },
        slashItems: () => [],
      }),
      content: '',
    })
    editors.push(editor)
    const session = createMarkdownDocumentSession('Old\n\n', createTiptapMarkdownCodec(editor))
    editor.commands.setContent(session.view().visual.doc)
    editor.commands.insertContentAt(editor.state.doc.content.size, { type: 'paragraph' })

    expect(editor.getJSON().content?.at(-1)?.attrs?.sourceId).toBe(USER_TRAILING_EMPTY_PARAGRAPH_SOURCE_ID)
    expect(session.applyVisual({ doc: editor.getJSON(), frontmatterInner: '' })).toMatchObject({ ok: true })
    expect(session.serialize()).toBe('Old\n\n\n\n')
    expect(session.view().visual.doc.content?.at(-1)?.attrs?.sourceId).toBe(USER_TRAILING_EMPTY_PARAGRAPH_SOURCE_ID)

    editor.commands.insertContentAt(editor.state.doc.content.size - 1, 'User text')
    expect(session.applyVisual({ doc: editor.getJSON(), frontmatterInner: '' })).toMatchObject({ ok: true })
    expect(session.serialize()).toContain('User text')
  })

  it.each([
    ['LF', 'Old\n\n', 'Old\n\n\n\n'],
    ['CRLF', 'Old\r\n\r\n', 'Old\r\n\r\n\r\n\r\n'],
    ['no final newline', 'Old', 'Old\n\n\n\n'],
  ])('keeps a real user empty-tail source transition idempotent through undo and redo with %s', (_name, source, expected) => {
    const editor = new Editor({
      extensions: buildExtensions({
        slashController: { onOpen: () => {}, onUpdate: () => {}, onKeyDown: () => false, onClose: () => {} },
        slashItems: () => [],
      }),
      content: '',
    })
    editors.push(editor)
    const session = createMarkdownDocumentSession(source, createTiptapMarkdownCodec(editor))
    editor.chain().setMeta('addToHistory', false).setContent(session.view().visual.doc).run()
    editor.commands.insertContentAt(editor.state.doc.content.size, { type: 'paragraph' })
    const visual = { doc: editor.getJSON(), frontmatterInner: '' }

    expect(session.applyVisual(visual)).toMatchObject({ ok: true })
    expect(session.view()).toMatchObject({ source: expected, revision: 1 })
    expect(session.applyVisual(visual)).toMatchObject({ ok: true })
    expect(session.view()).toMatchObject({ source: expected, revision: 1 })
    session.enterSource()
    expect(session.applyVisual(visual)).toMatchObject({ ok: true })
    expect(session.view()).toMatchObject({ source: expected, revision: 1 })
    const ticket = session.beginSave()
    session.markSaved(expected, ticket)
    expect(session.applyVisual(visual)).toMatchObject({ ok: true })
    expect(session.view()).toMatchObject({ source: expected, revision: 1, dirty: false })

    editor.commands.undo()
    expect(session.applyVisual({ doc: editor.getJSON(), frontmatterInner: '' })).toMatchObject({ ok: true })
    expect(session.view()).toMatchObject({ source, revision: 2, dirty: true })
    editor.commands.redo()
    expect(session.applyVisual({ doc: editor.getJSON(), frontmatterInner: '' })).toMatchObject({ ok: true })
    expect(session.view()).toMatchObject({ source: expected, revision: 3, dirty: false })
  })

  it.each([
    ['LF', 'Old\n\n', 'Old X\n\n\n\n', 'Old\n\n\n\n'],
    ['CRLF', 'Old\r\n\r\n', 'Old X\r\n\r\n\r\n\r\n', 'Old\r\n\r\n\r\n\r\n'],
    ['no final newline', 'Old', 'Old X\n\n\n\n', 'Old\n\n\n\n'],
  ])('keeps one empty-tail separator while editing the preceding block with %s', (_name, source, expected, afterUndo) => {
    const editor = new Editor({
      extensions: buildExtensions({
        slashController: { onOpen: () => {}, onUpdate: () => {}, onKeyDown: () => false, onClose: () => {} },
        slashItems: () => [],
      }),
      content: '',
    })
    editors.push(editor)
    const session = createMarkdownDocumentSession(source, createTiptapMarkdownCodec(editor))
    editor.chain().setMeta('addToHistory', false).setContent(session.view().visual.doc).run()
    editor.commands.insertContentAt(editor.state.doc.content.size, { type: 'paragraph' })
    expect(session.applyVisual({ doc: editor.getJSON(), frontmatterInner: '' })).toMatchObject({ ok: true })
    editor.view.dispatch(editor.state.tr.insertText(' X', 4))
    const visual = { doc: editor.getJSON(), frontmatterInner: '' }

    expect(session.applyVisual(visual)).toMatchObject({ ok: true })
    expect(session.view()).toMatchObject({ source: expected, revision: 2 })
    expect(session.applyVisual(visual)).toMatchObject({ ok: true })
    expect(session.view()).toMatchObject({ source: expected, revision: 2 })
    editor.commands.undo()
    expect(session.applyVisual({ doc: editor.getJSON(), frontmatterInner: '' })).toMatchObject({ ok: true })
    expect(session.serialize()).toBe(afterUndo)
    editor.commands.redo()
    expect(session.applyVisual({ doc: editor.getJSON(), frontmatterInner: '' })).toMatchObject({ ok: true })
    expect(session.serialize()).toBe(expected)
  })

  it('keeps the empty-tail relation when an older save ticket returns', () => {
    const editor = new Editor({
      extensions: buildExtensions({
        slashController: { onOpen: () => {}, onUpdate: () => {}, onKeyDown: () => false, onClose: () => {} },
        slashItems: () => [],
      }),
      content: '',
    })
    editors.push(editor)
    const session = createMarkdownDocumentSession('Old\n\n', createTiptapMarkdownCodec(editor))
    const ticket = session.beginSave()
    editor.chain().setMeta('addToHistory', false).setContent(session.view().visual.doc).run()
    editor.commands.insertContentAt(editor.state.doc.content.size, { type: 'paragraph' })
    const visual = { doc: editor.getJSON(), frontmatterInner: '' }
    expect(session.applyVisual(visual)).toMatchObject({ ok: true })
    session.markSaved('Old\n\n', ticket)

    expect(session.applyVisual(visual)).toMatchObject({ ok: true })
    expect(session.view()).toMatchObject({ source: 'Old\n\n\n\n', revision: 1, dirty: true })
  })

  it('absorbs a frontmatter edit into the empty-tail logical base', () => {
    const editor = new Editor({
      extensions: buildExtensions({
        slashController: { onOpen: () => {}, onUpdate: () => {}, onKeyDown: () => false, onClose: () => {} },
        slashItems: () => [],
      }),
      content: '',
    })
    editors.push(editor)
    const session = createMarkdownDocumentSession('---\ntitle: before\n---\n\nOld\n\n', createTiptapMarkdownCodec(editor))
    editor.chain().setMeta('addToHistory', false).setContent(session.view().visual.doc).run()
    editor.commands.insertContentAt(editor.state.doc.content.size, { type: 'paragraph' })
    expect(session.applyVisual({ doc: editor.getJSON(), frontmatterInner: 'title: before' })).toMatchObject({ ok: true })

    const visual = { doc: editor.getJSON(), frontmatterInner: 'title: after' }
    expect(session.applyVisual(visual)).toMatchObject({ ok: true })
    expect(session.view()).toMatchObject({
      source: '---\ntitle: after\n---\n\nOld\n\n\n\n',
      revision: 2,
    })
    expect(session.applyVisual(visual)).toMatchObject({ ok: true })
    expect(session.view()).toMatchObject({ revision: 2 })
  })

  it('rebases an older save result onto a preceding edit with the empty-tail relation intact', () => {
    const editor = new Editor({
      extensions: buildExtensions({
        slashController: { onOpen: () => {}, onUpdate: () => {}, onKeyDown: () => false, onClose: () => {} },
        slashItems: () => [],
      }),
      content: '',
    })
    editors.push(editor)
    const session = createMarkdownDocumentSession('Old\n\n', createTiptapMarkdownCodec(editor))
    const ticket = session.beginSave()
    editor.chain().setMeta('addToHistory', false).setContent(session.view().visual.doc).run()
    editor.commands.insertContentAt(editor.state.doc.content.size, { type: 'paragraph' })
    expect(session.applyVisual({ doc: editor.getJSON(), frontmatterInner: '' })).toMatchObject({ ok: true })
    editor.view.dispatch(editor.state.tr.insertText(' X', 4))
    const visual = { doc: editor.getJSON(), frontmatterInner: '' }
    expect(session.applyVisual(visual)).toMatchObject({ ok: true })
    expect(session.serialize()).toBe('Old X\n\n\n\n')

    expect(session.markSaved('Old\n\n', ticket)).toMatchObject({ source: 'Old X\n\n\n\n', dirty: true })
    expect(session.applyVisual(visual)).toMatchObject({ ok: true })
    expect(session.view()).toMatchObject({ source: 'Old X\n\n\n\n', revision: 2 })
  })

  it('keeps the empty-tail relation when an image save rewrite returns', () => {
    const session = createMarkdownDocumentSession('![image](old.png)\n\n', createCodec())
    const ticket = session.beginSave()
    const visual = cloneVisual(session.view().visual)
    visual.doc.content?.push({ type: 'paragraph', attrs: { sourceId: USER_TRAILING_EMPTY_PARAGRAPH_SOURCE_ID } })
    expect(session.applyVisual(visual)).toMatchObject({ ok: true })

    expect(session.markSaved('![image](assets/image.png)\n\n', ticket, [{ from: 'old.png', to: 'assets/image.png' }])).toMatchObject({
      source: '![image](assets/image.png)\n\n\n\n',
      dirty: true,
    })
    expect(session.applyVisual(session.view().visual)).toMatchObject({ ok: true })
    expect(session.view()).toMatchObject({ source: '![image](assets/image.png)\n\n\n\n', revision: 1 })
  })

  it.each([
    ['LF without a final newline', 'Old'],
    ['LF with one final newline', 'Old\n'],
    ['LF with two final newlines', 'Old\n\n'],
    ['LF with multiple final newlines', 'Old\n\n\n\n'],
    ['CRLF without a final newline', 'Old'],
    ['CRLF with one final newline', 'Old\r\n'],
    ['CRLF with two final newlines', 'Old\r\n\r\n'],
    ['CRLF with multiple final newlines', 'Old\r\n\r\n\r\n\r\n'],
    ['frontmatter body without a final newline', '---\ntitle: keep\n---\n\nOld'],
  ])('restores the exact original tail boundary after a stale save for %s', (_name, source) => {
    const editor = new Editor({
      extensions: buildExtensions({
        slashController: { onOpen: () => {}, onUpdate: () => {}, onKeyDown: () => false, onClose: () => {} },
        slashItems: () => [],
      }),
      content: '',
    })
    editors.push(editor)
    const session = createMarkdownDocumentSession(source, createTiptapMarkdownCodec(editor))
    const ticket = session.beginSave()
    const frontmatterInner = session.view().visual.frontmatterInner
    editor.chain().setMeta('addToHistory', false).setContent(session.view().visual.doc).run()
    editor.commands.insertContentAt(editor.state.doc.content.size, { type: 'paragraph' })
    const visual = { doc: editor.getJSON(), frontmatterInner }
    expect(session.applyVisual(visual)).toMatchObject({ ok: true, view: { revision: 1 } })
    const withMarker = session.serialize()
    expect(session.applyVisual(visual)).toMatchObject({ ok: true, view: { revision: 1, source: withMarker } })

    session.markSaved(ticket.source, ticket)
    expect(session.applyVisual(visual)).toMatchObject({ ok: true, view: { revision: 1, source: withMarker } })
    const tail = editor.state.doc.lastChild!
    editor.commands.deleteRange({ from: editor.state.doc.content.size - tail.nodeSize, to: editor.state.doc.content.size })
    expect(session.applyVisual({ doc: editor.getJSON(), frontmatterInner })).toMatchObject({ ok: true })
    expect(session.serialize()).toBe(source)
  })

  it.each([
    ['empty', ''],
    ['LF blank-only', '\n\n'],
    ['CRLF blank-only', '\r\n\r\n'],
    ['LF frontmatter-only', '---\ntitle: only\n---\n'],
    ['CRLF frontmatter-only', '---\r\ntitle: only\r\n---\r\n'],
  ])('distinguishes an App baseline from a later empty-tail insertion for %s', (_name, source) => {
    const editor = new Editor({
      extensions: buildExtensions({
        slashController: { onOpen: () => {}, onUpdate: () => {}, onKeyDown: () => false, onClose: () => {} },
        slashItems: () => [],
      }),
      content: '',
    })
    editors.push(editor)
    const session = createMarkdownDocumentSession(source, createTiptapMarkdownCodec(editor))
    const frontmatterInner = session.view().visual.frontmatterInner
    replaceEditorBaseline(editor, session.view().visual.doc)
    const ticket = session.beginSave()
    editor.commands.insertContentAt(editor.state.doc.content.size, { type: 'paragraph' })
    const visual = { doc: editor.getJSON(), frontmatterInner }

    const inserted = session.applyVisual(visual)
    expect(inserted).toMatchObject({ ok: true, view: { revision: 1 } })
    const withMarker = session.serialize()
    expect(session.applyVisual(visual)).toMatchObject({ ok: true, view: { revision: 1, source: withMarker } })
    session.markSaved(withMarker, ticket)
    editor.commands.undo()
    const undone = session.applyVisual({ doc: editor.getJSON(), frontmatterInner })
    expect(undone).toMatchObject({ ok: true, view: { source } })
    editor.commands.redo()
    expect(session.applyVisual(visual)).toMatchObject({ ok: true, view: { source: withMarker } })
  })

  it('writes text into a stale user-tail marker from its logical base', () => {
    const editor = new Editor({
      extensions: buildExtensions({
        slashController: { onOpen: () => {}, onUpdate: () => {}, onKeyDown: () => false, onClose: () => {} },
        slashItems: () => [],
      }),
      content: '',
    })
    editors.push(editor)
    const session = createMarkdownDocumentSession('Old', createTiptapMarkdownCodec(editor))
    const ticket = session.beginSave()
    editor.chain().setMeta('addToHistory', false).setContent(session.view().visual.doc).run()
    editor.commands.insertContentAt(editor.state.doc.content.size, { type: 'paragraph' })
    expect(session.applyVisual({ doc: editor.getJSON(), frontmatterInner: '' })).toMatchObject({ ok: true })
    session.markSaved('Old', ticket)

    const tail = editor.state.doc.lastChild!
    const from = editor.state.doc.content.size - tail.nodeSize + 1
    editor.view.dispatch(editor.state.tr.insertText('Tail', from))
    expect(session.applyVisual({ doc: editor.getJSON(), frontmatterInner: '' })).toMatchObject({ ok: true })
    expect(session.serialize()).toBe('Old\n\nTail')
  })

  it('preserves a saved user-empty separator on reload without claiming its transient visual node', () => {
    const editor = new Editor({
      extensions: buildExtensions({
        slashController: { onOpen: () => {}, onUpdate: () => {}, onKeyDown: () => false, onClose: () => {} },
        slashItems: () => [],
      }),
      content: '',
    })
    editors.push(editor)
    const session = createMarkdownDocumentSession('Old\n\n', createTiptapMarkdownCodec(editor))
    editor.commands.setContent(session.view().visual.doc)
    editor.commands.insertContentAt(editor.state.doc.content.size, { type: 'paragraph' })
    expect(session.applyVisual({ doc: editor.getJSON(), frontmatterInner: '' })).toMatchObject({ ok: true })

    const reloaded = createMarkdownDocumentSession(session.serialize(), createCodec())
    expect(reloaded.serialize()).toBe('Old\n\n\n\n')
    expect(reloaded.view()).toMatchObject({ dirty: false, revision: 0 })
    expect(reloaded.view().visual.doc.content).toHaveLength(1)
  })

  it('does not tag the empty baseline document as a user edit', () => {
    const editor = new Editor({
      extensions: buildExtensions({
        slashController: { onOpen: () => {}, onUpdate: () => {}, onKeyDown: () => false, onClose: () => {} },
        slashItems: () => [],
      }),
      content: '',
    })
    editors.push(editor)
    const session = createMarkdownDocumentSession('', createTiptapMarkdownCodec(editor))

    editor.view.dispatch(editor.state.tr.setMeta('uiOnly', true))
    expect(editor.getJSON().content?.at(-1)?.attrs?.sourceId).toBeNull()
    expect(session.view()).toMatchObject({ dirty: false, revision: 0, source: '' })
  })

  it('does not tag a programmatic empty setContent replacement as a user edit', () => {
    const editor = new Editor({
      extensions: buildExtensions({
        slashController: { onOpen: () => {}, onUpdate: () => {}, onKeyDown: () => false, onClose: () => {} },
        slashItems: () => [],
      }),
      content: '',
    })
    editors.push(editor)

    editor.commands.setContent({ type: 'doc', content: [{ type: 'paragraph' }] })

    expect(editor.getJSON().content?.at(-1)?.attrs?.sourceId).toBeNull()
  })

  it('checks protected raw before accepting an otherwise unchanged visual projection', () => {
    const session = createMarkdownDocumentSession('<details>P</details>\n', createCodec())
    const next = cloneVisual(session.view().visual)
    const protectedNode = next.doc.content?.[0]!
    protectedNode.attrs = { ...protectedNode.attrs, raw: '<details>changed</details>\n' }

    expect(session.applyVisual(next)).toMatchObject({ ok: false })
    expect(session.serialize()).toBe('<details>P</details>\n')
  })

  it('ignores only the unchanged paragraph explicitly appended by the trailing-node plugin', () => {
    const editor = new Editor({
      extensions: buildExtensions({
        slashController: { onOpen: () => {}, onUpdate: () => {}, onKeyDown: () => false, onClose: () => {} },
        slashItems: () => [],
      }),
      content: '',
    })
    editors.push(editor)
    const session = createMarkdownDocumentSession('---\n', createTiptapMarkdownCodec(editor))
    editor.commands.setContent(session.view().visual.doc)

    const generated = editor.getJSON().content?.at(-1)
    expect(generated).toMatchObject({ type: 'paragraph', attrs: { sourceId: GENERATED_TRAILING_NODE_SOURCE_ID } })
    expect(session.applyVisual({ doc: editor.getJSON(), frontmatterInner: '' })).toMatchObject({ ok: true })
    expect(session.view()).toMatchObject({ dirty: false, revision: 0 })

    editor.commands.insertContentAt(editor.state.doc.content.size - 1, 'User text')
    expect(session.applyVisual({ doc: editor.getJSON(), frontmatterInner: '' })).toMatchObject({ ok: true })
    expect(session.serialize()).toContain('User text')
  })

  it('keeps trailing-node state across a UI-only transaction before another protected-tail edit', () => {
    const editor = new Editor({
      extensions: buildExtensions({
        slashController: { onOpen: () => {}, onUpdate: () => {}, onKeyDown: () => false, onClose: () => {} },
        slashItems: () => [],
      }),
      content: '',
    })
    editors.push(editor)
    const session = createMarkdownDocumentSession('<details>P</details>\n', createTiptapMarkdownCodec(editor))
    editor.commands.setContent(session.view().visual.doc)
    editor.view.dispatch(editor.state.tr.setMeta('uiOnly', true))
    const trailing = editor.state.doc.lastChild!
    const from = editor.state.doc.content.size - trailing.nodeSize
    editor.commands.insertContentAt({ from, to: editor.state.doc.content.size }, { type: 'horizontalRule' })

    expect(editor.getJSON().content?.at(-1)?.attrs?.sourceId).toBe(GENERATED_TRAILING_NODE_SOURCE_ID)
  })

  it('folds a generated trailing paragraph into the originating editor update', () => {
    const editor = new Editor({
      extensions: buildExtensions({
        slashController: { onOpen: () => {}, onUpdate: () => {}, onKeyDown: () => false, onClose: () => {} },
        slashItems: () => [],
      }),
      content: '',
    })
    editors.push(editor)
    let updates = 0
    editor.on('update', () => { updates += 1 })

    editor.commands.setContent({ type: 'doc', content: [{ type: 'horizontalRule' }] })

    expect(updates).toBe(1)
    expect(editor.getJSON().content?.at(-1)?.attrs?.sourceId).toBe(GENERATED_TRAILING_NODE_SOURCE_ID)
  })

  it('rejects visual edits that remove a protected fragment without changing session state', () => {
    const source = 'Before <u>protected</u> after.\n'
    const session = createMarkdownDocumentSession(source, createCodec())
    const before = session.view()
    const next = cloneVisual(before.visual)
    next.doc.content = (next.doc.content ?? []).map(withoutProtected).filter((node): node is JSONContent => node !== null)

    const update = session.applyVisual(next)
    expect(update).toMatchObject({ ok: false })
    expect(session.view()).toEqual(before)
    expect(session.serialize()).toBe(source)
  })

  it('retains invalid source input in source mode while a valid source edit rebuilds its ranges', () => {
    const codec = createCodec()
    const source = 'One.\n\nTwo.\n'
    const session = createMarkdownDocumentSession(source, codec)
    const valid = session.applySource('One.\n\nChanged.\n')

    expect(valid).toMatchObject({ ok: true, changedRange: { from: 0, to: 'One.\n\nChanged.\n'.length } })
    expect(session.view()).toMatchObject({ revision: 1, mode: 'source', source: 'One.\n\nChanged.\n' })
    expect(session.enterVisual()).toMatchObject({ ok: true, view: expect.objectContaining({ mode: 'visual' }) })

    const brokenCodec: MarkdownCodec = { ...codec, lex: () => { throw new Error('broken lex') } }
    const broken = createMarkdownDocumentSession(source, brokenCodec)
    expect(broken.applySource('not projectable')).toMatchObject({ ok: false })
    expect(broken.view()).toMatchObject({ source: 'not projectable', mode: 'source', fallbackReason: 'broken lex' })
    expect(broken.serialize()).toBe('not projectable')
  })

  it('returns a fresh protected range in source mode without making no-op mode switches dirty', () => {
    const source = 'Before <u>protected</u> after.\n'
    const session = createMarkdownDocumentSession(source, createCodec())
    const fragment = session.view().protectedFragments[0]!
    const update = session.enterSource(fragment.id)

    expect(update).toMatchObject({ ok: true, changedRange: fragment.range })
    expect(session.enterVisual()).toMatchObject({ ok: true })
    expect(session.view()).toMatchObject({ dirty: false, revision: 0, mode: 'visual' })
  })

  it('uses actual saved text for same-revision Save As and retains newer edits across different units', () => {
    const source = '![old](old.png)\n\nFirst.\n\nSecond.'
    const session = createMarkdownDocumentSession(source, createCodec())
    const ticket = session.beginSave()
    const afterEdit = session.applyVisual(visualWithText(session.view().visual, 'Second.', 'Changed.'))
    expect(afterEdit.ok).toBe(true)

    const saved = session.markSaved('![new](assets/new.png)\n\nFirst.\n\nSecond.', ticket)
    expect(saved).toMatchObject({ dirty: true, source: '![new](assets/new.png)\n\nFirst.\n\nChanged.' })
    expect(session.serialize()).toBe('![new](assets/new.png)\n\nFirst.\n\nChanged.')

    const sameRevision = createMarkdownDocumentSession(source, createCodec())
    const sameTicket = sameRevision.beginSave()
    expect(sameRevision.markSaved('![new](assets/new.png)\n\nFirst.\n\nSecond.', sameTicket)).toMatchObject({
      dirty: false,
      source: '![new](assets/new.png)\n\nFirst.\n\nSecond.',
    })
  })

  it('rebases a Save As image path into a concurrent alt edit without changing the envelope', () => {
    const source = '---\ntitle: keep\n---\n\n![image](old.png)\n\nTail.'
    const session = createMarkdownDocumentSession(source, createCodec())
    const ticket = session.beginSave()
    expect(session.applyVisual(visualWithImageAlt(session.view().visual, 'edited alt')).ok).toBe(true)

    expect(session.markSaved(
      '---\ntitle: keep\n---\n\n![image](assets/image.png)\n\nTail.',
      ticket,
      [{ from: 'old.png', to: 'assets/image.png' }],
    )).toMatchObject({
      dirty: true,
      source: '---\ntitle: keep\n---\n\n![edited alt](assets/image.png)\n\nTail.',
    })
    expect(session.serialize()).toBe('---\ntitle: keep\n---\n\n![edited alt](assets/image.png)\n\nTail.')
  })

  it('rebases only a rendered image destination when the concurrent unit includes inline code', () => {
    const source = '- ![image](old.png)\n- `![literal](old.png)`'
    const session = createMarkdownDocumentSession(source, createCodec())
    const ticket = session.beginSave()
    expect(session.applySource('- ![edited alt](old.png)\n- `![literal](old.png)`').ok).toBe(true)

    expect(session.markSaved(
      '- ![image](assets/image.png)\n- `![literal](old.png)`',
      ticket,
      [{ from: 'old.png', to: 'assets/image.png' }],
    )).toMatchObject({
      dirty: true,
      source: '- ![edited alt](assets/image.png)\n- `![literal](old.png)`',
    })
  })

  it('applies chained Save As mappings once per original image destination', () => {
    const source = '- ![one](old.png)\n- ![two](assets/old.png)'
    const session = createMarkdownDocumentSession(source, createCodec())
    const ticket = session.beginSave()
    expect(session.applySource('- ![one edited](old.png)\n- ![two edited](assets/old.png)').ok).toBe(true)

    expect(session.markSaved(
      '- ![one](assets/old.png)\n- ![two](assets/old-2.png)',
      ticket,
      [
        { from: 'old.png', to: 'assets/old.png' },
        { from: 'assets/old.png', to: 'assets/old-2.png' },
      ],
    )).toMatchObject({
      dirty: true,
      source: '- ![one edited](assets/old.png)\n- ![two edited](assets/old-2.png)',
    })
  })

  it('keeps the user version and exposes a rebase conflict when the same unit changed during save', () => {
    const source = '![old](old.png)\n\nSecond.'
    const session = createMarkdownDocumentSession(source, createCodec())
    const ticket = session.beginSave()
    expect(session.applyVisual(visualWithText(session.view().visual, 'Second.', 'User change.')).ok).toBe(true)

    const view = session.markSaved('![new](assets/new.png)\n\nMain change.', ticket)
    expect(view).toMatchObject({ dirty: true, source: '![new](assets/new.png)\n\nUser change.' })
    expect(view.fallbackReason).toContain('rebase conflict')
  })

  it('rebases frontmatter independently from body units without overwriting a newer user envelope', () => {
    const original = '---\ntitle: old\n---\n\nBody.'
    const userEnvelope = '---\ntitle: user\n---\n\nBody.'
    const writtenEnvelope = '---\ntitle: written\n---\n\nBody.'
    const user = createMarkdownDocumentSession(original, createCodec())
    const userTicket = user.beginSave()
    expect(user.applySource(userEnvelope).ok).toBe(true)
    expect(user.markSaved(original, userTicket)).toMatchObject({ source: userEnvelope, dirty: true })

    const conflict = createMarkdownDocumentSession(original, createCodec())
    const conflictTicket = conflict.beginSave()
    expect(conflict.applySource(userEnvelope).ok).toBe(true)
    expect(conflict.markSaved(writtenEnvelope, conflictTicket)).toMatchObject({
      source: userEnvelope,
      dirty: true,
      fallbackReason: expect.stringContaining('rebase conflict'),
    })

    const mainOnly = createMarkdownDocumentSession(original, createCodec())
    const mainTicket = mainOnly.beginSave()
    expect(mainOnly.applyVisual(visualWithText(mainOnly.view().visual, 'Body.', 'User body.')).ok).toBe(true)
    expect(mainOnly.markSaved(writtenEnvelope, mainTicket)).toMatchObject({
      source: '---\ntitle: written\n---\n\nUser body.',
      dirty: true,
    })
  })

  it('aligns duplicate source units by ordered ticket context during a concurrent save rebase', () => {
    const session = createMarkdownDocumentSession('A\n\nB\n\nA', createCodec())
    const ticket = session.beginSave()
    expect(session.applySource('A\n\nA').ok).toBe(true)

    expect(session.markSaved('A\n\nB\n\nX', ticket)).toMatchObject({ source: 'A\n\nX', dirty: true })
    expect(session.serialize()).toBe('A\n\nX')
  })

  it('keeps the user source when deleting one of indistinguishable duplicate units cannot be aligned safely', () => {
    const session = createMarkdownDocumentSession('A\n\nA', createCodec())
    const ticket = session.beginSave()
    expect(session.applySource('A').ok).toBe(true)

    expect(session.markSaved('X\n\nA', ticket)).toMatchObject({
      source: 'A',
      dirty: true,
      fallbackReason: expect.stringContaining('rebase conflict'),
    })
  })

  it('follows a uniquely moved ticket unit when the save result rewrites that unit', () => {
    const session = createMarkdownDocumentSession('A\n\nB\n\nC', createCodec())
    const ticket = session.beginSave()
    expect(session.applySource('B\n\nA\n\nC').ok).toBe(true)

    expect(session.markSaved('X\n\nB\n\nC', ticket)).toMatchObject({ source: 'B\n\nX\n\nC', dirty: true })
    expect(session.serialize()).toBe('B\n\nX\n\nC')
  })

  it('keeps current source with a conflict when a moved duplicate has no unique descendant', () => {
    const session = createMarkdownDocumentSession('A\n\nB\n\nA', createCodec())
    const ticket = session.beginSave()
    expect(session.applySource('B\n\nA').ok).toBe(true)

    expect(session.markSaved('X\n\nB\n\nA', ticket)).toMatchObject({
      source: 'B\n\nA',
      dirty: true,
      fallbackReason: expect.stringContaining('rebase conflict'),
    })
  })

  it('keeps user-edited unit separators when the save result leaves that unit unchanged', () => {
    const session = createMarkdownDocumentSession('A\n\nB', createCodec())
    const ticket = session.beginSave()
    expect(session.applySource('A\n\n\nB').ok).toBe(true)

    expect(session.markSaved('A\n\nB', ticket)).toMatchObject({ source: 'A\n\n\nB', dirty: true })
    expect(session.serialize()).toBe('A\n\n\nB')
  })

  it('reports a conflict instead of merging separator and raw changes to the same unit', () => {
    const session = createMarkdownDocumentSession('A\n\nB', createCodec())
    const ticket = session.beginSave()
    expect(session.applySource('A\n\n\nB').ok).toBe(true)

    expect(session.markSaved('X\n\nB', ticket)).toMatchObject({
      source: 'A\n\n\nB',
      dirty: true,
      fallbackReason: expect.stringContaining('rebase conflict'),
    })
  })
})
