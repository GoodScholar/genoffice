import type { JSONContent } from '@tiptap/core'
import { frontmatterInner, parseRawDocEnvelope, type RawDocEnvelope } from './docText'
import { projectScan, serializeProjectedGroup, type MarkdownCodec, type ProjectedFragment, type VisualProjection } from './sourceProjection'
import { scanMarkdownSource, type SourceRange } from './sourceScanner'
import { rewriteMarkdownImageSources } from '../../shared/markdown-image-sources'
import { createSourcePatch, validateSourcePatch, type SourcePatch } from './sourcePatch'

export type EditorMode = 'visual' | 'source'

export interface SessionView {
  source: string
  visual: VisualProjection
  protectedFragments: ProjectedFragment[]
  dirty: boolean
  revision: number
  mode: EditorMode
  sourceSelection?: SourceRange
  fallbackReason?: string
}

export type SessionUpdate =
  | { ok: true; view: SessionView; changedRange?: SourceRange }
  | { ok: false; view: SessionView; error: string }

export interface SaveTicket {
  revision: number
  source: string
}

export interface MarkdownDocumentSession {
  view(): SessionView
  sourceBlocks(): readonly string[]
  applyVisual(next: VisualProjection): SessionUpdate
  previewApprovedVisual(next: VisualProjection, protectedIds: readonly string[]): SessionUpdate
  applyVisualWithApprovedFragments(next: VisualProjection, protectedIds: readonly string[]): SessionUpdate
  proposeFragmentReplacement(fragmentId: string, nextRaw: string, origin?: SourcePatch['origin']): SourcePatch
  proposeFragmentConversion(fragmentId: string): SourcePatch
  previewConfirmedPatch(patch: SourcePatch): SessionUpdate
  applyConfirmedPatch(patch: SourcePatch): SessionUpdate
  applySource(next: string): SessionUpdate
  restoreHistorySource(next: string): SessionUpdate
  enterSource(fragmentId?: string): SessionUpdate
  enterVisual(): SessionUpdate
  serialize(): string
  beginSave(): SaveTicket
  markSaved(
    sourceActuallyWritten: string,
    ticket: SaveTicket,
    imageRewrites?: ReadonlyArray<{ from: string, to: string }>,
  ): SessionView
}

interface SourceUnitState {
  sourceId: string
  raw: string
  trailingRaw: string
  range: SourceRange
  fingerprint?: string
  protectedFragments: ProjectedFragment[]
}

interface DocumentState {
  source: string
  envelope: RawDocEnvelope
  units: SourceUnitState[]
  visual: VisualProjection
  fallbackReason?: string
}

interface SaveState {
  revision: number
  source: string
  units: SourceUnitState[]
  envelope: RawDocEnvelope
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function fingerprint(nodes: JSONContent[]): string {
  const withoutSourceIds = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(withoutSourceIds)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key !== 'sourceId')
        .map(([key, child]) => [key, withoutSourceIds(child)]),
    )
  }
  return JSON.stringify(withoutSourceIds(nodes))
}

function projectionFingerprint(nodes: JSONContent[]): string {
  const comparable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(comparable)
    if (!value || typeof value !== 'object') return value
    const record = value as Record<string, unknown>
    const result = Object.fromEntries(
      Object.entries(record)
        .filter(([key]) => key !== 'sourceId')
        .map(([key, child]) => [key, comparable(child)]),
    ) as Record<string, unknown>
    if (typeof record.type === 'string' && record.type.startsWith('protectedSource') && result.attrs && typeof result.attrs === 'object') {
      delete (result.attrs as Record<string, unknown>).id
    }
    if (result.attrs && typeof result.attrs === 'object' && Object.keys(result.attrs as Record<string, unknown>).length === 0) delete result.attrs
    return result
  }
  return JSON.stringify(comparable(nodes))
}

function withoutEmptyParagraphs(nodes: JSONContent[]): JSONContent[] {
  return nodes
    .filter((node) => node.type !== 'paragraph' || (node.content?.length ?? 0) > 0)
    .map((node) => node.content ? { ...node, content: withoutEmptyParagraphs(node.content) } : node)
}

function normaliseEol(value: string, envelope: RawDocEnvelope): string {
  if (envelope.eol === '\n') return value.replace(/\r\n/g, '\n')
  return value.replace(/\r?\n/g, '\r\n')
}

