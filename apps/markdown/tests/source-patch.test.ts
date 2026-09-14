import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Editor } from '@tiptap/core'
import { undo, redo } from '@tiptap/pm/history'
import { buildExtensions } from '../src/renderer/editor/extensions'
import { createMarkdownDocumentSession } from '../src/renderer/markdown/documentSession'
import { createTiptapMarkdownCodec } from '../src/renderer/markdown/sourceProjection'
import { applyConfirmedSourcePatch, replaceEditorBaseline, restoreSourceHistoryTransaction } from '../src/renderer/App'
import { SourcePatchCard } from '../src/renderer/ai/SourcePatchCard'

const editors: Editor[] = []
const roots: Array<{ root: Root, host: HTMLDivElement }> = []

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy()
  while (roots.length) {
    const mounted = roots.pop()!
    act(() => mounted.root.unmount())
    mounted.host.remove()
  }
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

  it('rejects a missing fragment without changing source', () => {
    const session = createSession()
    const fragment = session.view().protectedFragments[0]!
    const patch = session.proposeFragmentReplacement(fragment.id, '<details>new</details>\n\n')
    patch.fragmentId = 'missing'
    const before = session.serialize()

    const applied = session.applyConfirmedPatch(patch)

    expect(applied).toMatchObject({ ok: false, error: 'fragment-missing' })
    expect(session.serialize()).toBe(before)
  })

  it('rejects changed raw without changing source', () => {
    const session = createSession()
    const fragment = session.view().protectedFragments[0]!
    const patch = session.proposeFragmentReplacement(fragment.id, '<details>new</details>\n\n')
    patch.expectedRaw = '<details>different</details>'
    const before = session.serialize()

    expect(session.applyConfirmedPatch(patch)).toMatchObject({ ok: false, error: 'raw-changed' })
    expect(session.serialize()).toBe(before)
  })

  it('rejects changed revision without changing source', () => {
    const session = createSession()
    const fragment = session.view().protectedFragments[0]!
    const patch = session.proposeFragmentReplacement(fragment.id, '<details>new</details>\n\n')
    patch.baseRevision += 1
    const before = session.serialize()

    expect(session.applyConfirmedPatch(patch)).toMatchObject({ ok: false, error: 'revision-changed' })
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

  it('exposes current source-backed blocks after source-mode input without normalizing BOM or CRLF', () => {
    const session = createSession('\uFEFF---\r\ntitle: Original\r\n---\r\n\r\nOriginal\r\n')
    const latest = '\uFEFF---\r\ntitle: LATEST\r\n---\r\n\r\nLATEST\r\n'

    session.applySource(latest)

    expect(session.serialize()).toBe(latest)
    expect(session.sourceBlocks()).toEqual(['LATEST\r\n'])
  })

  it('renders a line diff, keeps stale proposals visible, and separates confirm from cancel', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    roots.push({ root, host })
    const confirm = vi.fn(() => ({ ok: false as const, error: 'raw-changed' }))
    const cancel = vi.fn()
    const patch = {
      id: 'p1', origin: 'ai' as const, fragmentId: 'html-1', expectedRaw: 'old one\nold two', nextRaw: 'new one\nnew two', baseRevision: 0,
    }

    act(() => root.render(createElement(SourcePatchCard, { patch, onConfirm: confirm, onCancel: cancel })))
    expect(host.querySelectorAll('.source-patch-line')).toHaveLength(2)
    expect(host.textContent).toContain('old one')
    expect(host.textContent).toContain('new two')
    const buttons = host.querySelectorAll('button')
    act(() => buttons[1]!.click())
    expect(confirm).toHaveBeenCalledWith(patch)
    expect(host.querySelector('.source-patch-card')).not.toBeNull()
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('重新生成')
    act(() => buttons[0]!.click())
    expect(cancel).toHaveBeenCalledOnce()
  })
})
