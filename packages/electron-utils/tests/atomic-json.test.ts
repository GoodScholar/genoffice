import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeJsonAtomic } from '../src/atomic-json'

const fault = vi.hoisted(() => ({
  write: null as null | ((path: string) => Error | null),
  rename: null as null | ((path: string) => Error | null),
  beforeWrite: null as null | (() => Promise<void>),
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    writeFile: async (path: string, data: string, options?: unknown) => {
      if (fault.beforeWrite) await fault.beforeWrite()
      const error = fault.write?.(String(path))
      if (error) throw error
      return actual.writeFile(path, data, options as never)
    },
    rename: async (from: string, to: string) => {
      const error = fault.rename?.(String(to))
      if (error) throw error
      return actual.rename(from, to)
    },
  }
})

function errno(code: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(`${code}: injected`)
  error.code = code
  return error
}

let dir: string
let file: string

const stored = (): unknown => JSON.parse(readFileSync(file, 'utf-8'))
const leftovers = (): string[] => readdirSync(dir).filter((name) => name !== 'ai-settings.json')

beforeEach(() => {
  fault.write = null
  fault.rename = null
  fault.beforeWrite = null
  dir = mkdtempSync(join(tmpdir(), 'atomic-json-'))
  file = join(dir, 'ai-settings.json')
})

afterEach(() => {
  fault.write = null
  fault.rename = null
  fault.beforeWrite = null
  rmSync(dir, { recursive: true, force: true })
})

describe('writeJsonAtomic', () => {
  it('creates the directory and publishes the payload with no temp file left behind', async () => {
    const nested = join(dir, 'nested', 'ai-settings.json')
    await writeJsonAtomic(nested, { provider: 'openai' })
    expect(JSON.parse(readFileSync(nested, 'utf-8'))).toEqual({ provider: 'openai' })
    expect(readdirSync(dir)).toEqual(['nested'])
  })

  it('never exposes a partial file to a reader running during the write', async () => {
    await writeJsonAtomic(file, { provider: 'openai' })
    let entered = (): void => {}
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const reachedTempWrite = new Promise<void>((resolve) => {
      entered = resolve
    })
    fault.beforeWrite = async () => {
      entered()
      await gate
    }
    const pending = writeJsonAtomic(file, { provider: 'anthropic' })
    await reachedTempWrite
    expect(stored()).toEqual({ provider: 'openai' })
    release()
    await pending
    expect(stored()).toEqual({ provider: 'anthropic' })
    expect(leftovers()).toEqual([])
  })

  it('keeps the previous settings readable when the write fails', async () => {
    await writeJsonAtomic(file, { provider: 'openai', providers: { openai: { apiKey: 'secret' } } })
    const before = readFileSync(file, 'utf-8')
    fault.write = () => errno('ENOSPC')
    await expect(writeJsonAtomic(file, { provider: 'anthropic' })).rejects.toThrow('ENOSPC')
    fault.write = null
    expect(readFileSync(file, 'utf-8')).toBe(before)
    expect(stored()).toEqual({ provider: 'openai', providers: { openai: { apiKey: 'secret' } } })
    expect(leftovers()).toEqual([])
  })

  it('keeps the previous settings readable when the rename keeps failing', async () => {
    await writeJsonAtomic(file, { provider: 'openai' })
    const before = readFileSync(file, 'utf-8')
    let attempts = 0
    fault.rename = () => {
      attempts += 1
      return errno('EPERM')
    }
    await expect(writeJsonAtomic(file, { provider: 'anthropic' })).rejects.toThrow('EPERM')
    fault.rename = null
    expect(attempts).toBe(5)
    expect(readFileSync(file, 'utf-8')).toBe(before)
    expect(leftovers()).toEqual([])
  })

  it('replaces a stale file through a transient rename failure', async () => {
    await writeJsonAtomic(file, { provider: 'openai' })
    let attempts = 0
    fault.rename = () => (++attempts === 1 ? errno('EPERM') : null)
    await writeJsonAtomic(file, { provider: 'anthropic' })
    fault.rename = null
    expect(attempts).toBe(2)
    expect(stored()).toEqual({ provider: 'anthropic' })
    expect(leftovers()).toEqual([])
  })

  it('leaves the previous file alone when the value cannot be serialized', async () => {
    await writeJsonAtomic(file, { provider: 'openai' })
    const before = readFileSync(file, 'utf-8')
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    await expect(writeJsonAtomic(file, cyclic)).rejects.toThrow('cannot serialize')
    expect(readFileSync(file, 'utf-8')).toBe(before)
    expect(leftovers()).toEqual([])
  })
})
