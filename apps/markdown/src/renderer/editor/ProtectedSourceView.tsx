import { NodeViewWrapper } from '@tiptap/react'
import type { NodeViewProps } from '@tiptap/react'
import { t } from '../i18n/locale'

export interface ProtectedSourceViewProps extends Pick<NodeViewProps, 'node' | 'editor'> {
  onEditSource(id: string): void
  onConvert(id: string): void
  conversionAvailable?: boolean
}

/** 保留源码 atom 的只读呈现；React 文本子节点会刻意转义原始 HTML。 */
export function ProtectedSourceView({ node, editor, onEditSource, onConvert, conversionAvailable = false }: ProtectedSourceViewProps) {
  const id = String(node.attrs.id ?? '')
  const raw = String(node.attrs.raw ?? '')
  const reason = String(node.attrs.reason ?? '')
  const inline = node.isInline
  const editSource = () => {
    if (editor.isEditable) onEditSource(id)
  }

  return (
    <NodeViewWrapper
      className={`protected-source protected-source-${inline ? 'inline' : 'block'}`}
      contentEditable={false}
      data-protected-source={reason || 'unknown'}
    >
      {inline ? <code>{raw}</code> : <pre><code>{raw}</code></pre>}
      <span className="protected-source-reason">{t('protectedSource')}{reason ? ` · ${reason}` : ''}</span>
      <span className="protected-source-actions">
        <button type="button" onClick={editSource}>{t('editSource')}</button>
        <button
          type="button"
          data-protected-convert
          disabled={!conversionAvailable}
          title={conversionAvailable ? undefined : t('protectedConvertUnavailable')}
          onClick={() => onConvert(id)}
        >
          {t('protectedConvert')}
        </button>
      </span>
    </NodeViewWrapper>
  )
}
