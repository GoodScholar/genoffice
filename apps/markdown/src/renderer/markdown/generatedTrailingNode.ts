/** Provenance reserved for the empty paragraph appended by GeneratedTrailingNode. */
export const GENERATED_TRAILING_NODE_SOURCE_ID = '__genoffice_generated_trailing_node__'
/** Provenance for a user-created empty tail while it has no Markdown body yet. */
export const USER_TRAILING_EMPTY_PARAGRAPH_SOURCE_ID = '__genoffice_user_trailing_empty_paragraph__'

export function isGeneratedTrailingParagraph(
  node: { type?: string; attrs?: Record<string, unknown>; content?: unknown[] } | undefined,
): boolean {
  return (
    node?.type === 'paragraph' &&
    node.attrs?.sourceId === GENERATED_TRAILING_NODE_SOURCE_ID &&
    (node.content?.length ?? 0) === 0
  )
}

export function isUserTrailingEmptyParagraph(
  node: { type?: string; attrs?: Record<string, unknown>; content?: unknown[] } | undefined,
): boolean {
  return (
    node?.type === 'paragraph' &&
    node.attrs?.sourceId === USER_TRAILING_EMPTY_PARAGRAPH_SOURCE_ID &&
    (node.content?.length ?? 0) === 0
  )
}
