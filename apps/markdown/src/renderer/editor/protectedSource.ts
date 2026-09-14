import { Extension, Node } from '@tiptap/core'

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
