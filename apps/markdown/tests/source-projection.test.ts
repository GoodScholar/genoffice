import { afterAll, describe, expect, it } from 'vitest'
import { Editor, type JSONContent } from '@tiptap/core'
import { marked } from 'marked'
import { buildExtensions } from '../src/renderer/editor/extensions'
import { createTiptapMarkdownCodec, projectScan, serializeProjectedGroup, type MarkdownCodec } from '../src/renderer/markdown/sourceProjection'
import { scanMarkdownSource, type SourceScan } from '../src/renderer/markdown/sourceScanner'

const editors: Editor[] = []
afterAll(() => editors.forEach((editor) => editor.destroy()))

function createEditor(): Editor {
  const editor = new Editor({
    extensions: buildExtensions({
      slashController: { onOpen: () => {}, onUpdate: () => {}, onKeyDown: () => false, onClose: () => {} },
      slashItems: () => [],
    }),
    content: '',
  })
  editors.push(editor)
  return editor
}

function project(source: string) {
  const editor = createEditor()
  const scan = scanMarkdownSource(source, (input) => marked.lexer(input))
  return projectScan(scan, createTiptapMarkdownCodec(editor))
}

function findNodes(node: JSONContent, type: string): JSONContent[] {
  return [node, ...(node.content ?? []).flatMap((child) => findNodes(child, type))]
    .filter((child) => child.type === type)
}

describe('projectScan', () => {
  it('projects an HTML block to a protected block atom without losing raw source', () => {
    const source = '<p style="text-align: center">centered</p>'
    const result = project(source)
    const node = findNodes(result.visual.doc, 'protectedSourceBlock')[0]

    expect(node?.attrs).toMatchObject({ raw: source, reason: 'raw-html' })
    expect(result.fragments).toContainEqual(expect.objectContaining({ raw: source, display: 'block' }))
  })

  it('projects bounded inline HTML while retaining editable GFM on either side', () => {
    const result = project('**left** <span style="color: red">middle</span> ~~right~~')
    const paragraph = result.visual.doc.content?.[0]

    expect(paragraph?.type).toBe('paragraph')
    expect(paragraph?.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text', text: 'left', marks: [expect.objectContaining({ type: 'bold' })] }),
      expect.objectContaining({ type: 'protectedSourceInline', attrs: expect.objectContaining({ raw: '<span style="color: red">middle</span>' }) }),
      expect.objectContaining({ type: 'text', text: 'right', marks: [expect.objectContaining({ type: 'strike' })] }),
    ]))
  })

  it('projects a legacy fenced div as one protected block atom', () => {
    const source = ':::callout\nhello\n:::\n'
    const result = project(source)

    expect(findNodes(result.visual.doc, 'protectedSourceBlock')).toEqual([
      expect.objectContaining({ attrs: expect.objectContaining({ raw: source, reason: 'legacy-fenced-div' }) }),
    ])
  })

  it('assigns one sourceId to every top-level node parsed from the same source unit', () => {
    const scan: SourceScan = {
      fallbackToSource: false,
      units: [{ id: 's0-b0', raw: 'split', range: { from: 0, to: 5 }, trailingRaw: '', protection: null }],
    }
    const codec: MarkdownCodec = {
      lex: () => [],
      parse: () => ({ type: 'doc', content: [{ type: 'paragraph' }, { type: 'paragraph' }] }),
      serialize: () => '',
    }

    const result = projectScan(scan, codec)
    expect(result.visual.doc.content?.map((node) => node.attrs?.sourceId)).toEqual(['s0-b0', 's0-b0'])
    expect(result.fingerprints.get('s0-b0')).toBeDefined()
  })

  it('restores each inline protected raw fragment during group serialization', () => {
    const editor = createEditor()
    const codec = createTiptapMarkdownCodec(editor)
    const result = project('a <u>kept</u> b')

    expect(serializeProjectedGroup(result.visual.doc.content ?? [], codec)).toContain('<u>kept</u>')
  })
})
