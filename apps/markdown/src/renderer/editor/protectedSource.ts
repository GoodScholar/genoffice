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
}

export const APPROVED_PROTECTED_CHANGE = 'approvedProtectedChange'

const noopProtectedSourceOptions: ProtectedSourceOptions = {
  onEditSource() {},
  onConvert() {},
  onConfirmChange() {},
}

export interface ProtectedSourceAuthority {
  authorize(transaction: Transaction): void
  revoke(transaction: Transaction): void
  allows(transaction: Transaction, state: EditorState): boolean
  accepts(transaction: Transaction): boolean
}

interface ProtectedSourceSignature {
  beforeDoc: unknown
  afterDoc: unknown
  beforeSource?: string
  afterSource?: string
}

interface ProtectedSourceGuardState {
  pending: WeakMap<Transaction, ProtectedSourceSignature>
  accepted: WeakSet<Transaction>
  transitions: Set<string>
  sourceTransitions: Set<string>
}

const protectedSourceGuardKey = new PluginKey<ProtectedSourceGuardState>('protectedSourceGuard')
const acceptedProtectedTransactions = new WeakSet<Transaction>()

function transitionKey(signature: ProtectedSourceSignature): string {
  return `${JSON.stringify(signature.beforeDoc)}\u0000${JSON.stringify(signature.afterDoc)}\u0000${signature.beforeSource ?? ''}\u0000${signature.afterSource ?? ''}`
}

function sourceTransitionKey(beforeSource: string, afterSource: string): string {
  return `${beforeSource}\u0000${afterSource}`
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

function guardState(state: EditorState): ProtectedSourceGuardState {
  const value = protectedSourceGuardKey.getState(state)
  if (!value) throw new Error('Protected source guard is not installed')
  return value
}

function allows(state: ProtectedSourceGuardState, transaction: Transaction, editorState: EditorState): boolean {
  const actual = transactionSignature(transaction)
  actual.beforeDoc = editorState.doc.toJSON()
  const pending = state.pending.get(transaction)
  if (pending && sameSignature(pending, actual)) return true
  if (state.transitions.has(transitionKey(actual))) return true
  return actual.beforeSource !== undefined && actual.afterSource !== undefined
    && state.sourceTransitions.has(sourceTransitionKey(actual.beforeSource, actual.afterSource))
}

/** 每个 EditorState 保存独立的不可公开伪造授权记录。 */
export function protectedSourceAuthority(editor: Editor): ProtectedSourceAuthority {
  const state = guardState(editor.state)
  return {
    authorize(transaction) {
      state.pending.set(transaction, transactionSignature(transaction))
    },
    revoke(transaction) {
      state.pending.delete(transaction)
    },
    allows(transaction, editorState) {
      return allows(state, transaction, editorState)
    },
    accepts(transaction) {
      return state.accepted.has(transaction) || acceptedProtectedTransactions.has(transaction)
    },
  }
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
    const authority = protectedSourceAuthority(editor)
    authority.authorize(transaction)
    const expectedSource = sourceSnapshotPairFromTransaction(transaction)?.source
    editor.view.dispatch(transaction)
    if (!authority.accepts(transaction)) {
      authority.revoke(transaction)
      return { ok: false, error: 'Protected change was rejected' }
    }
    if (expectedSource !== undefined && session?.serialize() !== expectedSource) {
      authority.revoke(transaction)
      return { ok: false, error: 'Protected change was rejected' }
    }
    editor.view.dispatch(closeHistory(editor.state.tr).setMeta('addToHistory', false).setMeta('uiOnly', true))
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
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
        init() {
          return {
            pending: new WeakMap<Transaction, ProtectedSourceSignature>(),
            accepted: new WeakSet<Transaction>(),
            transitions: new Set<string>(),
            sourceTransitions: new Set<string>(),
          }
        },
        apply(transaction, value, oldState) {
          if (!allows(value, transaction, oldState)) return value
          value.accepted.add(transaction)
          acceptedProtectedTransactions.add(transaction)
          const signature = value.pending.get(transaction)
          if (signature) {
            value.transitions.add(transitionKey(signature))
            value.transitions.add(transitionKey({
              beforeDoc: signature.afterDoc,
              afterDoc: signature.beforeDoc,
              beforeSource: signature.afterSource,
              afterSource: signature.beforeSource,
            }))
            if (signature.beforeSource !== undefined && signature.afterSource !== undefined) {
              value.sourceTransitions.add(sourceTransitionKey(signature.beforeSource, signature.afterSource))
              value.sourceTransitions.add(sourceTransitionKey(signature.afterSource, signature.beforeSource))
            }
          }
          return value
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
      filterTransaction(transaction, state) {
        const snapshot = sourceSnapshotPairFromTransaction(transaction)
        const authority = guardState(state)
        if (snapshot && !allows(authority, transaction, state)) return false
        if (!transaction.docChanged) return true
        const before = protectedRawMultiset(state.doc)
        if (before.size === 0) return true
        const after = protectedRawMultiset(transaction.doc)
        if (sameProtectedRawMultiset(before, after)) return true
        if (allows(authority, transaction, state)) return true
        options.onConfirmChange({
          ids: changedProtectedIds(before, after),
          kind: protectedChangeKind(transaction, before, after),
          baseDoc: state.doc.toJSON(),
          steps: transaction.steps.map((step) => step.toJSON()),
        })
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
