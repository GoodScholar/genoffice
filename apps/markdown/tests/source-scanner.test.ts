import { describe, expect, it } from 'vitest'
import { marked } from 'marked'
import { scanMarkdownSource, type SourceToken } from '../src/renderer/markdown/sourceScanner'

const lex = (tokens: SourceToken[]): ((source: string) => SourceToken[]) => () => tokens
const markedLex = (source: string): SourceToken[] => marked.lexer(source) as SourceToken[]

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

  it('consumes a real marked space token into the preceding trailingRaw', () => {
    const source = 'A\n\nB'
    const scan = scanMarkdownSource(source, markedLex)

    expect(scan).toMatchObject({ fallbackToSource: false })
    expect(scan.units).toEqual([
      expect.objectContaining({ raw: 'A', trailingRaw: '\n\n' }),
      expect.objectContaining({ raw: 'B', trailingRaw: '' }),
    ])
  })

  it('restores CRLF token slices from the real Marked lexer when assigning trailingRaw', () => {
    const scan = scanMarkdownSource('A\r\n\r\nB.', markedLex)

    expect(scan).toMatchObject({ fallbackToSource: false })
    expect(scan.units).toEqual([
      expect.objectContaining({ raw: 'A', trailingRaw: '\r\n\r\n', range: { from: 0, to: 1 } }),
      expect.objectContaining({ raw: 'B.', trailingRaw: '', range: { from: 5, to: 7 } }),
    ])
  })

  it('reports inline HTML CRLF ranges against the original source offsets', () => {
    const source = 'Before <u>text</u>\r\n\r\nAfter.'
    const scan = scanMarkdownSource(source, markedLex)

    expect(scan).toMatchObject({ fallbackToSource: false })
    const protectedRange = scan.units[0]?.protection?.ranges[0]
    expect(protectedRange).toEqual({ from: 7, to: 18 })
    expect(source.slice(protectedRange?.from, protectedRange?.to)).toBe('<u>text</u>')
    expect(scan.units[0]).toMatchObject({ trailingRaw: '\r\n\r\n' })
  })

  it('consumes emoji raw source by UTF-16 offsets instead of splitting a surrogate pair', () => {
    const source = 'Hello 😀'
    const scan = scanMarkdownSource(source, markedLex)

    expect(scan).toMatchObject({ fallbackToSource: false })
    expect(scan.units[0]).toMatchObject({ raw: source, range: { from: 0, to: source.length } })
  })

  it('keeps emoji, CRLF, and inline HTML ranges attached to original source offsets', () => {
    const source = '😀 <u>x</u>\r\n\r\nAfter.'
    const scan = scanMarkdownSource(source, markedLex)
    const range = scan.units[0]?.protection?.ranges[0]

    expect(scan).toMatchObject({ fallbackToSource: false })
    expect(range).toEqual({ from: 3, to: 11 })
    expect(source.slice(range?.from, range?.to)).toBe('<u>x</u>')
    expect(scan.units[0]).toMatchObject({ raw: '😀 <u>x</u>', trailingRaw: '\r\n\r\n' })
  })

  it('protects a precisely bounded HTML pair split by the real marked inline lexer', () => {
    const source = 'Before <u>text</u> after'
    const scan = scanMarkdownSource(source, markedLex)

    expect(scan.units[0]?.protection).toEqual({
      display: 'inline',
      reason: 'raw-html',
      ranges: [{ from: 7, to: 18 }],
    })
  })

  it('protects an unclosed top-level HTML comment from the real marked lexer', () => {
    const source = '<!-- unclosed comment'
    const scan = scanMarkdownSource(source, markedLex)

    expect(scan.units[0]?.protection).toEqual({
      display: 'block',
      reason: 'ambiguous-inline-html',
      ranges: [{ from: 0, to: source.length }],
    })
  })

  it('finds HTML nested inside real marked inline tokens', () => {
    const scan = scanMarkdownSource('**<img src="x">**', markedLex)

    expect(scan.units[0]?.protection).toEqual({
      display: 'inline',
      reason: 'raw-html',
      ranges: [{ from: 2, to: 15 }],
    })
  })

  it('does not treat a fenced-code line with an info string as a closing fence', () => {
    const source = '```js\ncode\n```wrong\n<div>literal</div>\n```\n<div>outside</div>'
    const scan = scanMarkdownSource(source, markedLex)

    expect(scan.fallbackToSource).toBe(false)
    expect(scan.units[1]?.protection).toEqual({
      display: 'block',
      reason: 'raw-html',
      ranges: [{ from: source.indexOf('<div>outside</div>'), to: source.length }],
    })
  })
})
