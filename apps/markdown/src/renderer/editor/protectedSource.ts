import type { Editor, JSONContent } from '@tiptap/core'
import { Extension, Node } from '@tiptap/core'
import { isHistoryTransaction } from '@tiptap/pm/history'
import { Plugin } from '@tiptap/pm/state'
import { Step } from '@tiptap/pm/transform'

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
  transaction: { getMeta(name: string): unknown },
  before: ProtectedRawMultiset,
  after: ProtectedRawMultiset,
): ProtectedChangeRequest['kind'] {
  if (transaction.getMeta('uiEvent') === 'cut') return 'cut'
  for (const [id, raws] of before) {
    const next = after.get(id)
    if (!next) return 'delete'
    if (next.size !== raws.size) return 'replace'
    for (const [raw, count] of raws) if (next.get(raw) !== count) return 'replace'
  }
  return 'delete'
}

/** 基于实时编辑器状态重建已确认操作，绝不派发生成请求时的过期 transaction。 */
export function applyProtectedChange(editor: Editor, request: ProtectedChangeRequest): { ok: true } | { ok: false, error: string } {
  if (JSON.stringify(editor.state.doc.toJSON()) !== JSON.stringify(request.baseDoc)) {
    return { ok: false, error: 'Protected change is stale' }
  }
  try {
    let transaction = editor.state.tr
    for (const step of request.steps) transaction = transaction.step(Step.fromJSON(editor.schema, step as Record<string, unknown>))
    editor.view.dispatch(transaction.setMeta(APPROVED_PROTECTED_CHANGE, true).setMeta('addToHistory', true))
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
      props: {
        clipboardTextSerializer(slice) {
          const text: string[] = []
          const append = (node: typeof slice.content.firstChild) => {
            if (!node) return
            if (node.type.name === 'protectedSourceBlock' || node.type.name === 'protectedSourceInline') {
              text.push(String(node.attrs.raw ?? ''))
              return
            }
            if (node.isText) {
              text.push(node.text ?? '')
              return
            }
            node.forEach(append)
          }
          slice.content.forEach(append)
          return text.join('')
        },
      },
      filterTransaction(transaction, state) {
        if (!transaction.docChanged || transaction.getMeta('uiOnly') || transaction.getMeta(APPROVED_PROTECTED_CHANGE) || isHistoryTransaction(transaction)) return true
        const before = protectedRawMultiset(state.doc)
        if (before.size === 0) return true
        const after = protectedRawMultiset(transaction.doc)
        if (sameProtectedRawMultiset(before, after)) return true
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

  addAttributes() {
    return { id: {}, raw: {}, reason: {}, sourceId: sourceAttr }
  },

  renderHTML({ HTMLAttributes }) {
    return protectedSourceDOM(HTMLAttributes, 'inline')
  },
})
