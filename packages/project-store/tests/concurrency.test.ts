import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { ProjectStore } from '../src/store.js'
import type { ProjectIndex } from '../src/types.js'

const workerPath = fileURLToPath(new URL('./fixtures/concurrent-worker.ts', import.meta.url))

interface WorkerResult {
  code: number | null
  stderr: string
}

async function waitForReady(syncDir: string, workerCount: number): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const ready = readdirSync(syncDir).filter((name) => name.startsWith('ready-')).length
    if (ready === workerCount) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${workerCount} concurrent workers`)
}

async function runWorkers(
  userDataPath: string,
  operation: string,
  workerCount: number,
  iterations: number,
): Promise<WorkerResult[]> {
  const syncDir = join(userDataPath, 'sync')
  mkdirSync(syncDir)

  const workers = Array.from({ length: workerCount }, (_, index) => {
    const workerId = String(index)
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        workerPath,
        userDataPath,
        syncDir,
        workerId,
        operation,
        String(iterations),
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    )
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    return new Promise<WorkerResult>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code) => resolve({ code, stderr }))
    })
  })

  await waitForReady(syncDir, workerCount)
  writeFileSync(join(syncDir, 'start'), '')
  return Promise.all(workers)
}

describe('concurrent ProjectStore writers', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
    tempDirs.length = 0
  })

  it('preserves every file mapping written by concurrent processes', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'project-store-concurrency-'))
    tempDirs.push(userDataPath)
    new ProjectStore(userDataPath).ensureDefaultProject()

    const workerCount = 12
    const iterations = 5
    const results = await runWorkers(userDataPath, 'resolve', workerCount, iterations)

    expect(results.filter((result) => result.code !== 0)).toEqual([])
    const index = JSON.parse(
      readFileSync(join(userDataPath, 'projects', 'index.json'), 'utf8'),
    ) as ProjectIndex
    expect(Object.keys(index.fileMap)).toHaveLength(workerCount * iterations)
    for (let worker = 0; worker < workerCount; worker++) {
      for (let iteration = 0; iteration < iterations; iteration++) {
        expect(index.fileMap[`/docs/${worker}-${iteration}.docx`]).toBe('default')
      }
    }
  }, 20_000)

  it('assigns unique monotonic sequences to messages appended by concurrent processes', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'project-store-concurrency-'))
    tempDirs.push(userDataPath)
    const store = new ProjectStore(userDataPath)
    store.ensureDefaultProject()

    const workerCount = 8
    const iterations = 5
    const results = await runWorkers(userDataPath, 'append', workerCount, iterations)

    expect(results.filter((result) => result.code !== 0)).toEqual([])
    const messages = store.loadChat('default', 'shared-chat', 10_000)
    const expectedCount = workerCount * iterations
    expect(messages).toHaveLength(expectedCount)
    expect(messages.map((message) => message.seq)).toEqual(
      Array.from({ length: expectedCount }, (_, index) => index),
    )
    expect(new Set(messages.map((message) => message.text)).size).toBe(expectedCount)
  }, 20_000)

  it('preserves every project created by concurrent processes', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'project-store-concurrency-'))
    tempDirs.push(userDataPath)
    const store = new ProjectStore(userDataPath)
    store.ensureDefaultProject()

    const workerCount = 8
    const iterations = 4
    const results = await runWorkers(userDataPath, 'create-project', workerCount, iterations)

    expect(results.filter((result) => result.code !== 0)).toEqual([])
    const projects = store.listProjects()
    expect(projects).toHaveLength(1 + workerCount * iterations)
    expect(projects[0]?.id).toBe('default')
    for (let worker = 0; worker < workerCount; worker++) {
      for (let iteration = 0; iteration < iterations; iteration++) {
        expect(projects.some((project) => project.name === `Project ${worker}-${iteration}`)).toBe(
          true,
        )
      }
    }
  }, 20_000)
})
