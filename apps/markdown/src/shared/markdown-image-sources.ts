export interface MarkdownImageDestinationRange {
  start: number
  end: number
  source: string
  htmlQuote?: '"' | "'" | null
}

export interface MarkdownImageSourceScan {
  ranges: MarkdownImageDestinationRange[]
  ambiguousHtml: boolean
}

interface TextRange {
  start: number
  end: number
}

function escapedAt(text: string, index: number): boolean {
  let slashes = 0
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i--) slashes++
  return slashes % 2 === 1
}

function positionInRanges(ranges: readonly TextRange[], position: number): TextRange | undefined {
  let low = 0
  let high = ranges.length - 1
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const range = ranges[middle]!
    if (position < range.start) high = middle - 1
    else if (position >= range.end) low = middle + 1
    else return range
  }
  return undefined
}

function markdownCodeRanges(markdown: string): TextRange[] {
  const blockRanges: TextRange[] = []
  let fence: { marker: '`' | '~'; length: number; start: number } | null = null
  let offset = 0
  for (const lineWithBreak of markdown.match(/.*(?:\n|$)/g) ?? []) {
    if (!lineWithBreak) continue
    const line = lineWithBreak.replace(/\r?\n$/, '')
    const lineEnd = offset + lineWithBreak.length
    if (fence) {
      const close = new RegExp(`^ {0,3}\\${fence.marker}{${fence.length},}[ \\t]*$`)
      if (close.test(line)) {
        blockRanges.push({ start: fence.start, end: lineEnd })
        fence = null
      }
    } else {
      const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
      if (open && (open[1]![0] === '~' || !open[2]!.includes('`'))) {
        fence = { marker: open[1]![0] as '`' | '~', length: open[1]!.length, start: offset }
      } else if (/^(?: {4}|\t)/.test(line)) {
        blockRanges.push({ start: offset, end: lineEnd })
      }
    }
    offset = lineEnd
  }
  if (fence) blockRanges.push({ start: fence.start, end: markdown.length })
  blockRanges.sort((left, right) => left.start - right.start)

  const ranges = [...blockRanges]
  for (let index = 0; index < markdown.length;) {
    const block = positionInRanges(blockRanges, index)
    if (block) {
      index = block.end
      continue
    }
    if (markdown[index] !== '`' || escapedAt(markdown, index)) {
      index += 1
      continue
    }
    let runEnd = index + 1
    while (markdown[runEnd] === '`') runEnd += 1
    const runLength = runEnd - index
    let search = runEnd
    let closeEnd = -1
    while (search < markdown.length) {
      const blocked = positionInRanges(blockRanges, search)
      if (blocked) {
        search = blocked.end
        continue
      }
      const next = markdown.indexOf('`', search)
      if (next < 0) break
      let nextEnd = next + 1
      while (markdown[nextEnd] === '`') nextEnd += 1
      if (nextEnd - next === runLength) {
        closeEnd = nextEnd
        break
      }
      search = nextEnd
    }
    if (closeEnd > 0) {
      ranges.push({ start: index, end: closeEnd })
      index = closeEnd
    } else index = runEnd
  }
  return ranges.sort((left, right) => left.start - right.start)
}

function imageDestinationRanges(markdown: string): MarkdownImageDestinationRange[] {
  const ranges: MarkdownImageDestinationRange[] = []
  for (let i = 0; i < markdown.length - 2; i++) {
    if (markdown[i] !== '!' || markdown[i + 1] !== '[' || escapedAt(markdown, i)) continue
    let bracketDepth = 1
    let altEnd = i + 2
    for (; altEnd < markdown.length; altEnd++) {
      if (escapedAt(markdown, altEnd)) continue
      if (markdown[altEnd] === '[') bracketDepth++
      else if (markdown[altEnd] === ']' && --bracketDepth === 0) break
    }
    if (bracketDepth !== 0) continue
    let open = altEnd + 1
    while (markdown[open] === ' ' || markdown[open] === '\t') open++
    if (markdown[open] !== '(') {
      i = altEnd
      continue
    }
    let close = open + 1
    let parenDepth = 1
    let quote = ''
    let angle = false
    for (; close < markdown.length; close++) {
      const char = markdown[close]!
      if (escapedAt(markdown, close)) continue
      if (quote) {
        if (char === quote) quote = ''
        continue
      }
      if (angle) {
        if (char === '>') angle = false
        continue
      }
      if (char === '"' || char === "'") quote = char
      else if (char === '<') angle = true
      else if (char === '(') parenDepth++
      else if (char === ')' && --parenDepth === 0) break
    }
    if (parenDepth !== 0) continue
    let start = open + 1
    let end = close
    while (start < end && /\s/.test(markdown[start]!)) start++
    while (end > start && /\s/.test(markdown[end - 1]!)) end--
    if (markdown[start] === '<') {
      const angleEnd = markdown.indexOf('>', start + 1)
      if (angleEnd > start && angleEnd <= end) {
        start++
        end = angleEnd
      }
    } else {
      const raw = markdown.slice(start, end)
      const title = /\s+(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\((?:\\.|[^)\\])*\))\s*$/.exec(raw)
      if (title?.index !== undefined) end = start + title.index
      while (end > start && /\s/.test(markdown[end - 1]!)) end--
    }
    if (end > start) {
      const source = markdown.slice(start, end).replace(/\\([\\()[\]<> ])/g, '$1')
      ranges.push({ start, end, source })
    }
    i = close
  }
  return ranges
}

