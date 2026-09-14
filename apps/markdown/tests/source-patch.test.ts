import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { undo, redo } from '@tiptap/pm/history'
import { buildExtensions } from '../src/renderer/editor/extensions'
import { createMarkdownDocumentSession } from '../src/renderer/markdown/documentSession'
import { createTiptapMarkdownCodec } from '../src/renderer/markdown/sourceProjection'
import { applyConfirmedSourcePatch, replaceEditorBaseline, restoreSourceHistoryTransaction } from '../src/renderer/App'

const editors: Editor[] = []

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy()
})

function createSession(source = '<details>old</details>\n\nSafe\n') {
  const editor = new Editor({
    extensions: buildExtensions({
      slashController: { onOpen() {}, onUpdate() {}, onKeyDown: () => false, onClose() {} },
      slashItems: () => [],
    }),
    content: '',
  })
  editors.push(editor)
  return createMarkdownDocumentSession(source, createTiptapMarkdownCodec(editor))
}

describe('source patch confirmation', () => {
  it('creates a proposal without changing source, revision, or dirty state', () => {
    const session = createSession()
    const before = session.view()
    const fragment = before.protectedFragments[0]!

    const patch = session.proposeFragmentReplacement(fragment.id, '<details>new</details>\n\n')

    expect(patch).toMatchObject({
      origin: 'ai',
      fragmentId: fragment.id,
      expectedRaw: fragment.raw,
      nextRaw: '<details>new</details>\n\n',
      baseRevision: before.revision,
    })
    expect(session.view()).toMatchObject({ source: before.source, revision: before.revision, dirty: false })
  })

  it('confirms only the target raw replacement in one revision', () => {
    const session = createSession('<details>old</details>\n\nKeep\n')
    const fragment = session.view().protectedFragments[0]!
    const patch = session.proposeFragmentReplacement(fragment.id, '<details>new</details>\n\n')

    const applied = session.applyConfirmedPatch(patch)

    expect(applied.ok).toBe(true)
    expect(session.serialize()).toBe('<details>new</details>\n\nKeep\n')
    expect(session.view().revision).toBe(1)
  })

  it.each(['fragment', 'raw', 'revision'] as const)('rejects an expired %s patch without changing source', (kind) => {
    const session = createSession()
    const fragment = session.view().protectedFragments[0]!
    const patch = session.proposeFragmentReplacement(fragment.id, '<details>new</details>\n\n')
    if (kind === 'fragment') patch.fragmentId = 'missing'
    if (kind === 'raw') patch.expectedRaw = '<details>different</details>'
    if (kind === 'revision') patch.baseRevision += 1
    const before = session.serialize()

    const applied = session.applyConfirmedPatch(patch)

    expect(applied).toMatchObject({ ok: false })
    expect(session.serialize()).toBe(before)
  })

  it('confirms through one trusted projection transaction and restores source on undo/redo', () => {
    let session: ReturnType<typeof createMarkdownDocumentSession> | undefined
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: buildExtensions({
        slashController: { onOpen() {}, onUpdate() {}, onKeyDown: () => false, onClose() {} },
        slashItems: () => [],
        protectedSource: { onEditSource() {}, onConvert() {}, onConfirmChange() {}, getCurrentSource: () => session?.serialize() },
      }),
      content: '',
    })
    editors.push(editor)
    session = createMarkdownDocumentSession('<details>old</details>\n\nSafe\n', createTiptapMarkdownCodec(editor))
    replaceEditorBaseline(editor, session.view().visual.doc)
    editor.on('transaction', ({ transaction }) => restoreSourceHistoryTransaction(session, editor, transaction))
    const fragment = session.view().protectedFragments[0]!
    const patch = session.proposeFragmentReplacement(fragment.id, '<details>new</details>\n\n')

    expect(applyConfirmedSourcePatch(editor, session, patch)).toEqual({ ok: true })
    expect(session.serialize()).toBe('<details>new</details>\n\nSafe\n')
    expect(undo(editor.state, editor.view.dispatch)).toBe(true)
    expect(session.serialize()).toBe('<details>old</details>\n\nSafe\n')
    expect(redo(editor.state, editor.view.dispatch)).toBe(true)
    expect(session.serialize()).toBe('<details>new</details>\n\nSafe\n')
  })
})
