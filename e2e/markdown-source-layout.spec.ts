import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { launchShell, closeAndSaveVideo, waitForPageWithUrl } from './helpers'

interface SourceGeometry {
  outerOverflow: number
  rootBottomPastWorkspace: number
  gutterHeight: number
  scrollerHeight: number
  innerOverflow: number
  focusOutlineWidth: number
  pageBottomGap: number
}

async function setZoom(page: Page, value: number): Promise<void> {
  await page.locator('.zoom-slider').evaluate((input, next) => {
    input.step = '1'
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setValue.call(input, String(next))
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }, value)
  await expect(page.locator('.zoom-value')).toHaveText(`${value}%`)
}

async function openSource(page: Page): Promise<void> {
  await page.locator('.mode-toggle', { hasText: /^Source$/ }).click()
  await expect(page.locator('.source-editor .cm-content')).toBeVisible()
}

async function sourceGeometry(page: Page): Promise<SourceGeometry> {
  return page.locator('.source-editor').evaluate((host) => {
    const root = host.querySelector<HTMLElement>('.cm-editor')!
    const scroller = host.querySelector<HTMLElement>('.cm-scroller')!
    const gutter = host.querySelector<HTMLElement>('.cm-gutters')!
    const workspace = host.closest<HTMLElement>('.editor-scroll')!
    const rootRect = root.getBoundingClientRect()
    const workspaceRect = workspace.getBoundingClientRect()
    const pageRect = host.closest<HTMLElement>('.doc-page')!.getBoundingClientRect()
    const gutterRect = gutter.getBoundingClientRect()
    return {
      outerOverflow: workspace.scrollHeight - workspace.clientHeight,
      rootBottomPastWorkspace: rootRect.bottom - workspaceRect.bottom,
      gutterHeight: gutterRect.height,
      scrollerHeight: scroller.getBoundingClientRect().height,
      innerOverflow: scroller.scrollHeight - scroller.clientHeight,
      focusOutlineWidth: Number.parseFloat(getComputedStyle(root).outlineWidth),
      pageBottomGap: workspaceRect.bottom - pageRect.bottom,
    }
  })
}

test.describe('markdown source layout', () => {
  for (const zoom of [100, 125]) {
    test(`short source fills a compact ${zoom}% workspace without an outer vertical scrollbar`, async () => {
      const dir = await mkdtemp(join(tmpdir(), 'genoffice-md-source-layout-'))
      const mdPath = join(dir, 'short.md')
      await writeFile(mdPath, '# Short\n\nline one\nline two\nline three\nline four\n')
      const launched = await launchShell({
        onboardingSeen: true,
        videoDir: 'markdown-source-short-layout',
        openFile: mdPath,
      })
      try {
        const editorPage = await waitForPageWithUrl(launched.app, '://markdown/')
        await editorPage.setViewportSize({ width: 900, height: 620 })
        await setZoom(editorPage, zoom)
        await openSource(editorPage)
        await editorPage.locator('.source-editor .cm-content').click()
        const geometry = await sourceGeometry(editorPage)

        expect(geometry.outerOverflow).toBeLessThanOrEqual(1)
        expect(geometry.rootBottomPastWorkspace).toBeLessThanOrEqual(1)
        expect(geometry.gutterHeight).toBeGreaterThanOrEqual(geometry.scrollerHeight - 1)
        expect(geometry.focusOutlineWidth).toBe(0)
        expect(Math.abs(geometry.pageBottomGap)).toBeLessThanOrEqual(1)
      } finally {
        await closeAndSaveVideo(launched, 'markdown-source-short-layout')
      }
    })
  }

  test('a zoomed long source scrolls to its final line without an outer scrollbar', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'genoffice-md-source-layout-'))
    const mdPath = join(dir, 'long.md')
    const lines = Array.from({ length: 320 }, (_, index) => `line ${index + 1}`)
    await writeFile(mdPath, lines.join('\n'))
    const launched = await launchShell({
      onboardingSeen: true,
      videoDir: 'markdown-source-long-layout',
      openFile: mdPath,
    })
    try {
      const editorPage = await waitForPageWithUrl(launched.app, '://markdown/')
      await editorPage.setViewportSize({ width: 1024, height: 680 })
      await setZoom(editorPage, 125)
      await openSource(editorPage)
      const geometry = await sourceGeometry(editorPage)

      expect(geometry.outerOverflow).toBeLessThanOrEqual(1)
      expect(geometry.rootBottomPastWorkspace).toBeLessThanOrEqual(1)
      expect(geometry.gutterHeight).toBeGreaterThanOrEqual(geometry.scrollerHeight - 1)
      expect(geometry.innerOverflow).toBeGreaterThan(0)
      expect(Math.abs(geometry.pageBottomGap)).toBeLessThanOrEqual(1)

      await editorPage.locator('.source-editor .cm-scroller').evaluate((scroller) => {
        scroller.scrollTop = scroller.scrollHeight
      })
      await expect(editorPage.locator('.source-editor .cm-line').last()).toHaveText('line 320')
      const finalLineVisible = await editorPage.locator('.source-editor').evaluate((host) => {
        const scroller = host.querySelector<HTMLElement>('.cm-scroller')!
        const line = host.querySelector<HTMLElement>('.cm-line:last-child')!
        const scrollerRect = scroller.getBoundingClientRect()
        const lineRect = line.getBoundingClientRect()
        return lineRect.top >= scrollerRect.top - 1 && lineRect.bottom <= scrollerRect.bottom + 1
      })
      expect(finalLineVisible).toBe(true)
    } finally {
      await closeAndSaveVideo(launched, 'markdown-source-long-layout')
    }
  })
})
