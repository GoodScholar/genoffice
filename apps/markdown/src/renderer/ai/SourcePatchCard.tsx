import { useState } from 'react'
import { t } from '../i18n/locale'
import type { SourcePatch } from '../markdown/sourcePatch'

export interface SourcePatchCardProps {
  patch: SourcePatch
  onConfirm(patch: SourcePatch): { ok: true } | { ok: false; error: string }
  onCancel(): void
}

function lines(raw: string): string[] {
  return raw.split(/\r?\n/)
}

/** Confirmation owns the only transition from an inert proposal to an edit. */
export function SourcePatchCard({ patch, onConfirm, onCancel }: SourcePatchCardProps) {
  const [error, setError] = useState<string | null>(null)
  const before = lines(patch.expectedRaw)
  const after = lines(patch.nextRaw)
  const count = Math.max(before.length, after.length)
  const confirm = () => {
    const result = onConfirm(patch)
    if (!result.ok) setError(result.error === 'fragment-missing' || result.error === 'raw-changed' || result.error === 'revision-changed'
      ? t('protectedChangeStale')
      : result.error)
  }

  return (
    <section className="source-patch-card" aria-label={t('protectedChangeTitle')}>
      <div className="source-patch-title">{t('protectedChangeTitle')}</div>
      <div className="source-patch-fragment">{patch.fragmentId}</div>
      <div className="source-patch-diff" role="table">
        {Array.from({ length: count }, (_, index) => (
          <div className="source-patch-line" role="row" key={index}>
            <code className="source-patch-before" role="cell">{before[index] ?? ''}</code>
            <code className="source-patch-after" role="cell">{after[index] ?? ''}</code>
          </div>
        ))}
      </div>
      {error && <p className="source-patch-error" role="alert">{error}</p>}
      <div className="source-patch-actions">
        <button type="button" onClick={onCancel}>{t('protectedChangeCancel')}</button>
        <button type="button" onClick={confirm}>{t('protectedChangeConfirm')}</button>
      </div>
    </section>
  )
}
