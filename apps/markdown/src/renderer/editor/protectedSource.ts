import type { Editor, JSONContent } from '@tiptap/core'
import { Extension, Node } from '@tiptap/core'
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state'
import { closeHistory } from '@tiptap/pm/history'
import { Step } from '@tiptap/pm/transform'
import type { MarkdownDocumentSession } from '../markdown/documentSession'
import { SourceSnapshotStep, sourceSnapshotPairFromTransaction } from '../markdown/sourceHistory'

export interface ProtectedChangeRequest {
  ids: string[]
  kind: 'delete' | 'cut' | 'replace'
  baseDoc: JSONContent
  steps: unknown[]
}

export interface ProtectedSourceOptions {
  onEditSource(id: string): void
  onConvert(id: string): void
  onConfirmChange(request: ProtectedChangeRequest): void
  /** Proposal-only conversion is unavailable until Task 7 wires a publisher. */
  conversionAvailable?: boolean
  getCurrentSource?(): string | undefined
}

export const APPROVED_PROTECTED_CHANGE = 'approvedProtectedChange'

const noopProtectedSourceOptions: ProtectedSourceOptions = {
  onEditSource() {},
  onConvert() {},
  onConfirmChange() {},
  conversionAvailable: false,
}

export interface ProtectedSourceAuthority {
  authorize(transaction: Transaction): void
  revoke(transaction: Transaction): void
  allows(transaction: Transaction, state: EditorState): boolean
  accepts(transaction: Transaction, currentSource?: string): boolean
}

interface ProtectedSourceSignature {
  beforeDoc: unknown
  afterDoc: unknown
  beforeSource?: string
  afterSource?: string
}

interface ProtectedSourceGuardState {
  pending: WeakMap<Transaction, ProtectedSourceSignature>
  accepted?: Transaction
  transitions: TransitionEvent[]
}

/** 一次确认只对应一个可逆事件；append 只补充这个事件的最终端点。 */
interface TransitionEvent {
  root: Transaction
  before: ProtectedSourceSignature
  rootAfter: ProtectedSourceSignature
  finalAfter: ProtectedSourceSignature
}

const MAX_PROTECTED_TRANSITIONS = 128

const protectedSourceGuardKey = new PluginKey<ProtectedSourceGuardState>('protectedSourceGuard')
interface ProtectedSourceFinalization { root: Transaction, source: string }
const protectedSourceFinalizeKey = new PluginKey<ProtectedSourceFinalization>('protectedSourceFinalize')

function transitionKey(signature: ProtectedSourceSignature): string {
  return `${JSON.stringify(signature.beforeDoc)}\u0000${JSON.stringify(signature.afterDoc)}\u0000${signature.beforeSource ?? ''}\u0000${signature.afterSource ?? ''}`
}

function transactionSignature(transaction: Transaction): ProtectedSourceSignature {
  const snapshot = sourceSnapshotPairFromTransaction(transaction)
  return {
    beforeDoc: transaction.before.toJSON(),
    afterDoc: transaction.doc.toJSON(),
    ...(snapshot ? { beforeSource: snapshot.beforeSource, afterSource: snapshot.source } : {}),
  }
}

function sameSignature(left: ProtectedSourceSignature, right: ProtectedSourceSignature): boolean {
  return transitionKey(left) === transitionKey(right)
}

function registerTransition(transitions: TransitionEvent[], event: TransitionEvent): TransitionEvent[] {
  const next = [...transitions.filter((candidate) => candidate.root !== event.root), event]
  return next.slice(-MAX_PROTECTED_TRANSITIONS)
}

function updateTransition(transitions: TransitionEvent[], root: Transaction, finalAfter: ProtectedSourceSignature): TransitionEvent[] {
  return transitions.map((event) => event.root === root ? { ...event, finalAfter } : event)
}

function guardState(state: EditorState): ProtectedSourceGuardState {
  const value = protectedSourceGuardKey.getState(state)
  if (!value) throw new Error('Protected source guard is not installed')
  return value
}

