import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Editor } from '@tiptap/core'
import { expect, test, type Page } from '@playwright/test'

const source = '# 标题\n\n第一段\n第二段\n第三段\n第四段\n第五段\n第六段\n'

async function openSource(page: Page, text = source, visual = false): Promise<void> {
  page.on('pageerror', (error) => console.log('[browser-error]', error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') console.log('[browser-console]', message.text())
  })
  await page.addInitScript(
    ({ text }) => {
      localStorage.setItem('mdapp.showAi', '0')
      const off = () => {}
      window.markdownApi = {
        getLanguage: async () => 'en',
        getTheme: async () => 'light',
        onLanguageChanged: () => off,
        onThemeChanged: () => off,
        getAutoSaveDefault: async () => ({ on: false, updatedAt: 0 }),
        onAutoSaveDefaultChanged: () => off,
        getAiPanelPrefs: async () => ({
          fontSize: 'default',
          customFontSize: 14,
          spellcheck: true,
        }),
        onAiPanelPrefsChanged: () => off,
        consumePending: async () => '/fixtures/polish.md',
        readFile: async () => text,
        consumeHeadlessExport: async () => null,
        headlessExportDone: () => {},
        setDirty: () => {},
        save: async () => ({ ok: false, error: 'not used in renderer coverage' }),
        onSaveRequest: () => off,
        onReadTextRequest: (handler) => {
          window.addEventListener('test:read-source', handler)
          return () => window.removeEventListener('test:read-source', handler)
        },
        sendReadTextResult: (result) =>
          window.dispatchEvent(new CustomEvent('test:read-source-result', { detail: result })),
        sendSaveRequestAck: () => {},
        onCloseSaveRequest: () => off,
        sendCloseSaveResult: () => {},
        onFileRenamed: () => off,
        pickImage: async () => null,
        saveImage: async () => null,
        readImage: async () => null,
        onExportRequest: () => off,
        onPrintRequest: () => off,
        exportDocx: async () => ({ ok: false, error: 'not used in renderer coverage' }),
        exportPdf: async () => ({ ok: false, error: 'not used in renderer coverage' }),
        onChromePressed: () => off,
        onViewImage: () => off,
        getAiSettings: async () => ({ providers: [] }),
        aiGskStatus: async () => ({ loggedIn: false }),
        aiStream: async () => {},
        aiStreamCancel: async () => {},
        onAiStream: () => off,
        webSearch: async () => ({
          results: [],
          method: 'error',
          error: 'not used in renderer coverage',
        }),
        imageSearch: async () => ({
          images: [],
          method: 'error',
          error: 'not used in renderer coverage',
        }),
        fetchImage: async () => null,
        aiGenerateImage: async () => ({ error: 'not used in renderer coverage' }),
      }
    },
    { text },
  )
  await page.goto('http://localhost:5177')
  await expect(page.locator('.doc-editor')).toBeVisible()
  if (visual) return
  await page.locator('.mode-toggle', { hasText: /^Source$/ }).click()
  await expect(page.locator('.source-editor .cm-content')).toBeVisible()
}

test('fold placeholder gives hover feedback and unfolds when clicked', async ({ page }) => {
  await openSource(page)
  await page.locator('.cm-foldGutter span[title="Fold line"]').first().click()
  const placeholder = page.locator('.cm-foldPlaceholder')
  await expect(placeholder).toBeVisible()

  const before = await placeholder.evaluate((node) => {
    const style = getComputedStyle(node)
    return {
      background: style.backgroundColor,
    }
  })
  await placeholder.hover()
  const hoverBackground = await placeholder.evaluate(
    (node) => getComputedStyle(node).backgroundColor,
  )
  expect(hoverBackground).not.toBe(before.background)
  await placeholder.click()
  await expect(placeholder).toHaveCount(0)
})

