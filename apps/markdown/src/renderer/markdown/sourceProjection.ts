import type { Editor, JSONContent } from '@tiptap/core'
import type { ProtectedReason, SourceRange, SourceScan, SourceToken } from './sourceScanner'

export interface MarkdownCodec {
  lex(source: string): SourceToken[]
  parse(source: string): JSONContent
  serialize(doc: JSONContent): string
}

export interface VisualProjection {
  doc: JSONContent
  frontmatterInner: string
}

export interface ProjectedFragment {
  id: string
  raw: string
  range: SourceRange
  display: 'inline' | 'block'
  reason: ProtectedReason
}

export interface ProjectionResult {
  visual: VisualProjection
  fragments: ProjectedFragment[]
  fingerprints: Map<string, string>
  fallbackToSource: boolean
}

interface Sentinel {
  id: string
  value: string
  fragment: ProjectedFragment
}

function documentContent(doc: JSONContent): JSONContent[] {
  return Array.isArray(doc.content) ? doc.content : []
}

function protectedBlock(id: string, raw: string, reason: ProtectedReason): JSONContent {
  return {
    type: 'protectedSourceBlock',
    attrs: { id, raw, reason, sourceId: id },
  }
}

function stableFingerprint(value: JSONContent[]): string {
  const withoutSourceIds = (current: unknown, topLevel = false): unknown => {
    if (Array.isArray(current)) return current.map((child) => withoutSourceIds(child, topLevel))
    if (!current || typeof current !== 'object') return current
    const record = current as Record<string, unknown>
    const result = Object.fromEntries(
      Object.entries(record)
        .filter(([key]) => key !== 'sourceId')
        .map(([key, child]) => [key, withoutSourceIds(child)]),
    ) as Record<string, unknown>
    const sourceId = record.attrs && typeof record.attrs === 'object'
      ? (record.attrs as Record<string, unknown>).sourceId
      : undefined
    if (topLevel && result.type === 'paragraph' && sourceId != null
      && Array.isArray(result.content) && result.content.length === 0) delete result.content
    return result
  }
  return JSON.stringify(value.map((node) => withoutSourceIds(node, true)))
}

function markerCharacter(excluded: string): string {
  for (let point = 0xe000; point <= 0xf8ff; point += 1) {
    const candidate = String.fromCharCode(point)
    if (!excluded.includes(candidate)) return candidate
  }
  throw new Error('No private-use sentinel character is available')
}

function sourceForScan(scan: SourceScan): string {
  return scan.units.map((unit) => unit.raw + unit.trailingRaw).join('')
}

function inlineFragments(scan: SourceScan, unitIndex: number): Sentinel[] | null {
  const unit = scan.units[unitIndex]!
  const protection = unit.protection
  if (!protection || protection.display !== 'inline') return []
  const character = markerCharacter(sourceForScan(scan))
  let previous = unit.range.from
  const sentinels: Sentinel[] = []
  for (let rangeIndex = 0; rangeIndex < protection.ranges.length; rangeIndex += 1) {
    const range = protection.ranges[rangeIndex]!
    if (
      range.from < unit.range.from || range.to > unit.range.to ||
      range.from >= range.to || range.from < previous
    ) return null
    previous = range.to
    const id = `${unit.id}-i${rangeIndex}`
    const raw = unit.raw.slice(range.from - unit.range.from, range.to - unit.range.from)
    const fragment: ProjectedFragment = {
      id,
      raw,
      range,
      display: 'inline',
      reason: protection.reason,
    }
    sentinels.push({ id, value: `${character}${id}${character}`, fragment })
  }
  return sentinels
}

function replaceRanges(raw: string, unitFrom: number, sentinels: Sentinel[]): string {
  let offset = 0
  let projected = ''
  for (const sentinel of sentinels) {
    const from = sentinel.fragment.range.from - unitFrom
    const to = sentinel.fragment.range.to - unitFrom
    projected += raw.slice(offset, from) + sentinel.value
    offset = to
  }
  return projected + raw.slice(offset)
}

function replaceSentinelText(node: JSONContent, sentinels: Sentinel[], seen: Map<string, number>): JSONContent[] {
  if (node.type === 'text' && typeof node.text === 'string') {
    const parts: JSONContent[] = []
    let cursor = 0
    while (cursor < node.text.length) {
      const next = sentinels
        .map((sentinel) => ({ sentinel, index: node.text!.indexOf(sentinel.value, cursor) }))
        .filter((match) => match.index >= 0)
        .sort((left, right) => left.index - right.index)[0]
      if (!next) break
      if (next.index > cursor) parts.push({ ...node, text: node.text.slice(cursor, next.index) })
      seen.set(next.sentinel.id, (seen.get(next.sentinel.id) ?? 0) + 1)
      parts.push({
        type: 'protectedSourceInline',
        attrs: {
          id: next.sentinel.id,
          raw: next.sentinel.fragment.raw,
          reason: next.sentinel.fragment.reason,
          sourceId: null,
        },
        ...(node.marks ? { marks: node.marks } : {}),
      })
      cursor = next.index + next.sentinel.value.length
    }
    if (parts.length === 0) return [node]
    if (cursor < node.text.length) parts.push({ ...node, text: node.text.slice(cursor) })
    return parts
  }
  if (!node.content) return [node]
  return [{ ...node, content: node.content.flatMap((child) => replaceSentinelText(child, sentinels, seen)) }]
}