function matchesHistoryEvent(event: TransitionEvent, actual: ProtectedSourceSignature, currentSource?: string): boolean {
  const sourceAware = event.before.beforeSource !== undefined
    || event.rootAfter.afterSource !== undefined
    || event.finalAfter.afterSource !== undefined
  // A source-aware event is never a document-only capability.  Its history
  // step must carry the checked source endpoints as well.
  if (sourceAware && (actual.beforeSource === undefined || actual.afterSource === undefined)) return false
  if (actual.beforeSource === undefined && actual.afterSource === undefined) {
    return sameSignature({ ...event.before, afterDoc: event.rootAfter.afterDoc }, actual)
      || sameSignature({
        beforeDoc: event.finalAfter.afterDoc,
        afterDoc: event.before.beforeDoc,
      }, actual)
  }
  if (currentSource === undefined || actual.beforeSource === undefined || actual.afterSource === undefined) return false
  // Redo carries the root snapshot in its natural direction.  Undo carries
  // its inverse snapshot (root-after -> before), while the live source is the
  // final endpoint after appendTransaction.  Check both independently.
  const redo = currentSource === event.before.beforeSource
    && actual.beforeSource === event.before.beforeSource
    && actual.afterSource === event.rootAfter.afterSource
    && (sameSignature({ ...event.before, afterDoc: event.rootAfter.afterDoc, afterSource: event.rootAfter.afterSource }, actual)
      || sameSignature({ ...event.before, afterDoc: event.finalAfter.afterDoc, afterSource: event.rootAfter.afterSource }, actual))
  const undo = currentSource === event.finalAfter.afterSource
    && sameSignature({
      beforeDoc: event.finalAfter.afterDoc,
      afterDoc: event.before.beforeDoc,
      beforeSource: event.rootAfter.afterSource,
      afterSource: event.before.beforeSource,
    }, actual)
  return redo || undo
}

function trustedAppend(state: ProtectedSourceGuardState, transaction: Transaction): boolean {
  return state.accepted !== undefined && transaction.getMeta('appendedTransaction') === state.accepted
}

function allows(state: ProtectedSourceGuardState, transaction: Transaction, editorState: EditorState, currentSource?: string): boolean {
  const actual = transactionSignature(transaction)
  actual.beforeDoc = editorState.doc.toJSON()
  const pending = state.pending.get(transaction)
  if (pending && sameSignature(pending, actual)) return true
  if (actual.beforeSource !== undefined && currentSource === undefined) return false
  return state.transitions.some((transition) => matchesHistoryEvent(transition, actual, currentSource))
}

/** 每个 EditorState 保存独立的不可公开伪造授权记录。 */
export function protectedSourceAuthority(editor: Editor): ProtectedSourceAuthority {
  return {
    authorize(transaction) {
      guardState(editor.state).pending.set(transaction, transactionSignature(transaction))
    },
    revoke(transaction) {
      guardState(editor.state).pending.delete(transaction)
    },
    allows(transaction, editorState) {
      return allows(guardState(editor.state), transaction, editorState)
    },
    accepts(transaction, currentSource) {
      const state = guardState(editor.state)
      if (state.accepted === transaction) return true
      const actual = transactionSignature(transaction)
      return state.transitions.some((transition) => matchesHistoryEvent(transition, actual, currentSource))
    },
  }
}

/** Record the actual post-dispatch source endpoint for a trusted protected edit.
 * This is intentionally private-authority adjacent; callers never set its meta. */
export function finalizeProtectedSourceTransition(editor: Editor, root: Transaction, source: string | undefined): boolean {
  if (source === undefined || guardState(editor.state).accepted !== root) return false
  editor.view.dispatch(editor.state.tr
    .setMeta(protectedSourceFinalizeKey, { root, source })
    .setMeta('addToHistory', false)
    .setMeta('uiOnly', true))
  const event = guardState(editor.state).transitions.find((candidate) => candidate.root === root)
  return Boolean(event && sameSignature(event.finalAfter, {
    beforeDoc: event.before.beforeDoc,
    afterDoc: editor.state.doc.toJSON(),
    beforeSource: event.before.beforeSource,
    afterSource: source,
  }))
}

