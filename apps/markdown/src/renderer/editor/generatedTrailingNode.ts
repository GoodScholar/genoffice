import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import {
  GENERATED_TRAILING_NODE_SOURCE_ID,
  USER_TRAILING_EMPTY_PARAGRAPH_SOURCE_ID,
} from '../markdown/generatedTrailingNode'

export const GENERATED_TRAILING_NODE_META = 'genofficeGeneratedTrailingNode'

/**
 * StarterKit's trailing node has no durable provenance. This plugin writes a
 * reserved sourceId on the paragraph it appends so the session can ignore only
 * that unchanged, generated tail.
 */
export const GeneratedTrailingNode = Extension.create({
  name: 'generatedTrailingNode',

  addProseMirrorPlugins() {
    const plugin = new PluginKey(this.name)
    return [
      new Plugin({
        key: plugin,
        state: {
          init: (_, state) => state.tr.doc.lastChild?.type.name !== 'paragraph',
          apply: (transaction, value) =>
            transaction.docChanged ? transaction.doc.lastChild?.type.name !== 'paragraph' : value,
        },
        appendTransaction: (transactions, _, state) => {
          if (!plugin.getState(state)) return
          const type = state.schema.nodes.paragraph
          if (!type) return
          return state.tr
            .insert(
              state.doc.content.size,
              type.create({ sourceId: GENERATED_TRAILING_NODE_SOURCE_ID }),
            )
            .setMeta(GENERATED_TRAILING_NODE_META, true)
        },
      }),
    ]
  },
})

/** Tags a history-bearing terminal empty paragraph before the session observes it. */
export const UserTrailingEmptyParagraph = Extension.create({
  name: 'userTrailingEmptyParagraph',

  addProseMirrorPlugins() {
    const plugin = new PluginKey(this.name)
    return [
      new Plugin({
        key: plugin,
        appendTransaction: (transactions, oldState, state) => {
          const userEdit = transactions.some(
            (transaction) =>
              transaction.docChanged &&
              transaction.getMeta('addToHistory') !== false &&
              transaction.getMeta('preventUpdate') === undefined &&
              !transaction.getMeta('uiOnly') &&
              !transaction.getMeta('aiDraft') &&
              !transaction.steps.some(
                (step) => step.toJSON().stepType === 'genofficeSourceSnapshot',
              ),
          )
          if (!userEdit) return
          const previousTail = oldState.doc.lastChild
          const last = state.doc.lastChild
          if (
            previousTail?.attrs.sourceId === USER_TRAILING_EMPTY_PARAGRAPH_SOURCE_ID &&
            last?.attrs.sourceId === null
          )
            return
          const previousTailStart = previousTail
            ? oldState.doc.content.size - previousTail.nodeSize
            : -1
          const inheritedSourceId =
            previousTail !== null &&
            last !== null &&
            state.doc.childCount === oldState.doc.childCount + 1 &&
            last.attrs.sourceId === previousTail.attrs.sourceId &&
            previousTailStart <= state.doc.content.size &&
            state.doc.content
              .cut(0, previousTailStart)
              .eq(oldState.doc.content.cut(0, previousTailStart))
          if (
            !last ||
            last.type.name !== 'paragraph' ||
            last.content.size !== 0 ||
            (last.attrs.sourceId !== null && !inheritedSourceId)
          )
            return
          const position = state.doc.content.size - last.nodeSize
          return state.tr
            .setNodeMarkup(position, undefined, {
              ...last.attrs,
              sourceId: USER_TRAILING_EMPTY_PARAGRAPH_SOURCE_ID,
            })
            .setMeta('addToHistory', false)
        },
      }),
    ]
  },
})
