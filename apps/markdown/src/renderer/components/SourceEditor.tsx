import { useLayoutEffect, useRef } from 'react'
import type { SourceRange } from '../markdown/sourceScanner'

export interface SourceEditorProps {
  value: string
  selection?: SourceRange
  disabled?: boolean
  onChange(next: string): void
  onExit(): void
}

function textareaText(source: string): string {
  return source.replace(/\r\n/g, '\n')
}

function textareaOffset(source: string, sourceOffset: number): number {
  return textareaText(source.slice(0, sourceOffset)).length
}

function sourceOffset(source: string, textareaOffset: number): number {
  let sourceIndex = 0
  let textareaIndex = 0
  while (sourceIndex < source.length && textareaIndex < textareaOffset) {
    if (source[sourceIndex] === '\r' && source[sourceIndex + 1] === '\n') sourceIndex += 2
    else sourceIndex += 1
    textareaIndex += 1
  }
  return sourceIndex
}

function sourceForTextareaEdit(source: string, nextTextareaText: string): string {
  const previousTextareaText = textareaText(source)
  let prefix = 0
  while (prefix < previousTextareaText.length && prefix < nextTextareaText.length
    && previousTextareaText[prefix] === nextTextareaText[prefix]) prefix += 1

  let suffix = 0
  while (suffix < previousTextareaText.length - prefix && suffix < nextTextareaText.length - prefix
    && previousTextareaText[previousTextareaText.length - suffix - 1] === nextTextareaText[nextTextareaText.length - suffix - 1]) suffix += 1

  const inserted = nextTextareaText.slice(prefix, nextTextareaText.length - suffix)
  const useCrLfForNewlines = source.includes('\r\n') && !/(^|[^\r])\n/.test(source)
  const sourceInserted = useCrLfForNewlines ? inserted.replace(/\n/g, '\r\n') : inserted
  return source.slice(0, sourceOffset(source, prefix))
    + sourceInserted
    + source.slice(sourceOffset(source, previousTextareaText.length - suffix))
}

/** The lossless editor surface: source text is intentionally passed through without normalization. */
export function SourceEditor({ value, selection, disabled, onChange, onExit }: SourceEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.focus()
    if (selection) textarea.setSelectionRange(textareaOffset(value, selection.from), textareaOffset(value, selection.to))
  }, [value, selection])

  return (
    <textarea
      ref={textareaRef}
      className="source-editor"
      aria-label="Source editor"
      value={value}
      disabled={disabled}
      spellCheck={false}
      onChange={(event) => onChange(sourceForTextareaEdit(value, event.target.value))}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onExit()
      }}
    />
  )
}
