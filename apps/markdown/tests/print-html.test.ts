import { describe, expect, it, vi } from 'vitest'

import { buildPrintHtml } from '../src/renderer/export/printHtml'

// The KaTeX stylesheet is inlined with Vite's `?inline` query; stub it so the
// test asserts the builder's own behavior rather than the bundler's.
vi.mock('katex/dist/katex.min.css?inline', () => ({ default: '' }))

function editorRoot(innerHtml: string): HTMLElement {
  const root = document.createElement('div')
  root.setAttribute('contenteditable', 'true')
  root.innerHTML = innerHtml
  return root
}

function protectedSourceRoot(raw: string, inline = false): HTMLElement {
  const root = document.createElement('div')
  root.setAttribute('contenteditable', 'true')
  const source = document.createElement('div')
  source.className = `protected-source protected-source-${inline ? 'inline' : 'block'}`
  source.setAttribute('data-protected-source', 'raw-html')
  source.setAttribute('onclick', 'throw new Error("must not print")')
  source.tabIndex = 0
  const code = document.createElement('code')
  code.textContent = raw
  if (inline) source.append(code)
  else {
    const pre = document.createElement('pre')
    pre.append(code)
    source.append(pre)
  }
  const reason = document.createElement('span')
  reason.className = 'protected-source-reason'
  reason.textContent = 'Protected source · raw-html'
  const actions = document.createElement('span')
  actions.className = 'protected-source-actions'
  const edit = document.createElement('button')
  edit.textContent = 'Edit source'
  const convert = document.createElement('button')
  convert.textContent = 'Try convert'
  convert.setAttribute('data-protected-convert', '')
  actions.append(edit, convert)
  source.append(reason, actions)
  root.append(source)
  return root
}

describe('buildPrintHtml', () => {
  it('builds a self-contained document with base, title, and styles', () => {
    const html = buildPrintHtml(editorRoot('<h1>Hello</h1><p>World</p>'), 'Notes')
    expect(html).toContain('<!doctype html>')
    expect(html).toContain('<base href="')
    expect(html).toContain('<title>Notes</title>')
    // KaTeX stylesheet plus the print-theme stylesheet.
    expect(html.match(/<style>/g)?.length).toBeGreaterThanOrEqual(2)
    expect(html).toContain('<h1>Hello</h1>')
  })

  it('escapes the document title', () => {
    const html = buildPrintHtml(editorRoot('<p>x</p>'), 'A&B <C>')
    expect(html).toContain('<title>A&amp;B &lt;C></title>')
    expect(html).not.toContain('<title>A&B <C></title>')
  })

  it('strips editor-only chrome from the clone', () => {
    const html = buildPrintHtml(
      editorRoot(
        '<p contenteditable="true">text</p>' +
          '<div class="md-codeblock-bar"><button>copy</button></div>',
      ),
      'Notes',
    )
    expect(html).not.toContain('contenteditable')
    expect(html).not.toContain('md-codeblock-bar')
    expect(html).toContain('<p>text</p>')
  })

  it('prints protected source as inert code without NodeView controls or status', () => {
    const raw =
      '<script>window.pwned = true</script>\n<img src=x onerror="window.pwned = true">\n</style><p>escape</p>'
    const printed = new DOMParser().parseFromString(
      buildPrintHtml(protectedSourceRoot(raw), 'Notes'),
      'text/html',
    )

    expect(printed.body.querySelector('code')?.textContent).toBe(raw)
    expect(printed.body.querySelector('.protected-source-actions')).toBeNull()
    expect(printed.body.querySelector('.protected-source-reason')).toBeNull()
    expect(printed.body.querySelector('button')).toBeNull()
    expect(printed.body.querySelector('script')).toBeNull()
    expect(printed.body.querySelector('img')).toBeNull()
    expect(printed.body.querySelector('p')).toBeNull()
    expect(
      printed.body.querySelector(
        '[onclick], [tabindex], [data-protected-source], [data-protected-convert]',
      ),
    ).toBeNull()
  })

  it('preserves protected inline source whitespace without styling ordinary inline code', () => {
    const raw = 'first line\nsecond line  \t🙂'
    const protectedHtml = buildPrintHtml(protectedSourceRoot(raw, true), 'Notes')
    const regularHtml = buildPrintHtml(
      editorRoot('<p>ordinary <code>inline code</code></p>'),
      'Notes',
    )
    const blockHtml = buildPrintHtml(protectedSourceRoot('block source', false), 'Notes')
    const protectedPrinted = new DOMParser().parseFromString(protectedHtml, 'text/html')
    const regularPrinted = new DOMParser().parseFromString(regularHtml, 'text/html')
    const blockPrinted = new DOMParser().parseFromString(blockHtml, 'text/html')
    const protectedCode = protectedPrinted.body.querySelector('code')

    expect(protectedCode?.textContent).toBe(raw)
    expect(protectedCode?.classList.contains('md-protected-source-inline')).toBe(true)
    expect(
      regularPrinted.body.querySelector('code')?.classList.contains('md-protected-source-inline'),
    ).toBe(false)
    expect(
      blockPrinted.body
        .querySelector('pre > code')
        ?.classList.contains('md-protected-source-inline'),
    ).toBe(false)

    const frame = document.createElement('iframe')
    document.body.append(frame)
    const frameDocument = frame.contentDocument!
    frameDocument.open()
    frameDocument.write(protectedHtml)
    frameDocument.close()
    expect(
      frame.contentWindow!.getComputedStyle(
        frameDocument.body.querySelector('code.md-protected-source-inline')!,
      ).whiteSpace,
    ).toBe('pre-wrap')
    frame.remove()
  })
})
