import { expect, test, type Page } from '@playwright/test'

const source = '# 标题\n\n第一段\n第二段\n第三段\n第四段\n第五段\n第六段\n'

async function openSource(page: Page): Promise<void> {
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
    { text: source },
  )
  await page.goto('http://localhost:5177')
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