test('active source row fades when the editor loses focus', async ({ page }) => {
  await openSource(page)
  const line = page.locator('.source-editor .cm-line').nth(2)
  await line.click()
  const focused = await page
    .locator('.source-editor .cm-activeLine')
    .evaluate((node) => getComputedStyle(node).backgroundColor)
  await page.locator('.mode-toggle', { hasText: /^Visual$/ }).focus()
  await expect(page.locator('.source-editor .cm-editor')).not.toHaveClass(/cm-focused/)
  const blurred = await page
    .locator('.source-editor .cm-activeLine')
    .evaluate((node) => getComputedStyle(node).backgroundColor)

  expect(focused).not.toBe(blurred)
})

test('folding and unfolding preserves the source text', async ({ page }) => {
  await openSource(page)
  const content = page.locator('.source-editor .cm-content')
  await content.click()
  await page.locator('.cm-foldGutter span[title="Fold line"]').first().click()
  await expect(page.locator('.cm-foldPlaceholder')).toBeVisible()
  await page.locator('.cm-foldGutter span[title="Unfold line"]:visible').first().click()
  await expect(page.locator('.cm-foldPlaceholder')).toHaveCount(0)
  expect((await content.locator('.cm-line').allTextContents()).join('\n')).toBe(source)
})

for (const size of [127_000, 317_000]) {
  test(`visual typing stays under 100 ms for ${size} bytes`, async ({ page }) => {
    const fixture = readFileSync(resolve(process.cwd(), 'skills/genoffice/SKILL.md'), 'utf8')
    let text = Buffer.from(fixture.repeat(Math.ceil(size / fixture.length)))
      .subarray(0, size)
      .toString('utf8')
      .replace(/\uFFFD$/, '')
    text += ' '.repeat(size - Buffer.byteLength(text))
    await openSource(page, text, true)
    const timings = await page.locator('.doc-editor').evaluate(async (node) => {
      const editor = (node as HTMLElement & { editor: Editor }).editor
      editor.commands.setTextSelection(3)
      const timings: number[] = []
      for (let i = 0; i < 10; i++) {
        const start = performance.now()
        editor.commands.insertContent('x')
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
        timings.push(performance.now() - start)
      }
      return timings
    })
    console.log(
      `${size} bytes, typing through next frame: ${timings.map((value) => value.toFixed(1)).join(', ')} ms`,
    )
    expect(Math.max(...timings)).toBeLessThan(100)
    await expect(page.locator('.source-editor')).toHaveCount(0)
  })
}

test('real Enter and continued typing keep the caret in the split heading and list item', async ({
  page,
}) => {
  await openSource(page, '# Heading text\n\n- List text\n\nLast paragraph.\n', true)
  for (const selector of ['h1', 'li p']) {
    const block = page.locator(`.doc-editor ${selector}`).first()
    await block.click()
    await page.keyboard.press('Home')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.type('X')
    await page.keyboard.press('Enter')
    await page.keyboard.type('Y')
    await expect(page.locator('.doc-editor')).toBeVisible()
    await expect(page.locator('.source-editor')).toHaveCount(0)
    expect(
      await page.locator('.doc-editor').evaluate((node) => {
        const editor = (node as HTMLElement & { editor: Editor }).editor
        return editor.state.selection.$from.parent.textContent
      }),
    ).toContain('Y')
  }
  await page.locator('.mode-toggle', { hasText: /^Source$/ }).click()
  await expect(page.locator('.source-editor .cm-content')).toContainText('Y')
})

test('MCP reads the same lossless source as saving, including source-mode edits', async ({
  page,
}) => {
  const raw = '\uFEFF# Heading\r\n\r\nBefore <u>kept</u> after.\r\n'
  await openSource(page, raw, true)
  const read = () =>
    page.evaluate(
      () =>
        new Promise<{ text?: string }>((resolve) => {
          window.addEventListener(
            'test:read-source-result',
            (event) => resolve((event as CustomEvent).detail),
            { once: true },
          )
          window.dispatchEvent(new Event('test:read-source'))
        }),
    )
  expect(await read()).toEqual({ text: raw })
  await page.locator('.mode-toggle', { hasText: /^Source$/ }).click()
  await page.locator('.source-editor .cm-content').click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type('unsaved source edit')
  expect((await read()).text).toContain('unsaved source edit')
  expect((await read()).text).toContain('<u>kept</u>')
})