const sourceAttr = {
  default: null,
  parseHTML: () => null,
  renderHTML: () => ({}),
  rendered: false,
}

const editableTopLevelBlocks = [
  'paragraph',
  'heading',
  'blockquote',
  'codeBlock',
  'bulletList',
  'orderedList',
  'taskList',
  'table',
  'horizontalRule',
  'blockMath',
]

/** Session-local identity for the editable top-level source unit behind a node. */
export const SourceProvenance = Extension.create({
  name: 'sourceProvenance',

  addGlobalAttributes() {
    return [{ types: editableTopLevelBlocks, attributes: { sourceId: sourceAttr } }]
  },
})

function protectedSourceDOM(attrs: Record<string, unknown>, display: 'inline' | 'block') {
  return ['code', { 'data-protected-source': display }, String(attrs.raw ?? '')] as const
}

type ProtectedRawMultiset = Map<string, Map<string, number>>

function protectedRawMultiset(doc: { descendants(visitor: (node: { type: { name: string }, attrs: Record<string, unknown> }) => void): void }): ProtectedRawMultiset {
  const found: ProtectedRawMultiset = new Map()
  doc.descendants((node) => {
    if (node.type.name !== 'protectedSourceBlock' && node.type.name !== 'protectedSourceInline') return
    const id = String(node.attrs.id ?? '')
    const raw = String(node.attrs.raw ?? '')
    if (!id) return
    const values = found.get(id) ?? new Map<string, number>()
    values.set(raw, (values.get(raw) ?? 0) + 1)
    found.set(id, values)
  })
  return found
}

function sameProtectedRawMultiset(before: ProtectedRawMultiset, after: ProtectedRawMultiset): boolean {
  if (before.size !== after.size) return false
  for (const [id, raws] of before) {
    const candidate = after.get(id)
    if (!candidate || candidate.size !== raws.size) return false
    for (const [raw, count] of raws) if (candidate.get(raw) !== count) return false
  }
  return true
}

function changedProtectedIds(before: ProtectedRawMultiset, after: ProtectedRawMultiset): string[] {
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((id) => !sameProtectedRawMultiset(
      new Map([[id, before.get(id) ?? new Map()]]),
      new Map([[id, after.get(id) ?? new Map()]]),
    ))
}

function protectedChangeKind(
  transaction: { getMeta(name: string): unknown, steps: ReadonlyArray<{ toJSON(): unknown }> },
  before: ProtectedRawMultiset,
  after: ProtectedRawMultiset,
): ProtectedChangeRequest['kind'] {
  if (transaction.getMeta('uiEvent') === 'cut') return 'cut'
  const insertsReplacement = transaction.steps.some((step) => {
    const json = step.toJSON() as { slice?: { content?: unknown[] } }
    return Boolean(json.slice?.content?.length)
  })
  if (insertsReplacement) return 'replace'
  let removed = false
  for (const [id, raws] of before) {
    const next = after.get(id)
    if (!next) {
      removed = true
      continue
    }
    const beforeCount = [...raws.values()].reduce((total, count) => total + count, 0)
    const afterCount = [...next.values()].reduce((total, count) => total + count, 0)
    if (afterCount < beforeCount) {
      removed = true
      continue
    }
    if (afterCount > beforeCount || next.size !== raws.size) return 'replace'
    for (const [raw, count] of raws) {
      const nextCount = next.get(raw)
      if (nextCount === count) continue
      if (nextCount !== undefined && nextCount < count) {
        removed = true
        continue
      }
      return 'replace'
    }
  }
  return removed ? 'delete' : 'replace'
}

