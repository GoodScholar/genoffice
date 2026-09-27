import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ProjectStore } from '../../src/store.js'

const [userDataPath, syncDir, workerId, operation, iterationsArg] = process.argv.slice(2)
if (!userDataPath || !syncDir || !workerId || !operation || !iterationsArg) {
  throw new Error('missing concurrent worker arguments')
}

const iterations = Number(iterationsArg)
const sleeper = new Int32Array(new SharedArrayBuffer(4))
writeFileSync(join(syncDir, `ready-${workerId}`), '')

const startPath = join(syncDir, 'start')
const deadline = Date.now() + 10_000
while (!existsSync(startPath)) {
  if (Date.now() >= deadline) throw new Error('timed out waiting for concurrent start')
  Atomics.wait(sleeper, 0, 0, 5)
}

const store = new ProjectStore(userDataPath)
if (operation === 'resolve') {
  for (let index = 0; index < iterations; index++) {
    store.resolveProjectForFile(`/docs/${workerId}-${index}.docx`)
  }
} else if (operation === 'append') {
  for (let index = 0; index < iterations; index++) {
    store.appendChatMessage('default', 'shared-chat', {
      role: 'assistant',
      text: `${workerId}-${index}`,
    })
  }
} else if (operation === 'create-project') {
  for (let index = 0; index < iterations; index++) {
    store.createProject(`Project ${workerId}-${index}`)
  }
} else {
  throw new Error(`unknown concurrent operation: ${operation}`)
}
