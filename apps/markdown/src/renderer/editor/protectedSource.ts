import type { Editor, JSONContent } from '@tiptap/core'
import { Extension, Node } from '@tiptap/core'
import { Plugin, type EditorState, type Transaction } from '@tiptap/pm/state'
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
  authority?: ProtectedSourceAuthority
}

export const APPROVED_PROTECTED_CHANGE = 'approvedProtectedChange'

const noopProtectedSourceOptions: ProtectedSourceOptions = {
  onEditSource() {},
  onConvert() {},
  onConfirmChange() {},
}

export interface ProtectedSourceAuthority {
  authorize(transaction: Transaction): void
  allows(transaction: Transaction, state: EditorState): boolean
}

function documentKey(before: unknown, after: unknown, source: string): string {
  return `${JSON.stringify(before)}\u0000${JSON.stringify(after)}\u0000${source}`
}

/** 只向同一编辑器实例签发内部事务与精确历史往返的短期授权。 */
export function createProtectedSourceAuthority(): ProtectedSourceAuthority {
  const direct = new WeakSet<Transaction>()
  const transitions = new Set<string>()
  return {
    authorize(transaction) {
      direct.add(transaction)
      const snapshot = sourceSnapshotPairFromTransaction(transaction)
      transitions.add(documentKey(transaction.before.toJSON(), transaction.doc.toJSON(), snapshot?.source ?? ''))
      transitions.add(documentKey(transaction.doc.toJSON(), transaction.before.toJSON(), snapshot?.beforeSource ?? ''))
    },
    allows(transaction, state) {
      if (direct.has(transaction)) return true
      const snapshot = sourceSnapshotPairFromTransaction(transaction)
      return transitions.has(documentKey(state.doc.toJSON(), transaction.doc.toJSON(), snapshot?.source ?? ''))
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
    if (next.size !== raws.size) return 'replace'
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
    transaction = transaction.setMeta(APPROVED_PROTECTED_CHANGE, true).setMeta('addToHistory', true)
    protectedSourceAuthority(editor).authorize(transaction)
    editor.view.dispatch(transaction)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

interface ProtectedSourceStorage {
  authority: ProtectedSourceAuthority
}

/** 从当前编辑器的受保护扩展获取不透明授权器。 */
export function protectedSourceAuthority(editor: Editor): ProtectedSourceAuthority {
  return ((editor.storage as unknown as { protectedSourceGuard: ProtectedSourceStorage }).protectedSourceGuard).authority
}

/** 阻止破坏性受保护源码 transaction，直到调用方显式确认并重建请求。 */
export const ProtectedSourceGuard = Extension.create<ProtectedSourceOptions>({
  name: 'protectedSourceGuard',
  priority: 1000,

  addOptions() {
    return noopProtectedSourceOptions
  },

  addStorage() {
    return { authority: this.options.authority ?? createProtectedSourceAuthority() }
  },

  addProseMirrorPlugins() {
    const options = this.options
    const authority = this.storage.authority as ProtectedSourceAuthority
    return [new Plugin({
      props: {
        clipboardTextSerializer(slice) {
          return slice.content.textBetween(0, slice.content.size, '\n\n', (node) => {
            if (node.type.name === 'protectedSourceBlock' || node.type.name === 'protectedSourceInline') {
              return String(node.attrs.raw ?? '')
            }
            return node.type.spec.leafText?.(node) ?? ''
          })
        },
      },
      filterTransaction(transaction, state) {
        if (!transaction.docChanged) return true
        const before = protectedRawMultiset(state.doc)
        if (before.size === 0) return true
        const after = protectedRawMultiset(transaction.doc)
        if (sameProtectedRawMultiset(before, after)) return true
        if (authority.allows(transaction, state)) return true
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
