import { useLayoutEffect, useRef } from 'react'
import type { SourceRange } from '../markdown/sourceScanner'

export interface SourceEditorProps {
  value: string
  selection?: SourceRange
  disabled?: boolean
  onChange(next: string): void
  onExit(): void
}

/** The lossless editor surface: source text is intentionally passed through without normalization. */
export function SourceEditor({ value, selection, disabled, onChange, onExit }: SourceEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.focus()
    if (selection) textarea.setSelectionRange(selection.from, selection.to)
  }, [value, selection?.from, selection?.to])

  return (
    <textarea
      ref={textareaRef}
      className="source-editor"
      aria-label="Source editor"
      value={value}
      disabled={disabled}
      spellCheck={false}
      onChange={(event) => {
        // HTMLTextAreaElement exposes CRLF as LF. Restore the document's existing
        // line ending convention before handing the complete source back to the session.
        const next = value.includes('\r\n')
          ? event.target.value.replace(/\n/g, '\r\n')
          : event.target.value
        onChange(next)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onExit()
      }}
    />
  )
}