/** 基于实时编辑器状态重建已确认操作，绝不派发生成请求时的过期 transaction。 */
export function applyProtectedChange(
  editor: Editor,
  request: ProtectedChangeRequest,
  session?: MarkdownDocumentSession,
): { ok: true } | { ok: false, error: string } {
  if (JSON.stringify(editor.state.doc.toJSON()) !== JSON.stringify(request.baseDoc)) {
    return { ok: false, error: 'Protected change is stale' }
  }
  let authority: ProtectedSourceAuthority | undefined
  let signed: Transaction | undefined
  try {
    editor.view.dispatch(closeHistory(editor.state.tr).setMeta('addToHistory', false).setMeta('uiOnly', true))
    let transaction = editor.state.tr
    for (const step of request.steps) transaction = transaction.step(Step.fromJSON(editor.schema, step as Record<string, unknown>))
    if (session) {
      const beforeSource = session.view().source
      const preview = session.previewApprovedVisual({
        doc: transaction.doc.toJSON(),
        frontmatterInner: session.view().visual.frontmatterInner,
      }, request.ids)
      if (!preview.ok) return { ok: false, error: preview.error }
      const canonical = editor.schema.nodeFromJSON(preview.view.visual.doc)
      if (!transaction.doc.eq(canonical)) {
        transaction = transaction.replaceWith(0, transaction.doc.content.size, canonical.content)
      }
      transaction = transaction.step(new SourceSnapshotStep(beforeSource, preview.view.source))
    }
    transaction = closeHistory(transaction.setMeta(APPROVED_PROTECTED_CHANGE, true).setMeta('addToHistory', true))
    authority = protectedSourceAuthority(editor)
    authority.authorize(transaction)
    signed = transaction
    const expectedSource = sourceSnapshotPairFromTransaction(transaction)?.source
    editor.view.dispatch(transaction)
    if (!authority.accepts(transaction)) {
      return { ok: false, error: 'Protected change was rejected' }
    }
    if (expectedSource !== undefined && !finalizeProtectedSourceTransition(editor, transaction, session?.serialize())) {
      return { ok: false, error: 'Protected change was rejected' }
    }
    editor.view.dispatch(closeHistory(editor.state.tr).setMeta('addToHistory', false).setMeta('uiOnly', true))
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    if (authority && signed) authority.revoke(signed)
  }
}

