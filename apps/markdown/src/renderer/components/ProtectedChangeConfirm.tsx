import { useState } from 'react'
import type { Editor } from '@tiptap/core'
import { t } from '../i18n/locale'
import { applyProtectedChange, type ProtectedChangeRequest } from '../editor/protectedSource'
import type { MarkdownDocumentSession } from '../markdown/documentSession'

export interface ProtectedChangeConfirmProps {
  editor: Editor
  request: ProtectedChangeRequest
  session?: MarkdownDocumentSession
  onDismiss(): void
}

function changeLabel(kind: ProtectedChangeRequest['kind']): string {
  if (kind === 'cut') return t('protectedChangeCut')
  if (kind === 'replace') return t('protectedChangeReplace')
  return t('protectedChangeDelete')
}

/** 破坏性 atom 操作的确认边界；批准时始终从实时编辑器状态重建 steps。 */
export function ProtectedChangeConfirm({ editor, request, session, onDismiss }: ProtectedChangeConfirmProps) {
  const [error, setError] = useState<string | null>(null)
  const confirm = () => {
    const result = applyProtectedChange(editor, request, session)
    if (result.ok) onDismiss()
    else setError(result.error === 'Protected change is stale' ? t('protectedChangeStale') : result.error)
  }

  return (
    <div className="protected-change-backdrop" role="presentation">
      <section className="protected-change-confirm" role="dialog" aria-modal="true" aria-labelledby="protected-change-title">
        <h2 id="protected-change-title">{t('protectedChangeTitle')}</h2>
        <p>{t('protectedChangeBody', { count: request.ids.length })}</p>
        <p className="protected-change-kind">{changeLabel(request.kind)}</p>
        {error && <p className="protected-change-error" role="alert">{error}</p>}
        <div className="protected-change-buttons">
          <button type="button" data-protected-change-cancel onClick={onDismiss}>{t('protectedChangeCancel')}</button>
          <button type="button" className="protected-change-approve" onClick={confirm}>{t('protectedChangeConfirm')}</button>
        </div>
      </section>
    </div>
  )
}
