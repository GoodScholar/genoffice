export interface SourceRange {
  from: number
  to: number
}

export type ProtectedReason =
  'raw-html' | 'html-comment' | 'legacy-fenced-div' | 'ambiguous-inline-html' | 'parse-failure'

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

const openingFenceLine = /^(?: {0,3})(`{3,})[^`\r\n]*\r?$|^(?: {0,3})(~{3,})[^\r\n]*\r?$/
const closingFenceLine = /^(?: {0,3})(`{3,}|~{3,})[ \t]*\r?$/
const legacyOpenLine = /^(?: {0,3}):::(?:callout|toggle)\b.*\r?$/
const legacyCloseLine = /^(?: {0,3}):::\s*\r?$/
const blankLines = /^(?:[ \t]*\r?\n)+/
const voidHtmlTags = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
])

function intersects(a: SourceRange, b: SourceRange): boolean {
  return a.from < b.to && b.from < a.to
}

function fencedRanges(source: string): SourceRange[] {
  const ranges: SourceRange[] = []
  let opening: { marker: string; from: number } | null = null
  let offset = 0
  for (const line of source.split(/(?<=\n)/)) {
    const normalized = line.replace(/\n$/, '')
    const openingMatch = openingFenceLine.exec(normalized)
    const closingMatch = closingFenceLine.exec(normalized)
    if (!opening && openingMatch) {
      opening = { marker: openingMatch[1] ?? openingMatch[2], from: offset }
    } else if (
      opening &&
      closingMatch &&
      closingMatch[1][0] === opening.marker[0] &&
      closingMatch[1].length >= opening.marker.length
    ) {
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

interface HtmlFragment {
  raw: string
  range: SourceRange
}

function containsHtml(tokens: SourceToken[] | undefined): boolean {
  return Boolean(tokens?.some((token) => token.type === 'html' || containsHtml(token.tokens)))
}

function wrappedInlineRaw(token: SourceToken): { raw: string; offset: number } | null {
  const patterns: Record<string, RegExp> = {
    strong: /^(\*\*|__)([\s\S]*)\1$/,
    em: /^(\*|_)([\s\S]*)\1$/,
    del: /^~~([\s\S]*)~~$/,
  }
  const match = patterns[token.type]?.exec(token.raw)
  if (!match || !token.tokens) return null
  const inner = token.tokens.map((child) => child.raw).join('')
  const content = token.type === 'del' ? match[1] : match[2]
  if (inner !== content) return null
  return { raw: content, offset: token.type === 'del' ? 2 : match[1].length }
}

function collectHtmlFragments(
  tokens: SourceToken[],
  raw: string,
  from: number,
  fragments: HtmlFragment[],
): boolean {
  let cursor = 0
  for (const token of tokens) {
    const consumed = consumeTokenRaw(raw, token.raw, cursor)
    if (consumed === null) return false
    if (token.type === 'html') {
      fragments.push({
        raw: consumed,
        range: { from: from + cursor, to: from + cursor + consumed.length },
      })
    } else if (containsHtml(token.tokens)) {
      const wrapped = wrappedInlineRaw(token)
      if (
        !wrapped ||
        !collectHtmlFragments(
          token.tokens!,
          consumed.slice(wrapped.offset, consumed.length - wrapped.offset),
          from + cursor + wrapped.offset,
          fragments,
        )
      ) {
        return false
      }
    }
    cursor += consumed.length
  }
  // Block tokens can own a final line ending which has no inline token.
  return /^[ \t\r\n]*$/.test(raw.slice(cursor))
}

type HtmlPart =
  | { kind: 'comment'; reason: ProtectedReason }
  | { kind: 'open'; name: string }
  | { kind: 'close'; name: string }
  | { kind: 'complete'; reason: ProtectedReason }
  | { kind: 'invalid' }

function htmlPart(raw: string): HtmlPart {
  if (/^<!--(?:[^-]|-(?!->))*-->$/s.test(raw)) return { kind: 'comment', reason: 'html-comment' }
  if (raw.startsWith('<!--')) return { kind: 'invalid' }
  const tag = /^<(\/)?([A-Za-z][\w:-]*)(?:\s+[^<>]*?)?\s*(\/?)>$/.exec(raw)
  if (tag) {
    const name = tag[2].toLowerCase()
    if (tag[1]) return { kind: 'close', name }
    if (tag[3] || voidHtmlTags.has(name)) return { kind: 'complete', reason: 'raw-html' }
    return { kind: 'open', name }
  }
  return isBoundedHtml(raw) ? { kind: 'complete', reason: 'raw-html' } : { kind: 'invalid' }
}

function ambiguous(range: SourceRange): NonNullable<ScannedUnit['protection']> {
  return { display: 'block', reason: 'ambiguous-inline-html', ranges: [range] }
}

function inlineProtection(unit: SourceToken, range: SourceRange): ScannedUnit['protection'] {
  if (!unit.tokens?.length || !containsHtml(unit.tokens)) return null
  const fragments: HtmlFragment[] = []
  if (!collectHtmlFragments(unit.tokens, unit.raw, range.from, fragments)) return ambiguous(range)
  if (fragments.length === 0) return null

  const open: Array<{ name: string; from: number }> = []
  const ranges: SourceRange[] = []
  const reasons: ProtectedReason[] = []
  for (const fragment of fragments) {
    const part = htmlPart(fragment.raw)
    if (part.kind === 'invalid') return ambiguous(range)
    if (part.kind === 'open') {
      open.push({ name: part.name, from: fragment.range.from })
    } else if (part.kind === 'close') {
      const start = open.pop()
      if (!start || start.name !== part.name) return ambiguous(range)
      ranges.push({ from: start.from, to: fragment.range.to })
      reasons.push('raw-html')
    } else {
      ranges.push(fragment.range)
      reasons.push(part.reason)
    }
  }
  if (open.length > 0) return ambiguous(range)
  return {
    display: 'inline',
    reason: reasons.every((reason) => reason === 'html-comment') ? 'html-comment' : 'raw-html',
    ranges,
  }
}

function topLevelHtmlProtection(raw: string, range: SourceRange): ScannedUnit['protection'] {
  const part = htmlPart(raw.trim())
  if (part.kind === 'invalid' || part.kind === 'open' || part.kind === 'close')
    return ambiguous(range)
  return { display: 'block', reason: part.reason, ranges: [range] }
}

function failed(error: string): SourceScan {
  return { units: [], fallbackToSource: true, error }
}

/** Consume a lexer raw value against the original source without normalizing it. */
function consumeTokenRaw(source: string, raw: string, from: number): string | null {
  let cursor = from
  for (let rawCursor = 0; rawCursor < raw.length; rawCursor += 1) {
    const character = raw[rawCursor]!
    if (character === '\n') {
      if (source[cursor] === '\n') cursor += 1
      else if (source.startsWith('\r\n', cursor)) cursor += 2
      else return null
    } else if (source[cursor] === character) {
      cursor += 1
    } else {
      return null
    }
  }
  return source.slice(from, cursor)
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
  let leadingRaw = ''

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]
    if (!token.raw) {
      return failed('Lexer token raw does not continuously cover the source')
    }
    const raw = consumeTokenRaw(bodyRaw, token.raw, cursor)
    if (raw === null) return failed('Lexer token raw does not continuously cover the source')
    if (token.type === 'space') {
      if (!/^[ \t\r\n]+$/.test(raw)) {
        return failed('Lexer space token cannot be assigned to a preceding unit')
      }
      if (units.length === 0) {
        leadingRaw += raw
        cursor += raw.length
        continue
      }
      const previous = units[units.length - 1]
      previous.trailingRaw += raw
      cursor += raw.length
      continue
    }
    const range = { from: cursor, to: cursor + raw.length }
    const leadingBlank = /^(?:[ \t]*\r?\n)+/.exec(raw)?.[0].length ?? 0
    const contentRange = { from: range.from + leadingBlank, to: range.to }
    cursor = range.to
    const next = tokens[index + 1]
    // Some real codec tokens (for example task lists) own their leading blank
    // lines. Do not consume those bytes twice as the preceding unit's suffix.
    const blank =
      next?.type === 'space' || /^(?:[ \t]*\r?\n)/.test(next?.raw ?? '')
        ? ''
        : (blankLines.exec(bodyRaw.slice(cursor))?.[0] ?? '')
    cursor += blank.length

    let protection: ScannedUnit['protection'] = null
    if (!codeRanges.some((fence) => intersects(contentRange, fence))) {
      if (legacyRanges.some((legacy) => intersects(contentRange, legacy))) {
        protection = { display: 'block', reason: 'legacy-fenced-div', ranges: [range] }
      } else if (token.type === 'html') {
        protection = topLevelHtmlProtection(raw, range)
      } else {
        protection = inlineProtection({ ...token, raw }, range)
      }
    }
    units.push({
      id: `${idPrefix}-b${units.length}`,
      raw: leadingRaw + raw,
      range: { from: range.from - leadingRaw.length, to: range.to },
      trailingRaw: blank,
      protection,
    })
    leadingRaw = ''
  }

  if (cursor !== bodyRaw.length)
    return failed('Lexer token raw does not completely cover the source')
  return { units, fallbackToSource: false }
}