/** 阻止破坏性受保护源码 transaction，直到调用方显式确认并重建请求。 */
export const ProtectedSourceGuard = Extension.create<ProtectedSourceOptions>({
  name: 'protectedSourceGuard',
  priority: 1000,

  addOptions() {
    return noopProtectedSourceOptions
  },

  addProseMirrorPlugins() {
    const options = this.options
    return [new Plugin({
      key: protectedSourceGuardKey,
      state: {
        init(): ProtectedSourceGuardState {
          return {
            pending: new WeakMap<Transaction, ProtectedSourceSignature>(),
            transitions: [],
          }
        },
        apply(transaction, value, oldState) {
          const finalization = transaction.getMeta(protectedSourceFinalizeKey)
          if (finalization && finalization.root === value.accepted) {
            const event = value.transitions.find((candidate) => candidate.root === finalization.root)
            if (!event) return { ...value, accepted: undefined }
            return {
              ...value,
              transitions: updateTransition(value.transitions, finalization.root, {
                ...event.rootAfter,
                afterDoc: transaction.doc.toJSON(),
                afterSource: finalization.source,
              }),
            }
          }
          if (trustedAppend(value, transaction)) {
            const event = value.transitions.find((candidate) => candidate.root === value.accepted)
            return event && value.accepted
              ? { ...value, transitions: updateTransition(value.transitions, value.accepted, { ...event.finalAfter, afterDoc: transaction.doc.toJSON() }) }
              : { ...value, accepted: undefined }
          }
          if (!allows(value, transaction, oldState)) {
            return { ...value, accepted: undefined }
          }
          const signature = value.pending.get(transaction)
          const transitions = signature
            ? registerTransition(value.transitions, { root: transaction, before: signature, rootAfter: signature, finalAfter: signature })
            : value.transitions
          return { ...value, accepted: signature ? transaction : undefined, transitions }
        },
      },
      props: {
        clipboardTextSerializer(slice) {
          return slice.content.textBetween(0, slice.content.size, '\n\n', (node) => {
            if (node.type.name === 'protectedSourceBlock' || node.type.name === 'protectedSourceInline') {
              return String(node.attrs.raw ?? '')
            }
            if (node.type.name === 'hardBreak') return '\n'
            return node.type.spec.leafText?.(node) ?? ''
          })
        },
      },
      appendTransaction(transactions, _oldState, state) {
        const authority = guardState(state)
        for (const transaction of transactions) {
          const root = transaction.getMeta('appendedTransaction')
          if (!root || authority.accepted !== root) continue
          const rootBefore = protectedRawMultiset(root.doc)
          const appendedAfter = protectedRawMultiset(transaction.doc)
          if (sameProtectedRawMultiset(rootBefore, appendedAfter)) continue
          options.onConfirmChange({
            ids: changedProtectedIds(rootBefore, appendedAfter),
            kind: protectedChangeKind(transaction, rootBefore, appendedAfter),
            baseDoc: root.doc.toJSON(),
            steps: transaction.steps.map((step) => step.toJSON()),
          })
          throw new Error('Protected append exceeds the approved change')
        }
        return null
      },
      filterTransaction(transaction, state) {
        const snapshot = sourceSnapshotPairFromTransaction(transaction)
        const authority = guardState(state)
        if (snapshot && !allows(authority, transaction, state, options.getCurrentSource?.())) return false
        if (trustedAppend(authority, transaction)) {
          const before = protectedRawMultiset(state.doc)
          const after = protectedRawMultiset(transaction.doc)
          if (sameProtectedRawMultiset(before, after)) return true
          options.onConfirmChange({
            ids: changedProtectedIds(before, after),
            kind: protectedChangeKind(transaction, before, after),
            baseDoc: state.doc.toJSON(),
            steps: transaction.steps.map((step) => step.toJSON()),
          })
          // ProseMirror only commits the root after every appended transaction
          // has been filtered. Throwing aborts this applyTransaction batch, so
          // an append cannot widen the root approval before a new confirmation.
          throw new Error('Protected append exceeds the approved change')
        }
        if (!transaction.docChanged) return true
        const before = protectedRawMultiset(state.doc)
        if (before.size === 0) return true
        const after = protectedRawMultiset(transaction.doc)
        if (sameProtectedRawMultiset(before, after)) return true
        if (allows(authority, transaction, state, options.getCurrentSource?.())) return true
        const request: ProtectedChangeRequest = {
          ids: changedProtectedIds(before, after),
          kind: protectedChangeKind(transaction, before, after),
          baseDoc: state.doc.toJSON(),
          steps: transaction.steps.map((step) => step.toJSON()),
        }
        options.onConfirmChange(request)
        // appendTransaction receives this filter call before ProseMirror writes
        // its public appendedTransaction meta.  While a root is pending in the
        // candidate state, reject by throwing so the whole batch is discarded.
        if (authority.accepted !== undefined) throw new Error('Protected append exceeds the approved change')
        return false
      },
    })]
  },
})

/** A raw, non-editable block whose exact markdown must be retained by the session. */
export const ProtectedSourceBlock = Node.create({
  name: 'protectedSourceBlock',
  group: 'block',
  atom: true,
  selectable: true,
  renderText({ node }) {
    return String(node.attrs.raw ?? '')
  },

  addAttributes() {
    return { id: {}, raw: {}, reason: {}, sourceId: sourceAttr }
  },

  renderHTML({ HTMLAttributes }) {
    return protectedSourceDOM(HTMLAttributes, 'block')
  },
})

/** A raw, non-editable inline markdown span whose surrounding content stays editable. */
export const ProtectedSourceInline = Node.create({
  name: 'protectedSourceInline',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  renderText({ node }) {
    return String(node.attrs.raw ?? '')
  },

  addAttributes() {
    return { id: {}, raw: {}, reason: {}, sourceId: sourceAttr }
  },

  renderHTML({ HTMLAttributes }) {
    return protectedSourceDOM(HTMLAttributes, 'inline')
  },
})