function ensureCanonicalBoundary(value: string, envelope: RawDocEnvelope): string {
  const eol = envelope.eol
  if (value.endsWith(eol + eol)) return value
  return value.endsWith(eol) ? value + eol : value + eol + eol
}

function sourcePrefix(envelope: RawDocEnvelope): string {
  return envelope.bomRaw + envelope.frontmatterRaw
}

function localFragment(fragment: ProjectedFragment, bodyOffset: number): ProjectedFragment {
  return { ...fragment, range: { from: fragment.range.from + bodyOffset, to: fragment.range.to + bodyOffset } }
}

function visualFrontmatter(raw: string): string {
  return frontmatterInner(raw.replace(/\r\n/g, '\n'))
}

function editedFrontmatterRaw(inner: string, envelope: RawDocEnvelope): string {
  const trimmed = inner.replace(/^(?:\r?\n)+|(?:\r?\n)+$/g, '')
  if (trimmed === '') return ''
  const value = normaliseEol(trimmed, envelope)
  return `---${envelope.eol}${value}${envelope.eol}---${envelope.eol}${envelope.eol}`
}

function collectProtected(nodes: JSONContent[]): Map<string, { raw: string, count: number }> {
  const found = new Map<string, { raw: string, count: number }>()
  const visit = (node: JSONContent): void => {
    if (node.type === 'protectedSourceInline' || node.type === 'protectedSourceBlock') {
      const id = typeof node.attrs?.id === 'string' ? node.attrs.id : ''
      const raw = typeof node.attrs?.raw === 'string' ? node.attrs.raw : ''
      if (id) {
        const previous = found.get(id)
        found.set(id, { raw, count: (previous?.count ?? 0) + 1 })
      }
    }
    node.content?.forEach(visit)
  }
  nodes.forEach(visit)
  return found
}

function completeProjectedGroups(visual: VisualProjection): Array<{ sourceId?: string, nodes: JSONContent[] }> {
  const groups: Array<{ sourceId?: string, nodes: JSONContent[] }> = []
  for (const node of visual.doc.content ?? []) {
    const sourceId = typeof node.attrs?.sourceId === 'string' ? node.attrs.sourceId : undefined
    const previous = groups[groups.length - 1]
    if (sourceId && previous?.sourceId === sourceId) previous.nodes.push(node)
    else groups.push({ sourceId, nodes: [node] })
  }
  return groups
}

function rewriteKnownImageSources(raw: string, rewrites: ReadonlyArray<{ from: string, to: string }>): string {
  return rewriteMarkdownImageSources(raw, new Map(rewrites.map(({ from, to }) => [from, to])))
}

function rebaseKnownImageSources(
  current: SourceUnitState,
  original: SourceUnitState,
  actual: SourceUnitState,
  rewrites: ReadonlyArray<{ from: string, to: string }> | undefined,
): SourceUnitState | undefined {
  if (!rewrites?.length || original.trailingRaw !== actual.trailingRaw) return undefined
  if (rewriteKnownImageSources(original.raw, rewrites) !== actual.raw) return undefined
  const raw = rewriteKnownImageSources(current.raw, rewrites)
  return raw === current.raw ? undefined : { ...current, raw }
}

function withFreshRanges(state: DocumentState): DocumentState {
  const visual = { ...state.visual, frontmatterInner: visualFrontmatter(state.envelope.frontmatterRaw) }
  return { ...state, visual }
}

function createState(source: string, codec: MarkdownCodec): DocumentState {
  const envelope = parseRawDocEnvelope(source)
  const scan = scanMarkdownSource(envelope.bodyRaw, codec.lex)
  if (scan.fallbackToSource) {
    return withFreshRanges({
      source,
      envelope,
      units: [],
      visual: { doc: { type: 'doc', content: [] }, frontmatterInner: '' },
      fallbackReason: scan.error ?? 'Unable to project source safely',
    })
  }

  const projection = projectScan(scan, codec)
  if (projection.fallbackToSource) {
    return withFreshRanges({
      source,
      envelope,
      units: [],
      visual: projection.visual,
      fallbackReason: 'Unable to project source safely',
    })
  }

  const units = scan.units.map((unit) => ({
    sourceId: unit.id,
    raw: unit.raw,
    trailingRaw: unit.trailingRaw,
    range: unit.range,
    fingerprint: projection.fingerprints.get(unit.id) ?? fingerprint((projection.visual.doc.content ?? []).filter((node) => node.attrs?.sourceId === unit.id)),
    protectedFragments: projection.fragments.filter((fragment) => fragment.id === unit.id || fragment.id.startsWith(`${unit.id}-i`)),
  }))
  return withFreshRanges({ source, envelope, units, visual: projection.visual })
}