function asEditableNodes(parsed: JSONContent, sourceId: string): JSONContent[] {
  return documentContent(parsed).map((node) => ({
    ...node,
    attrs: { ...node.attrs, sourceId },
  }))
}

export function createTiptapMarkdownCodec(editor: Editor): MarkdownCodec {
  const markdown = editor.markdown
  if (!markdown) throw new Error('TipTap Markdown extension is required for source projection')
  return {
    lex: (source) => markdown.instance.lexer(source) as SourceToken[],
    parse: (source) => markdown.parse(source),
    serialize: (doc) => markdown.serialize(doc),
  }
}

export function projectScan(scan: SourceScan, codec: MarkdownCodec): ProjectionResult {
  const content: JSONContent[] = []
  const fragments: ProjectedFragment[] = []
  const fingerprints = new Map<string, string>()
  if (scan.fallbackToSource) {
    return { visual: { doc: { type: 'doc', content }, frontmatterInner: '' }, fragments, fingerprints, fallbackToSource: true }
  }

  for (let index = 0; index < scan.units.length; index += 1) {
    const unit = scan.units[index]!
    if (unit.protection?.display === 'block') {
      const fragment: ProjectedFragment = {
        id: unit.id,
        raw: unit.raw,
        range: unit.range,
        display: 'block',
        reason: unit.protection.reason,
      }
      fragments.push(fragment)
      content.push(protectedBlock(fragment.id, fragment.raw, fragment.reason))
      continue
    }

    let sentinels: Sentinel[] | null
    try {
      sentinels = inlineFragments(scan, index)
    } catch {
      sentinels = null
    }
    if (!sentinels) {
      const reason: ProtectedReason = 'parse-failure'
      fragments.push({ id: unit.id, raw: unit.raw, range: unit.range, display: 'block', reason })
      content.push(protectedBlock(unit.id, unit.raw, reason))
      continue
    }

    let parsed: JSONContent
    try {
      parsed = codec.parse(replaceRanges(unit.raw, unit.range.from, sentinels))
    } catch {
      parsed = { type: 'doc' }
    }
    const seen = new Map<string, number>()
    const restored = documentContent(parsed).flatMap((node) => replaceSentinelText(node, sentinels, seen))
    const aligned = restored.length > 0 && sentinels.every((sentinel) => seen.get(sentinel.id) === 1)
    if (!aligned) {
      const reason: ProtectedReason = 'parse-failure'
      fragments.push({ id: unit.id, raw: unit.raw, range: unit.range, display: 'block', reason })
      content.push(protectedBlock(unit.id, unit.raw, reason))
      continue
    }
    fragments.push(...sentinels.map((sentinel) => sentinel.fragment))
    const editable = asEditableNodes({ ...parsed, content: restored }, unit.id)
    content.push(...editable)
    fingerprints.set(unit.id, stableFingerprint(editable))
  }

  return {
    visual: { doc: { type: 'doc', content }, frontmatterInner: '' },
    fragments,
    fingerprints,
    fallbackToSource: false,
  }
}

export function serializeProjectedGroup(nodes: JSONContent[], codec: MarkdownCodec): string {
  const serializedJson = JSON.stringify(nodes)
  const character = markerCharacter(serializedJson)
  const sentinels: Sentinel[] = []
  const onlyNode = nodes.length === 1 ? nodes[0] : undefined
  const onlyInline = onlyNode?.content?.length === 1 ? onlyNode.content[0] : undefined
  const literalHeadingMarker = onlyNode?.type === 'paragraph'
    && onlyInline?.type === 'text'
    && !onlyInline.marks?.length
    && /^#{1,6}$/.test(onlyInline.text ?? '')
  const rewrite = (node: JSONContent): JSONContent => {
    if (node.type === 'protectedSourceInline' || node.type === 'protectedSourceBlock') {
      const id = String(node.attrs?.id ?? '')
      const raw = String(node.attrs?.raw ?? '')
      if (!id || sentinels.some((sentinel) => sentinel.id === id)) {
        throw new Error('Protected source serialization requires unique fragment ids')
      }
      const fragment: ProjectedFragment = {
        id,
        raw,
        range: { from: 0, to: raw.length },
        display: node.type === 'protectedSourceInline' ? 'inline' : 'block',
        reason: (node.attrs?.reason as ProtectedReason) ?? 'raw-html',
      }
      const sentinel = { id, value: `${character}${id}${character}`, fragment }
      sentinels.push(sentinel)
      if (node.type === 'protectedSourceInline') {
        return { type: 'text', text: sentinel.value, ...(node.marks ? { marks: node.marks } : {}) }
      }
      return { type: 'paragraph', content: [{ type: 'text', text: sentinel.value }] }
    }
    return node.content ? { ...node, content: node.content.map(rewrite) } : node
  }
  let output = codec.serialize({ type: 'doc', content: nodes.map(rewrite) })
  if (literalHeadingMarker) output = output.replace(/^#/, '\\#')
  for (const sentinel of sentinels) {
    const count = output.split(sentinel.value).length - 1
    if (count !== 1) throw new Error('Protected source serialization sentinel mismatch')
  }
  if (output.split(character).length - 1 !== sentinels.length * 2) {
    throw new Error('Protected source serialization introduced an unexpected sentinel')
  }
  return sentinels.reduce(
    (current, sentinel) => current.replace(sentinel.value, () => sentinel.fragment.raw),
    output,
  )
}
