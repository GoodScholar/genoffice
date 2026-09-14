import { afterAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Editor, type JSONContent } from '@tiptap/core'
import { marked } from 'marked'
import { buildExtensions } from '../src/renderer/editor/extensions'
import { createMarkdownDocumentSession } from '../src/renderer/markdown/documentSession'
import { createTiptapMarkdownCodec, type MarkdownCodec, type VisualProjection } from '../src/renderer/markdown/sourceProjection'

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
})
