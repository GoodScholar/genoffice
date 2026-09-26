import { randomBytes } from 'node:crypto'
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

/** Transient Windows codes: antivirus and the indexer briefly hold the rename target. */
const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])
const RENAME_RETRIES = 4

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * State files are read back by the next launch, so a half-written one is worse
 * than a stale one: the payload goes to a temporary file in the same directory
 * and only the rename publishes it, and the rename never truncates the file it
 * replaces. Unlike the export path there is no in-place fallback — a rename
 * that keeps failing throws, leaving the previous contents readable.
 */
export async function writeJsonAtomic(filePath: string, value: unknown, space = 2): Promise<void> {
  const dir = dirname(filePath)
  const tmp = join(dir, `.${basename(filePath)}.${randomBytes(6).toString('hex')}.tmp`)
  await mkdir(dir, { recursive: true })
  let payload: string
  try {
    payload = JSON.stringify(value, null, space)
  } catch (err) {
    throw new Error(`cannot serialize ${basename(filePath)}`, { cause: err })
  }
  try {
    await writeFile(tmp, payload, 'utf-8')
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(tmp, filePath)
        return
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? ''
        if (!RETRYABLE_RENAME_CODES.has(code) || attempt >= RENAME_RETRIES) throw error
        await sleep(50 * 2 ** attempt)
      }
    }
  } catch (error) {
    await unlink(tmp).catch(() => {})
    throw error
  }
}