const BASIC_HTML_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: '\u00a0',
  quot: '"',
}

function decodeHtmlImageSource(value: string): { source: string; ambiguous: boolean } {
  let ambiguous = false
  const source = value.replace(/&([^&;\s]+);/g, (entity, body: string) => {
    if (body.startsWith('#')) {
      const hexadecimal = body[1]?.toLowerCase() === 'x'
      const digits = body.slice(hexadecimal ? 2 : 1)
      if (
        digits.length === 0 ||
        !(hexadecimal ? /^[0-9a-f]+$/i.test(digits) : /^[0-9]+$/.test(digits))
      ) {
        ambiguous = true
        return entity
      }
      const codePoint = Number.parseInt(digits, hexadecimal ? 16 : 10)
      if (codePoint <= 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
        ambiguous = true
        return entity
      }
      return String.fromCodePoint(codePoint)
    }
    const decoded = BASIC_HTML_ENTITIES[body.toLowerCase()]
    if (decoded === undefined) {
      ambiguous = true
      return entity
    }
    return decoded
  })
  if (/&#(?:x[0-9a-f]*|[0-9]*)/i.test(source)) ambiguous = true
  return { source, ambiguous }
}

function parseHtmlImageTag(
  text: string,
  tagStart: number,
): { nextIndex: number; range?: MarkdownImageDestinationRange; ambiguous: boolean } {
  let cursor = tagStart + 4
  let sourceRange: MarkdownImageDestinationRange | undefined
  let ambiguous = false
  while (cursor < text.length) {
    while (cursor < text.length && /\s/.test(text[cursor]!)) cursor += 1
    if (cursor >= text.length) return { nextIndex: text.length, ambiguous: true }
    if (text[cursor] === '>')
      return {
        nextIndex: cursor + 1,
        ...(ambiguous || !sourceRange ? {} : { range: sourceRange }),
        ambiguous,
      }
    if (text[cursor] === '/' && text[cursor + 1] === '>')
      return {
        nextIndex: cursor + 2,
        ...(ambiguous || !sourceRange ? {} : { range: sourceRange }),
        ambiguous,
      }
    if (text[cursor] === '/') {
      ambiguous = true
      cursor += 1
      continue
    }
    const nameStart = cursor
    while (
      cursor < text.length &&
      !/\s/.test(text[cursor]!) &&
      text[cursor] !== '=' &&
      text[cursor] !== '/' &&
      text[cursor] !== '>'
    )
      cursor += 1
    if (cursor === nameStart) {
      ambiguous = true
      cursor += 1
      continue
    }
    const attributeName = text.slice(nameStart, cursor).toLowerCase()
    while (cursor < text.length && /\s/.test(text[cursor]!)) cursor += 1
    if (text[cursor] !== '=') {
      if (attributeName === 'src') ambiguous = true
      continue
    }
    cursor += 1
    while (cursor < text.length && /\s/.test(text[cursor]!)) cursor += 1
    if (
      cursor >= text.length ||
      text[cursor] === '>' ||
      (text[cursor] === '/' && text[cursor + 1] === '>')
    ) {
      if (attributeName === 'src') ambiguous = true
      continue
    }
    const quote: '"' | "'" | null = text[cursor] === '"' ? '"' : text[cursor] === "'" ? "'" : null
    let valueStart: number
    let valueEnd: number
    if (quote !== null) {
      valueStart = cursor + 1
      valueEnd = text.indexOf(quote, valueStart)
      if (valueEnd < 0) return { nextIndex: text.length, ambiguous: true }
      cursor = valueEnd + 1
    } else {
      valueStart = cursor
      while (
        cursor < text.length &&
        !/\s/.test(text[cursor]!) &&
        text[cursor] !== '>' &&
        !(text[cursor] === '/' && text[cursor + 1] === '>')
      ) {
        if (/["'`<=]/.test(text[cursor]!)) ambiguous = true
        cursor += 1
      }
      valueEnd = cursor
      if (valueEnd === valueStart && attributeName === 'src') ambiguous = true
    }
    if (attributeName !== 'src') continue
    if (sourceRange !== undefined) {
      ambiguous = true
      continue
    }
    const decoded = decodeHtmlImageSource(text.slice(valueStart, valueEnd))
    if (decoded.ambiguous) ambiguous = true
    sourceRange = { start: valueStart, end: valueEnd, source: decoded.source, htmlQuote: quote }
  }
  return { nextIndex: text.length, ambiguous: true }
}

function htmlImageSourceRanges(
  markdown: string,
  codeRanges: readonly TextRange[],
): MarkdownImageSourceScan {
  const ranges: MarkdownImageDestinationRange[] = []
  let ambiguousHtml = false
  for (let index = 0; index < markdown.length; index += 1) {
    const code = positionInRanges(codeRanges, index)
    if (code) {
      index = code.end - 1
      continue
    }
    if (markdown[index] !== '<') continue
    if (markdown.startsWith('<!--', index)) {
      const commentEnd = markdown.indexOf('-->', index + 4)
      if (commentEnd < 0) {
        if (/<img(?:\s|\/|>)/i.test(markdown.slice(index + 4))) ambiguousHtml = true
        break
      }
      index = commentEnd + 2
      continue
    }
    if (
      markdown.slice(index + 1, index + 4).toLowerCase() !== 'img' ||
      (index + 4 < markdown.length && !/[\s/>]/.test(markdown[index + 4]!))
    )
      continue
    const parsed = parseHtmlImageTag(markdown, index)
    if (parsed.ambiguous) ambiguousHtml = true
    if (parsed.range) ranges.push(parsed.range)
    index = Math.max(index, parsed.nextIndex - 1)
  }
  return { ranges, ambiguousHtml }
}

export function scanMarkdownImageSources(markdown: string): MarkdownImageSourceScan {
  const codeRanges = markdownCodeRanges(markdown)
  const html = htmlImageSourceRanges(markdown, codeRanges)
  const markdownRanges = imageDestinationRanges(markdown).filter(
    (range) => positionInRanges(codeRanges, range.start) === undefined,
  )
  const ordered = [...markdownRanges, ...html.ranges].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  )
  const ranges: MarkdownImageDestinationRange[] = []
  for (const range of ordered) {
    const previous = ranges[ranges.length - 1]
    if (previous && range.start < previous.end) {
      html.ambiguousHtml = true
      continue
    }
    ranges.push(range)
  }
  return { ranges, ambiguousHtml: html.ambiguousHtml }
}

export function extractMarkdownImageSources(markdown: string): string[] {
  return scanMarkdownImageSources(markdown).ranges.map((range) => range.source)
}

function encodeHtmlAttributeReplacement(value: string, quote: '"' | "'" | null): string {
  let encoded = ''
  for (const character of value) {
    if (character === '&') encoded += '&amp;'
    else if (character === '<') encoded += '&lt;'
    else if (quote === '"' && character === '"') encoded += '&quot;'
    else if (quote === "'" && character === "'") encoded += '&#39;'
    else if (quote === null && /[\s"'`=>]/.test(character))
      encoded += `&#${character.codePointAt(0)!};`
    else encoded += character
  }
  return encoded
}

export function rewriteMarkdownImageSources(
  markdown: string,
  rewrites: ReadonlyMap<string, string>,
): string {
  if (rewrites.size === 0) return markdown
  const ranges = scanMarkdownImageSources(markdown).ranges
  let cursor = 0
  let output = ''
  for (const range of ranges) {
    const replacement = rewrites.get(range.source)
    if (replacement === undefined) continue
    output += markdown.slice(cursor, range.start)
    output +=
      range.htmlQuote === undefined
        ? replacement
        : encodeHtmlAttributeReplacement(replacement, range.htmlQuote)
    cursor = range.end
  }
  return cursor === 0 ? markdown : output + markdown.slice(cursor)
}