function unitText(unit: SourceUnitState): string {
  return unit.raw + unit.trailingRaw
}

function validateState(state: DocumentState): void {
  if (state.units.length === 0) {
    if (state.source !== sourcePrefix(state.envelope) + state.envelope.bodyRaw) throw new Error('Document session source envelope is inconsistent')
    return
  }
  let cursor = 0
  let body = ''
  for (const unit of state.units) {
    if (unit.range.from !== cursor || unit.range.to !== cursor + unit.raw.length) {
      throw new Error('Document session unit ranges are inconsistent')
    }
    body += unitText(unit)
    cursor = unit.range.to + unit.trailingRaw.length
  }
  if (body !== state.envelope.bodyRaw || state.source !== sourcePrefix(state.envelope) + body) {
    throw new Error('Document session source concatenation is inconsistent')
  }
}

function changedRange(source: string): SourceRange {
  return { from: 0, to: source.length }
}

function snapshotUnits(units: SourceUnitState[]): SourceUnitState[] {
  return units.map((unit) => ({ ...unit, range: { ...unit.range }, protectedFragments: clone(unit.protectedFragments) }))
}

function alignUnits(snapshot: SourceUnitState[], target: SourceUnitState[]): Array<SourceUnitState | undefined> {
  const score = Array.from({ length: snapshot.length + 1 }, () => Array<number>(target.length + 1).fill(0))
  for (let sourceIndex = snapshot.length - 1; sourceIndex >= 0; sourceIndex -= 1) {
    for (let targetIndex = target.length - 1; targetIndex >= 0; targetIndex -= 1) {
      score[sourceIndex]![targetIndex] = unitText(snapshot[sourceIndex]!) === unitText(target[targetIndex]!)
        ? 1 + score[sourceIndex + 1]![targetIndex + 1]!
        : Math.max(score[sourceIndex + 1]![targetIndex]!, score[sourceIndex]![targetIndex + 1]!)
    }
  }

  const aligned: Array<SourceUnitState | undefined> = Array(snapshot.length)
  const anchors: Array<{ sourceIndex: number, targetIndex: number }> = []
  let sourceIndex = 0
  let targetIndex = 0
  while (sourceIndex < snapshot.length && targetIndex < target.length) {
    if (unitText(snapshot[sourceIndex]!) === unitText(target[targetIndex]!)
      && score[sourceIndex]![targetIndex] === 1 + score[sourceIndex + 1]![targetIndex + 1]!) {
      aligned[sourceIndex] = target[targetIndex]
      anchors.push({ sourceIndex, targetIndex })
      sourceIndex += 1
      targetIndex += 1
    } else if (score[sourceIndex + 1]![targetIndex]! >= score[sourceIndex]![targetIndex + 1]!) {
      sourceIndex += 1
    } else {
      targetIndex += 1
    }
  }

  const boundaries = [{ sourceIndex: -1, targetIndex: -1 }, ...anchors, { sourceIndex: snapshot.length, targetIndex: target.length }]
  for (let boundaryIndex = 0; boundaryIndex < boundaries.length - 1; boundaryIndex += 1) {
    const left = boundaries[boundaryIndex]!
    const right = boundaries[boundaryIndex + 1]!
    const sourceCount = right.sourceIndex - left.sourceIndex - 1
    const targetCount = right.targetIndex - left.targetIndex - 1
    if (sourceCount !== targetCount) continue
    for (let offset = 0; offset < sourceCount; offset += 1) {
      aligned[left.sourceIndex + offset + 1] = target[left.targetIndex + offset + 1]
    }
  }
  return aligned
}

