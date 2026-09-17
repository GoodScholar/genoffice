import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { executeTool } from '../src/renderer/ai/tools'
import { Editor } from '@tiptap/core'
import { buildExtensions } from '../src/renderer/editor/extensions'
import { replaceEditorBaseline, applyProjectionProvenance } from '../src/renderer/App'
import { createMarkdownDocumentSession } from '../src/renderer/markdown/documentSession'
import { createTiptapMarkdownCodec } from '../src/renderer/markdown/sourceProjection'

const editors: Editor[] = []
afterEach(() => editors.splice(0).forEach((editor) => editor.destroy()))
function open(source: string) {
  const editor = new Editor({
    extensions: buildExtensions({
      slashController: { onOpen() {}, onUpdate() {}, onKeyDown: () => false, onClose() {} },
      slashItems: () => [],
      protectedSource: { onEditSource() {}, onConvert() {}, onConfirmChange() {} },
    }),
    content: '',
  })
  editors.push(editor)
  const session = createMarkdownDocumentSession(source, createTiptapMarkdownCodec(editor))
  replaceEditorBaseline(editor, session.view().visual.doc)
  const sync = () => {
    const update = session.applyVisual({
      doc: editor.getJSON(),
      frontmatterInner: session.view().visual.frontmatterInner,
    })
    expect(update.ok, !update.ok ? update.error : '').toBe(true)
    if (update.ok) applyProjectionProvenance(editor, update.view.visual.doc)
  }
  return { editor, session, sync }
}

describe('PR 435 review regressions', () => {
  it('opens combined strong and code marks through the actual editor schema', () => {
    const { editor, session } = open('**`inline code`**\n')
    expect(() => editor.state.doc.check()).not.toThrow()
    expect(editor.getText()).toBe('inline code')
    expect(session.serialize()).toBe('**`inline code`**\n')
  })
  it.each([
    '# Heading\n\nFollowing paragraph.\n',
    '# Heading\n\n## Subheading\n\nText.\n',
    '- List item\n\nFollowing paragraph.\n',
    'First paragraph.\n\nFollowing paragraph.\n',
  ])('accepts typing and splitting %j without losing the next keystroke', (source) => {
    const { editor, session, sync } = open(source)
    let pos = 0
    editor.state.doc.descendants((node, at) => {
      if (!pos && node.isTextblock) pos = at + 3
    })
    editor.commands.setTextSelection(pos)
    editor.commands.insertContent('X')
    sync()
    expect(editor.commands.enter()).toBe(true)
    sync()
    editor.commands.insertContent('Y')
    sync()
    expect(session.serialize()).toContain('Y')
    expect(session.view().mode).toBe('visual')
  })
})

const root = resolve(__dirname, '../../..')
const corpus = execFileSync('git', ['ls-files', '-z', '--', '*.md'], { cwd: root })
  .toString()
  .split('\0')
  .filter(Boolean)
describe('tracked Markdown corpus', () => {
  it.each(corpus)('opens and round-trips %s', (path) => {
    const bytes = readFileSync(resolve(root, path))
    const { editor, session } = open(bytes.toString('utf8'))
    expect(() => editor.state.doc.check()).not.toThrow()
    expect(Buffer.from(session.serialize())).toEqual(bytes)
  })
  it.each(corpus)('edits headings, list items and paragraphs in %s', (path) => {
    const source = readFileSync(resolve(root, path), 'utf8')
    const { editor, session, sync } = open(source)
    const baseline = session.view().visual.doc
    const positions: number[] = []
    const structural = new Map<string, number[]>()
    editor.state.doc.descendants((node, at, parent) => {
      const kind =
        node.type.name === 'heading'
          ? 'heading'
          : parent &&
              ['listItem', 'taskItem'].includes(parent.type.name) &&
              node.type.name === 'paragraph'
            ? 'list'
            : undefined
      if (kind && node.textContent.length > 4 && !structural.has(kind))
        structural.set(kind, [at + 3, at + 1 + node.content.size])
      if (
        node.isTextblock &&
        node.textContent.length > 4 &&
        ['heading', 'paragraph'].includes(node.type.name)
      )
        positions.push(at + 3)
    })
    for (const position of new Set([
      ...positions.slice(0, 12),
      ...[...structural.values()].flat(),
    ])) {
      session.applySource(source)
      replaceEditorBaseline(editor, baseline)
      editor.commands.setTextSelection(position)
      editor.commands.insertContent('X')
      sync()
      editor.commands.enter()
      sync()
      editor.commands.insertContent('Y')
      sync()
    }
  })
})

