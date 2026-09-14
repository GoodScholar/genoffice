import { describe, expect, it } from 'vitest'
import { scanMarkdownSource, type SourceToken } from '../src/renderer/markdown/sourceScanner'

const lex = (tokens: SourceToken[]): ((source: string) => SourceToken[]) => () => tokens

describe('scanMarkdownSource', () => {
  it('covers the source with ordered token raw values and assigns blank lines to trailingRaw', () => {
    const source = '# Heading\n\nParagraph\n'
    const scan = scanMarkdownSource(source, lex([
      { type: 'heading', raw: '# Heading\n' },
      { type: 'paragraph', raw: 'Paragraph\n' },
    ]), 's0')

    expect(scan).toMatchObject({ fallbackToSource: false })
    expect(scan.units).toEqual([
      expect.objectContaining({
        id: 's0-b0', raw: '# Heading\n', range: { from: 0, to: 10 }, trailingRaw: '\n', protection: null,
      }),
      expect.objectContaining({
        id: 's0-b1', raw: 'Paragraph\n', range: { from: 11, to: 21 }, trailingRaw: '', protection: null,
      }),
    ])
  })

  it('does not protect HTML or legacy div syntax inside a fenced code block', () => {
    const source = '```md\n<div>literal</div>\n:::callout\n```\n'
    const scan = scanMarkdownSource(source, lex([
      { type: 'code', raw: source },
    ]))

    expect(scan.fallbackToSource).toBe(false)
    expect(scan.units[0]?.protection).toBeNull()
  })

  it('returns only a bounded range for a well-formed inline HTML token', () => {
    const source = 'Before <u>underlined</u> after\n'
    const scan = scanMarkdownSource(source, lex([
      {
        type: 'paragraph',
        raw: source,
        tokens: [
          { type: 'text', raw: 'Before ' },
          { type: 'html', raw: '<u>underlined</u>' },
          { type: 'text', raw: ' after\n' },
        ],
      },
    ]))

    expect(scan.units[0]?.protection).toEqual({
      display: 'inline',
      reason: 'raw-html',
      ranges: [{ from: 7, to: 24 }],
    })
  })

  it('protects the entire unit when inline HTML is malformed or cannot be aligned', () => {
    const source = 'Before <u>unfinished after\n'
    const scan = scanMarkdownSource(source, lex([
      {
        type: 'paragraph',
        raw: source,
        tokens: [
          { type: 'text', raw: 'Before ' },
          { type: 'html', raw: '<u>unfinished' },
          { type: 'text', raw: ' after\n' },
        ],
      },
    ]))

    expect(scan.units[0]?.protection).toEqual({
      display: 'block',
      reason: 'ambiguous-inline-html',
      ranges: [{ from: 0, to: source.length }],
    })
  })

  it('falls back to the original source when lexing throws or token raw coverage is discontinuous', () => {
    const thrown = scanMarkdownSource('text', () => { throw new Error('lexer failed') })
    const discontinuous = scanMarkdownSource('text', lex([{ type: 'paragraph', raw: 'tex' }]))

    expect(thrown).toMatchObject({ fallbackToSource: true, error: 'lexer failed', units: [] })
    expect(discontinuous).toMatchObject({ fallbackToSource: true, units: [] })
  })
})
