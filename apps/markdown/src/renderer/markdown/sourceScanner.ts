export interface SourceRange {
  from: number
  to: number
}

export type ProtectedReason =
  | 'raw-html'
  | 'html-comment'
  | 'legacy-fenced-div'
  | 'ambiguous-inline-html'
  | 'parse-failure'

export interface SourceToken {
  type: string
  raw: string
  tokens?: SourceToken[]
}

export interface ScannedUnit {
  id: string
  raw: string
  range: SourceRange
  trailingRaw: string
  protection: null | {
    display: 'inline' | 'block'
    reason: ProtectedReason
    ranges: SourceRange[]
  }
}

export interface SourceScan {
  units: ScannedUnit[]
  fallbackToSource: boolean
  error?: string
}

const fenceLine = /^(?: {0,3})(`{3,}|~{3,})[^`~\r\n]*\r?$/
const legacyOpenLine = /^(?: {0,3}):::(?:callout|toggle)\b.*\r?$/
const legacyCloseLine = /^(?: {0,3}):::\s*\r?$/
const blankLines = /^(?:[ \t]*\r?\n)+/
const voidHtmlTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])

function intersects(a: SourceRange, b: SourceRange): boolean {
  return a.from < b.to && b.from < a.to
}

function fencedRanges(source: string): SourceRange[] {
  const ranges: SourceRange[] = []
  let opening: { marker: string, from: number } | null = null
  let offset = 0
  for (const line of source.split(/(?<=\n)/)) {
    const match = fenceLine.exec(line.replace(/\n$/, ''))
    if (!opening && match) {
      opening = { marker: match[1], from: offset }
    } else if (opening && match && match[1][0] === opening.marker[0] && match[1].length >= opening.marker.length) {
      ranges.push({ from: opening.from, to: offset + line.length })
      opening = null
    }
    offset += line.length
  }
  if (opening) ranges.push({ from: opening.from, to: source.length })
  return ranges
}

function pairedLegacyDivRanges(source: string, excluded: SourceRange[]): SourceRange[] {
  const ranges: SourceRange[] = []
  const stack: number[] = []
  let offset = 0
  for (const line of source.split(/(?<=\n)/)) {
    const range = { from: offset, to: offset + line.length }
    if (!excluded.some((fence) => intersects(range, fence))) {
      const normalized = line.replace(/\n$/, '')
      if (legacyOpenLine.test(normalized)) stack.push(offset)
      else if (stack.length > 0 && legacyCloseLine.test(normalized)) {
        const from = stack.pop()
        if (from !== undefined) ranges.push({ from, to: offset + line.length })
      }
    }
    offset += line.length
  }
  return ranges
}

function isBoundedHtml(raw: string): boolean {
  if (/^<!--(?:[^-]|-(?!->))*-->$/s.test(raw)) return true
  const tag = /<!--(?:[^-]|-(?!->))*-->|<\/?([A-Za-z][\w:-]*)(?:\s+[^<>]*?)?\s*\/?>/g
  const stack: string[] = []
  let cursor = 0
  let matched = false
  for (let match = tag.exec(raw); match; match = tag.exec(raw)) {
    if (match.index < cursor) return false
    cursor = tag.lastIndex
    matched = true
    if (!match[1]) continue
    const name = match[1].toLowerCase()
    const isClosing = match[0].startsWith('</')
    const isSelfClosing = /\/\s*>$/.test(match[0]) || voidHtmlTags.has(name)
    if (isClosing) {
      if (stack.pop() !== name) return false
    } else if (!isSelfClosing) {
      stack.push(name)
    }
  }
  return matched && stack.length === 0 && !/<[^>]*$/.test(raw)
}

function inlineProtection(unit: SourceToken, range: SourceRange): ScannedUnit['protection'] {
  if (!unit.tokens?.length) return null
  let cursor = 0
  const ranges: SourceRange[] = []
  const reasons: ProtectedReason[] = []
  for (const token of unit.tokens) {
    if (!unit.raw.startsWith(token.raw, cursor)) {
      return {
        display: 'block',
        reason: 'ambiguous-inline-html',
        ranges: [range],
      }
    }
    if (token.type === 'html') {
      if (!isBoundedHtml(token.raw)) {
        return {
          display: 'block',
          reason: 'ambiguous-inline-html',
          ranges: [range],
        }
      }
      ranges.push({ from: range.from + cursor, to: range.from + cursor + token.raw.length })
      reasons.push(token.raw.startsWith('<!--') ? 'html-comment' : 'raw-html')
    }
    cursor += token.raw.length
  }
  if (cursor !== unit.raw.length) {
    return {
      display: 'block',
      reason: 'ambiguous-inline-html',
      ranges: [range],
    }
  }
  if (ranges.length === 0) return null
  return {
    display: 'inline',
    reason: reasons.every((reason) => reason === 'html-comment') ? 'html-comment' : 'raw-html',
    ranges,
  }
}

function rawProtection(raw: string, range: SourceRange): ScannedUnit['protection'] {
  const trimmed = raw.trim()
  if (/^<!--(?:[^-]|-(?!->))*-->$/s.test(trimmed)) {
    return { display: 'block', reason: 'html-comment', ranges: [range] }
  }
  if (/^<\/?[A-Za-z][\w:-]*(?:\s+[^<>]*?)?\s*\/?>/s.test(trimmed)) {
    return { display: 'block', reason: 'raw-html', ranges: [range] }
  }
  return null
}

function failed(error: string): SourceScan {
  return { units: [], fallbackToSource: true, error }
}

export function scanMarkdownSource(
  bodyRaw: string,
  lex: (source: string) => SourceToken[],
  idPrefix = 's0',
): SourceScan {
  let tokens: SourceToken[]
  try {
    tokens = lex(bodyRaw)
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error))
  }

  const codeRanges = fencedRanges(bodyRaw)
  const legacyRanges = pairedLegacyDivRanges(bodyRaw, codeRanges)
  const units: ScannedUnit[] = []
  let cursor = 0

  for (const token of tokens) {
    if (!token.raw || !bodyRaw.startsWith(token.raw, cursor)) {
      return failed('Lexer token raw does not continuously cover the source')
    }
    const range = { from: cursor, to: cursor + token.raw.length }
    cursor = range.to
    const blank = blankLines.exec(bodyRaw.slice(cursor))?.[0] ?? ''
    cursor += blank.length

    let protection: ScannedUnit['protection'] = null
    if (!codeRanges.some((fence) => intersects(range, fence))) {
      if (legacyRanges.some((legacy) => intersects(range, legacy))) {
        protection = { display: 'block', reason: 'legacy-fenced-div', ranges: [range] }
      } else {
        protection = rawProtection(token.raw, range) ?? inlineProtection(token, range)
      }
    }
    units.push({ id: `${idPrefix}-b${units.length}`, raw: token.raw, range, trailingRaw: blank, protection })
  }

  if (cursor !== bodyRaw.length) return failed('Lexer token raw does not completely cover the source')
  return { units, fallbackToSource: false }
}
