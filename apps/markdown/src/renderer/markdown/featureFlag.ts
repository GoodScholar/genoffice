export function losslessMarkdownEnabled(search: string, isDev: boolean): boolean {
  return isDev && new URLSearchParams(search).get('losslessMarkdown') === '1'
}
