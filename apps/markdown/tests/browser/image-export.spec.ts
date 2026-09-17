import { expect, test } from '@playwright/test'
import { PDFDocument } from 'pdf-lib'
import { openSource } from './helpers'

for (const canceled of [true, false]) {
  test(`PNG export ${canceled ? 'cancellation creates no output' : 'write failure aborts partial output and reports an error'}`, async ({
    page,
  }) => {
    const pdf = await PDFDocument.create()
    for (let i = 0; i < 2; i++)
      pdf.addPage([120, 120]).drawRectangle({ x: 10, y: 10, width: 80, height: 80 })
    const pdfBase64 = Buffer.from(await pdf.save()).toString('base64')
    await openSource(page, false, false, '# Export\n')
    await page.evaluate(
      ({ canceled, pdfBase64 }) => {
        window.markdownApi.prepareImageExport = async () => {
          document.body.dataset.picked = 'true'
          return canceled ? { ok: true, canceled: true } : { ok: true, id: 'fixture', pdfBase64 }
        }
        window.markdownApi.writeExportImage = async (_id, pageNumber, bytes) => {
          document.body.dataset.pngHeader = bytes.slice(0, 11)
          return pageNumber === 1 ? { ok: true } : { ok: false, error: 'Disk is full' }
        }
        window.markdownApi.finishImageExport = async (_id, success) => {
          document.body.dataset.finished = String(success)
          return { ok: true, canceled: true }
        }
        window.dispatchEvent(new CustomEvent('test:export', { detail: 'png' }))
      },
      { canceled, pdfBase64 },
    )
    await expect(page.locator('body')).toHaveAttribute('data-picked', 'true')
    if (canceled) {
      await expect(page.locator('.status-export')).toHaveCount(0)
      await expect(page.locator('body')).not.toHaveAttribute('data-png-header')
      await expect(page.locator('body')).not.toHaveAttribute('data-finished')
    } else {
      await expect(page.locator('.status-export')).toHaveText('Image export failed: Disk is full')
      await expect(page.locator('body')).toHaveAttribute('data-png-header', 'iVBORw0KGgo')
      await expect(page.locator('body')).toHaveAttribute('data-finished', 'false')
    }
  })
}