describe('large document editing budget', () => {
  it.each([127_000, 317_000])('does not reparse unchanged blocks in a %i-byte document', (size) => {
    const fixture = readFileSync(resolve(root, 'skills/genoffice/SKILL.md'), 'utf8')
    let source = Buffer.from(fixture.repeat(Math.ceil(size / fixture.length)))
      .subarray(0, size)
      .toString('utf8')
      .replace(/\uFFFD$/, '')
    source += ' '.repeat(size - Buffer.byteLength(source))
    const { editor } = open('')
    const codec = createTiptapMarkdownCodec(editor)
    const parse = vi.spyOn(codec, 'parse')
    const session = createMarkdownDocumentSession(source, codec)
    const next = session.view().visual
    const paragraph = next.doc.content!.find(
      (node) => node.type === 'paragraph' && node.content?.[0]?.type === 'text',
    )!
    paragraph.content![0]!.text += 'x'
    parse.mockClear()
    const start = performance.now()
    const update = session.applyVisual(next)
    const elapsed = performance.now() - start
    console.log(
      `typing ${size} bytes: ${elapsed.toFixed(1)} ms; parsed ${parse.mock.calls.length} blocks`,
    )
    expect(update.ok).toBe(true)
    expect(parse.mock.calls.length).toBeLessThanOrEqual(3)
    // Wall-clock latency is checked in the browser, outside concurrent unit workers.
  })
})

describe('AI edits around preserved source', () => {
  it.each(['<details>raw HTML</details>', '[^note]: footnote'])(
    'allows a cross-block edit before %s',
    (raw) => {
      const { editor, session, sync } = open(`First paragraph.\n\nSecond paragraph.\n\n${raw}\n`)
      const result = executeTool(editor, {
        id: 'edit',
        name: 'apply_ops',
        input: {
          ops: [
            { op: 'replaceText', target: { start: 0, end: 1 }, find: 'paragraph', replace: 'text' },
          ],
        },
      })
      expect(result.isError, result.output).not.toBe(true)
      sync()
      expect(session.serialize()).toContain('First text.')
      expect(session.serialize()).toContain('Second text.')
      expect(session.serialize()).toContain(raw)
    },
  )
})

describe('inline code serialization', () => {
  it.each([' before', 'after ', ' both ', '`tick`', 'a|b', ' '])(
    'retains %j when editing a code span',
    (text) => {
      const { editor, session, sync } = open('Prefix `old` suffix.\n')
      const doc = editor.getJSON()
      doc.content![0]!.content!.find((node) =>
        node.marks?.some((mark) => mark.type === 'code'),
      )!.text = text
      editor.commands.setContent(doc)
      sync()
      const reopened = open(session.serialize())
      expect(reopened.editor.getText()).toBe(editor.getText())
    },
  )
  it('keeps pipes inside a table code span in the same cell', () => {
    const { editor, session, sync } = open('| Name | Value |\n| --- | --- |\n| `a\\|b` | kept |\n')
    const doc = editor.getJSON()
    doc.content![0]!.content![1]!.content![0]!.content![0]!.content![0]!.text += 'x'
    editor.commands.setContent(doc)
    sync()
    const reopened = open(session.serialize())
    expect(reopened.editor.getText()).toBe(editor.getText())
  })
})

it('retains trailing blank lines inside an unclosed code fence when edited', () => {
  const { editor, session, sync } = open('```js\nfoo\n\n\n')
  expect(editor.state.doc.firstChild!.textContent).toBe('foo\n\n')
  editor.commands.insertContentAt(4, 'X')
  sync()
  const reopened = open(session.serialize())
  expect(reopened.editor.state.doc.firstChild!.textContent).toBe('fooX\n\n')
})

it.each(['\n\nParagraph.\n', '\r\n\r\nBefore <u>raw</u> after.\r\n'])(
  'opens and edits a document with leading separators %j',
  (source) => {
    const { editor, session, sync } = open(source)
    expect(session.view().mode).toBe('visual')
    expect(session.serialize()).toBe(source)
    editor.commands.insertContentAt(2, 'X')
    sync()
    expect(session.serialize()).toContain('X')
  },
)
