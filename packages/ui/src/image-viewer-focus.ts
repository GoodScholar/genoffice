/**
 * Modal focus handling for the shared ImageViewer. Deliberately viewer-local:
 * the editors' dialogs have their own shared modal helper, and the viewer
 * should not have to wait on (or inherit the crop behaviour of) it.
 *
 * Spread the returned `ref` / `onKeyDown` onto the viewer backdrop: Esc closes
 * (stopped, so it never reaches the editor behind the overlay), Tab cycles
 * inside the backdrop, the control named by `initialFocus` takes focus on open,
 * and focus returns to whatever had it when the viewer opened.
 */
import { useEffect, useRef } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'

const FOCUSABLE = 'button, input, textarea, select, [tabindex]:not([tabindex="-1"])'

export function useImageViewerFocus(onClose: () => void, initialFocus: string) {
  const ref = useRef<HTMLDivElement>(null)
  // The restore target is captured once, on the first commit that has a mounted
  // backdrop. An effect that re-ran would otherwise record the viewer's own
  // control as the "previous" element and restore focus to the closed dialog.
  const restoreTo = useRef<HTMLElement | null>(null)
  const captured = useRef(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (!captured.current) {
      captured.current = true
      if (document.activeElement instanceof HTMLElement) restoreTo.current = document.activeElement
    }
    // an element focused during commit (autoFocus) already counts as "inside"
    if (!el.contains(document.activeElement)) {
      const target = el.querySelector<HTMLElement>(initialFocus)
      ;(target ?? el).focus()
    }
    return () => {
      const previous = restoreTo.current
      if (previous && previous.isConnected) previous.focus()
    }
  }, [initialFocus])

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
      return
    }
    if (e.key === 'Tab') trapTab(ref.current, e)
  }

  return { ref, onKeyDown }
}

/** Cycle Tab / Shift+Tab inside the backdrop so focus cannot walk out. */
function trapTab(container: HTMLElement | null, e: ReactKeyboardEvent): void {
  if (!container) return
  const items = [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => !el.hasAttribute('disabled') && el.tabIndex >= 0,
  )
  if (items.length === 0) {
    e.preventDefault()
    return
  }
  const first = items[0]!
  const last = items[items.length - 1]!
  const active = document.activeElement as HTMLElement | null
  if (e.shiftKey && (active === first || !container.contains(active))) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && active === last) {
    e.preventDefault()
    first.focus()
  }
}
