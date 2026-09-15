import { Compartment, EditorState, Transaction } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  HighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language'
import { highlightSelectionMatches } from '@codemirror/search'
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
} from '@codemirror/view'
import { tags } from '@lezer/highlight'
import { useLayoutEffect, useRef } from 'react'
import type { SourceRange } from '../markdown/sourceScanner'

export interface SourceEditorProps {
  value: string
  selection?: SourceRange
  disabled?: boolean
  onChange(next: string): void
  onExit(): void
}

/** CodeMirror stores lines as LF; keep the original source as the lossless value. */
function editorText(source: string): string {
  return source.replace(/\r\n/g, '\n')
}

function editorOffset(source: string, sourceOffset: number): number {
  return editorText(source.slice(0, sourceOffset)).length
}

function sourceOffset(source: string, editorOffset: number): number {
  let sourceIndex = 0
  let normalizedIndex = 0
  while (sourceIndex < source.length && normalizedIndex < editorOffset) {
    sourceIndex += source[sourceIndex] === '\r' && source[sourceIndex + 1] === '\n' ? 2 : 1
    normalizedIndex += 1
  }
  return sourceIndex
}

/**
 * Preserve untouched raw bytes by replacing only the changed normalized range.
 * Newlines inherit CRLF only when the complete source uses CRLF.
 */
function sourceForEditorEdit(source: string, nextEditorText: string): string {
  const previousEditorText = editorText(source)
  let prefix = 0
  while (prefix < previousEditorText.length && prefix < nextEditorText.length
    && previousEditorText[prefix] === nextEditorText[prefix]) prefix += 1

  let suffix = 0
  while (suffix < previousEditorText.length - prefix && suffix < nextEditorText.length - prefix
    && previousEditorText[previousEditorText.length - suffix - 1] === nextEditorText[nextEditorText.length - suffix - 1]) suffix += 1

  const inserted = nextEditorText.slice(prefix, nextEditorText.length - suffix)
  const useCrLfForNewlines = source.includes('\r\n') && !/(^|[^\r])\n/.test(source)
  const sourceInserted = useCrLfForNewlines ? inserted.replace(/\n/g, '\r\n') : inserted
  return source.slice(0, sourceOffset(source, prefix))
    + sourceInserted
    + source.slice(sourceOffset(source, previousEditorText.length - suffix))
}

const highlight = HighlightStyle.define([
  { tag: tags.heading, color: 'var(--accent)' },
  { tag: tags.keyword, color: 'var(--accent)' },
  { tag: tags.string, color: 'var(--text-primary)' },
  { tag: tags.url, color: 'var(--md-link)' },
  { tag: tags.comment, color: 'var(--text-secondary)', fontStyle: 'italic' },
  { tag: tags.monospace, color: 'var(--text-primary)' },
])

const theme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'var(--surface)', color: 'var(--text-primary)' },
  '.cm-scroller': {
    fontFamily: "'SF Mono', Menlo, Consolas, monospace",
    fontSize: '14px',
    lineHeight: '1.55',
  },
  '.cm-content': { caretColor: 'var(--text-primary)' },
  '.cm-cursor': { borderLeftColor: 'var(--text-primary)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground': {
    backgroundColor: 'var(--md-selection)',
  },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--hover)' },
  '.cm-gutters': {
    backgroundColor: 'var(--surface)',
    color: 'var(--text-secondary)',
    borderRight: '1px solid var(--border)',
  },
  '.cm-foldPlaceholder': {
    backgroundColor: 'var(--hover)',
    border: '1px solid var(--border)',
    color: 'var(--text-secondary)',
  },
  '.cm-matchingBracket, .cm-selectionMatch': { backgroundColor: 'var(--md-selection)' },
})

/** The lossless source surface: CodeMirror edits a normalized view and writes raw source deltas. */
export function SourceEditor({ value, selection, disabled = false, onChange, onExit }: SourceEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const sourceRef = useRef(value)
  const onChangeRef = useRef(onChange)
  const onExitRef = useRef(onExit)
  const editable = useRef(new Compartment())
  onChangeRef.current = onChange
  onExitRef.current = onExit

  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: editorText(sourceRef.current),
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightSpecialChars(),
          history(),
          foldGutter(),
          drawSelection(),
          indentOnInput(),
          syntaxHighlighting(highlight),
          bracketMatching(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          markdown(),
          EditorView.lineWrapping,
          editable.current.of([EditorState.readOnly.of(disabled), EditorView.editable.of(!disabled)]),
          keymap.of([
            { key: 'Escape', run: () => { onExitRef.current(); return true } },
            ...defaultKeymap,
            ...historyKeymap,
            ...foldKeymap,
          ]),
          theme,
        ],
      }),
      dispatchTransactions: (transactions, editor) => {
        editor.update(transactions)
        if (transactions.some((transaction) => transaction.docChanged && !transaction.annotation(Transaction.remote))) {
          const nextSource = sourceForEditorEdit(sourceRef.current, editor.state.doc.toString())
          sourceRef.current = nextSource
          onChangeRef.current(nextSource)
        }
      },
    })
    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
    }
    // CodeMirror is intentionally constructed once; values flow through the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useLayoutEffect(() => {
    const view = viewRef.current
    if (!view || sourceRef.current === value) return
    sourceRef.current = value
    const nextText = editorText(value)
    if (view.state.doc.toString() !== nextText) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: nextText },
        annotations: [Transaction.remote.of(true), Transaction.addToHistory.of(false)],
      })
    }
  }, [value])

  useLayoutEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({ effects: editable.current.reconfigure([EditorState.readOnly.of(disabled), EditorView.editable.of(!disabled)]) })
  }, [disabled])

  useLayoutEffect(() => {
    const view = viewRef.current
    if (!view) return
    if (selection) {
      const from = editorOffset(value, selection.from)
      view.dispatch({
        selection: { anchor: from, head: editorOffset(value, selection.to) },
        effects: EditorView.scrollIntoView(from, { y: 'center' }),
      })
    }
    view.focus()
  }, [value, selection])

  return <div ref={hostRef} className="source-editor" aria-label="Source editor" />
}