function hasAmbiguousDuplicateDeletion(snapshot: SourceUnitState[], target: SourceUnitState[]): boolean {
  const snapshotCounts = new Map<string, number>()
  const targetCounts = new Map<string, number>()
  snapshot.forEach((unit) => snapshotCounts.set(unit.raw, (snapshotCounts.get(unit.raw) ?? 0) + 1))
  target.forEach((unit) => targetCounts.set(unit.raw, (targetCounts.get(unit.raw) ?? 0) + 1))
  return [...snapshotCounts].some(([raw, count]) => count > 1 && (targetCounts.get(raw) ?? 0) < count)
}

export function createMarkdownDocumentSession(source: string, codec: MarkdownCodec): MarkdownDocumentSession {
  let state = createState(source, codec)
  let baseline = source
  let revision = 0
  let mode: EditorMode = state.fallbackReason ? 'source' : 'visual'
  let selection: SourceRange | undefined
  let tickets = new WeakMap<SaveTicket, SaveState>()
  let conflictReason: string | undefined

  const currentView = (): SessionView => ({
    source: state.source,
    visual: clone(state.visual),
    protectedFragments: state.units.flatMap((unit) => unit.protectedFragments.map((fragment) => localFragment(fragment, state.envelope.bodyOffset))),
    dirty: state.source !== baseline,
    revision,
    mode,
    ...(selection ? { sourceSelection: { ...selection } } : {}),
    ...((conflictReason ?? state.fallbackReason) ? { fallbackReason: conflictReason ?? state.fallbackReason } : {}),
  })

  const sourceBlocks = (): readonly string[] => state.units.length > 0
    ? state.units.map(unitText)
    : state.envelope.bodyRaw === '' ? [] : [state.envelope.bodyRaw]

  const success = (range?: SourceRange): SessionUpdate => ({ ok: true, view: currentView(), ...(range ? { changedRange: range } : {}) })

  const applyVisual = (next: VisualProjection, approvedIds = new Set<string>()): SessionUpdate => {
    if (state.fallbackReason) return { ok: false, view: currentView(), error: state.fallbackReason }
    const frontmatterChanged = next.frontmatterInner !== state.visual.frontmatterInner
    const candidateNodes = next.doc.content ?? []
    const expected = new Map(state.units.flatMap((unit) => unit.protectedFragments.map((fragment) => [fragment.id, fragment.raw] as const)))
    const found = collectProtected(candidateNodes)
    for (const [id, raw] of expected) {
      const candidate = found.get(id)
      if (!candidate || candidate.count !== 1 || candidate.raw !== raw) {
        if (approvedIds.has(id)) continue
        return { ok: false, view: currentView(), error: `Protected source fragment ${id} requires confirmation` }
      }
    }
    for (const id of found.keys()) {
      if (!expected.has(id)) return { ok: false, view: currentView(), error: `Unknown protected source fragment ${id}` }
    }

    const blockReplacements = state.units
      .flatMap((unit) => unit.protectedFragments.map((fragment) => ({ unit, fragment })))
      .flatMap(({ unit, fragment }) => {
        const candidate = found.get(fragment.id)
        return fragment.display === 'block' && approvedIds.has(fragment.id) && candidate?.count === 1 && candidate.raw !== fragment.raw
          ? [{ unit, fragment, raw: candidate.raw }]
          : []
      })
    if (blockReplacements.length > 0) {
      let nextSource = state.source
      for (const replacement of [...blockReplacements].sort((left, right) => right.unit.range.from - left.unit.range.from)) {
        const from = state.envelope.bodyOffset + replacement.unit.range.from
        const to = from + replacement.fragment.raw.length
        nextSource = `${nextSource.slice(0, from)}${replacement.raw}${nextSource.slice(to)}`
      }
      const projected = createState(nextSource, codec)
      const projectedNodes = projected.visual.doc.content ?? []
      const sameProjection = projectionFingerprint(candidateNodes) === projectionFingerprint(projectedNodes)
        || projectionFingerprint(withoutEmptyParagraphs(candidateNodes)) === projectionFingerprint(withoutEmptyParagraphs(projectedNodes))
      if (!projected.fallbackReason && sameProjection) {
        state = projected
        revision += 1
        mode = state.fallbackReason ? 'source' : 'visual'
        selection = undefined
        conflictReason = undefined
        return success(changedRange(nextSource))
      }
    }

    const previousById = new Map(state.units.map((unit) => [unit.sourceId, unit]))
    const originalIndex = new Map(state.units.map((unit, index) => [unit.sourceId, index]))
    const groups = completeProjectedGroups(next)
    const used = new Set<string>()
    const pieces: string[] = []
    try {
      for (let index = 0; index < groups.length; index += 1) {
        const group = groups[index]!
        const previous = group.sourceId ? previousById.get(group.sourceId) : undefined
        if (index > 0) {
          const priorId = groups[index - 1]!.sourceId
          const priorIndex = priorId ? originalIndex.get(priorId) : undefined
          const currentIndex = group.sourceId ? originalIndex.get(group.sourceId) : undefined
          if (priorIndex === undefined || currentIndex !== priorIndex + 1) {
            const last = pieces.length - 1
            pieces[last] = ensureCanonicalBoundary(pieces[last]!, state.envelope)
          }
        }
        const canReuse = !!previous && !used.has(previous.sourceId) && previous.fingerprint === fingerprint(group.nodes)
        if (canReuse) {
          used.add(previous!.sourceId)
          pieces.push(unitText(previous!))
          continue
        }

        let serialized = normaliseEol(serializeProjectedGroup(group.nodes, codec), state.envelope)
        if (previous) {
          if (previous.raw.endsWith('\n') && !serialized.endsWith('\n')) serialized += state.envelope.eol
          if (!previous.raw.endsWith('\n')) serialized = serialized.replace(/(?:\r?\n)+$/, '')
          serialized += previous.trailingRaw
        }
        if (!previous && index < groups.length - 1) serialized = ensureCanonicalBoundary(serialized, state.envelope)
        pieces.push(serialized)
      }
    } catch (error) {
      return { ok: false, view: currentView(), error: error instanceof Error ? error.message : String(error) }
    }

    let body = pieces.join('')
    if (state.envelope.trailingNewline) {
      if (body !== '' && !body.endsWith('\n')) body += state.envelope.eol
    } else {
      body = body.replace(/(?:\r?\n)+$/, '')
    }
    const envelope = frontmatterChanged
      ? { ...state.envelope, frontmatterRaw: editedFrontmatterRaw(next.frontmatterInner, state.envelope) }
      : state.envelope
    const nextSource = sourcePrefix(envelope) + body
    if (nextSource === state.source) return success()
    const projected = createState(nextSource, codec)
    const projectedNodes = projected.visual.doc.content ?? []
    const sameProjection = projectionFingerprint(candidateNodes) === projectionFingerprint(projectedNodes)
      || (approvedIds.size > 0 && projectionFingerprint(withoutEmptyParagraphs(candidateNodes)) === projectionFingerprint(withoutEmptyParagraphs(projectedNodes)))
    if (projected.fallbackReason || !sameProjection) {
      return { ok: false, view: currentView(), error: 'Visual projection cannot be represented by a safe source rewrite' }
    }
    state = projected
    revision += 1
    mode = state.fallbackReason ? 'source' : 'visual'
    selection = undefined
    conflictReason = undefined
    return success(changedRange(nextSource))
  }

  const previewApprovedVisual = (next: VisualProjection, protectedIds: readonly string[]): SessionUpdate => {
    const preview = createMarkdownDocumentSession(state.source, codec)
    return preview.applyVisualWithApprovedFragments(next, protectedIds)
  }

  const applyVisualWithApprovedFragments = (next: VisualProjection, protectedIds: readonly string[]): SessionUpdate => {
    return applyVisual(next, new Set(protectedIds))
  }

  const proposeFragmentReplacement = (
    fragmentId: string,
    nextRaw: string,
    origin: SourcePatch['origin'] = 'ai',
  ): SourcePatch => {
    const fragment = currentView().protectedFragments.find((candidate) => candidate.id === fragmentId)
    if (!fragment) throw new Error(`Protected source fragment ${fragmentId} does not exist`)
    return createSourcePatch(origin, fragmentId, fragment.raw, nextRaw, revision)
  }

  const proposeFragmentConversion = (fragmentId: string): SourcePatch => {
    const fragment = currentView().protectedFragments.find((candidate) => candidate.id === fragmentId)
    if (!fragment) throw new Error(`Protected source fragment ${fragmentId} does not exist`)
    let nextRaw: string
    try {
      nextRaw = codec.serialize(codec.parse(fragment.raw))
    } catch (error) {
      throw new Error(`Unable to convert protected source: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!nextRaw || nextRaw === fragment.raw) throw new Error('Unable to convert protected source safely')
    return createSourcePatch('conversion', fragmentId, fragment.raw, nextRaw, revision)
  }

  const previewConfirmedPatch = (patch: SourcePatch): SessionUpdate => {
    const view = currentView()
    const validation = validateSourcePatch(patch, revision, view.protectedFragments)
    if (!validation.ok) return { ok: false, view, error: validation.error }
    const fragment = view.protectedFragments.find((candidate) => candidate.id === patch.fragmentId)
    if (!fragment || state.source.slice(fragment.range.from, fragment.range.to) !== patch.expectedRaw) {
      return { ok: false, view, error: 'raw-changed' }
    }
    const nextSource = `${state.source.slice(0, fragment.range.from)}${patch.nextRaw}${state.source.slice(fragment.range.to)}`
    const preview = createMarkdownDocumentSession(nextSource, codec).view()
    return {
      ok: true,
      view: { ...preview, revision: revision + 1, mode, dirty: nextSource !== baseline },
      changedRange: { from: fragment.range.from, to: fragment.range.from + patch.nextRaw.length },
    }
  }

  const applyConfirmedPatch = (patch: SourcePatch): SessionUpdate => {
    const view = currentView()
    const validation = validateSourcePatch(patch, revision, view.protectedFragments)
    if (!validation.ok) return { ok: false, view, error: validation.error }
    const fragment = view.protectedFragments.find((candidate) => candidate.id === patch.fragmentId)
    if (!fragment || state.source.slice(fragment.range.from, fragment.range.to) !== patch.expectedRaw) {
      return { ok: false, view: currentView(), error: 'raw-changed' }
    }
    const nextSource = `${state.source.slice(0, fragment.range.from)}${patch.nextRaw}${state.source.slice(fragment.range.to)}`
    let next: DocumentState
    try {
      next = createState(nextSource, codec)
      validateState(next)
    } catch (error) {
      return { ok: false, view: currentView(), error: error instanceof Error ? error.message : String(error) }
    }
    state = next
    revision += 1
    mode = state.fallbackReason ? 'source' : mode
    selection = undefined
    conflictReason = undefined
    return success({ from: fragment.range.from, to: fragment.range.from + patch.nextRaw.length })
  }

  const applySource = (next: string): SessionUpdate => {
    if (next !== state.source) {
      state = createState(next, codec)
      revision += 1
      conflictReason = undefined
    }
    mode = 'source'
    selection = undefined
    if (state.fallbackReason) return { ok: false, view: currentView(), error: state.fallbackReason }
    return success(changedRange(next))
  }

  const restoreHistorySource = (next: string): SessionUpdate => {
    state = createState(next, codec)
    revision += 1
    mode = state.fallbackReason ? 'source' : 'visual'
    selection = undefined
    conflictReason = undefined
    if (state.fallbackReason) return { ok: false, view: currentView(), error: state.fallbackReason }
    return success(changedRange(next))
  }

  const enterSource = (fragmentId?: string): SessionUpdate => {
    mode = 'source'
    selection = fragmentId
      ? currentView().protectedFragments.find((fragment) => fragment.id === fragmentId)?.range
      : undefined
    return success(selection)
  }

  const enterVisual = (): SessionUpdate => {
    if (state.fallbackReason) return { ok: false, view: currentView(), error: state.fallbackReason }
    mode = 'visual'
    selection = undefined
    return success()
  }

  const serialize = (): string => {
    validateState(state)
    return state.source
  }

  const beginSave = (): SaveTicket => {
    const ticket = { revision, source: serialize() }
    tickets.set(ticket, { revision, source: ticket.source, units: snapshotUnits(state.units), envelope: { ...state.envelope } })
    return ticket
  }

  const markSaved = (
    sourceActuallyWritten: string,
    ticket: SaveTicket,
    imageRewrites?: ReadonlyArray<{ from: string, to: string }>,
  ): SessionView => {
    const saved = tickets.get(ticket)
    if (!saved || saved.revision !== ticket.revision || saved.source !== ticket.source) throw new Error('Invalid save ticket')
    tickets.delete(ticket)
    if (revision === ticket.revision) {
      state = createState(sourceActuallyWritten, codec)
      baseline = sourceActuallyWritten
      mode = state.fallbackReason ? 'source' : mode
      selection = undefined
      conflictReason = undefined
      return currentView()
    }

    const written = createState(sourceActuallyWritten, codec)
    if (written.fallbackReason || state.fallbackReason) {
      baseline = sourceActuallyWritten
      return currentView()
    }
    if (hasAmbiguousDuplicateDeletion(saved.units, state.units)) {
      baseline = sourceActuallyWritten
      conflictReason = 'rebase conflict: duplicate source units cannot be aligned safely'
      return currentView()
    }
    const currentAligned = alignUnits(saved.units, state.units)
    const writtenAligned = alignUnits(saved.units, written.units)
    let hasConflict = false
    const movedDescendants = new Set<SourceUnitState>()
    const rawCounts = new Map<string, number>()
    saved.units.forEach((unit) => rawCounts.set(unit.raw, (rawCounts.get(unit.raw) ?? 0) + 1))
    const occupied = new Set(currentAligned.filter((unit): unit is SourceUnitState => unit !== undefined))
    for (let ticketIndex = 0; ticketIndex < saved.units.length; ticketIndex += 1) {
      const original = saved.units[ticketIndex]!
      const actual = writtenAligned[ticketIndex]
      if (currentAligned[ticketIndex] || !actual || unitText(actual) === unitText(original)) continue
      const candidates = state.units.filter((unit) => !occupied.has(unit) && unit.raw === original.raw && unit.fingerprint === original.fingerprint)
      if ((rawCounts.get(original.raw) ?? 0) > 1 || candidates.length !== 1) {
        hasConflict = true
        continue
      }
      const candidate = candidates[0]!
      currentAligned[ticketIndex] = candidate
      occupied.add(candidate)
      if (candidate.sourceId !== original.sourceId) movedDescendants.add(candidate)
    }
    const ticketIndexByCurrent = new Map<SourceUnitState, number>()
    currentAligned.forEach((unit, index) => {
      if (unit) ticketIndexByCurrent.set(unit, index)
    })
    const rebased = state.units.flatMap((unit) => {
      const ticketIndex = ticketIndexByCurrent.get(unit)
      if (ticketIndex === undefined) return [unit]
      const original = saved.units[ticketIndex]!
      const actual = writtenAligned[ticketIndex]
      const userChanged = movedDescendants.has(unit)
        ? unit.raw !== original.raw || unit.fingerprint !== original.fingerprint
        : unitText(unit) !== unitText(original)
      if (!actual) return userChanged ? [unit] : []
      const mainChanged = unitText(actual) !== unitText(original)
      if (userChanged && mainChanged) {
        const imageRebased = rebaseKnownImageSources(unit, original, actual, imageRewrites)
        if (imageRebased) return [imageRebased]
        hasConflict = true
      }
      return [userChanged ? unit : actual]
    })
    const body = rebased.map(unitText).join('')
    const userChangedEnvelope = sourcePrefix(state.envelope) !== sourcePrefix(saved.envelope)
    const mainChangedEnvelope = sourcePrefix(written.envelope) !== sourcePrefix(saved.envelope)
    if (userChangedEnvelope && mainChangedEnvelope && sourcePrefix(state.envelope) !== sourcePrefix(written.envelope)) hasConflict = true
    const envelope = userChangedEnvelope ? state.envelope : written.envelope
    const rebasedSource = sourcePrefix(envelope) + body
    state = createState(rebasedSource, codec)
    baseline = sourceActuallyWritten
    conflictReason = hasConflict ? 'rebase conflict: user and save result changed the same source unit' : undefined
    return currentView()
  }

  return {
    view: currentView,
    sourceBlocks,
    applyVisual,
    previewApprovedVisual,
    applyVisualWithApprovedFragments,
    proposeFragmentReplacement,
    proposeFragmentConversion,
    previewConfirmedPatch,
    applyConfirmedPatch,
    applySource,
    restoreHistorySource,
    enterSource,
    enterVisual,
    serialize,
    beginSave,
    markSaved,
  }
}
