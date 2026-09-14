import type { Node as ProseMirrorNode, Schema } from '@tiptap/pm/model'
import { Step, StepMap, StepResult, type Mappable } from '@tiptap/pm/transform'
import type { Transaction } from '@tiptap/pm/state'

/** A history-only source snapshot. It deliberately leaves the ProseMirror doc unchanged. */
class SourceSnapshotStepImpl extends Step {
  constructor(readonly beforeSource: string, readonly source: string) {
    super()
  }

  apply(doc: ProseMirrorNode): StepResult {
    return StepResult.ok(doc)
  }

  getMap(): StepMap {
    return StepMap.empty
  }

  invert(): Step {
    return new SourceSnapshotStep(this.source, this.beforeSource)
  }

  map(_mapping: Mappable): Step {
    return this
  }

  toJSON(): object {
    return { stepType: 'genofficeSourceSnapshot', beforeSource: this.beforeSource, source: this.source }
  }

  static fromJSON(_schema: Schema, json: { beforeSource: string, source: string }): SourceSnapshotStepImpl {
    return new SourceSnapshotStepImpl(json.beforeSource, json.source)
  }
}

type SourceSnapshotStepConstructor = typeof SourceSnapshotStepImpl
const sourceSnapshotStepKey = Symbol.for('genoffice.markdown.SourceSnapshotStep')
const sourceHistoryGlobal = globalThis as typeof globalThis & { [sourceSnapshotStepKey]?: SourceSnapshotStepConstructor }

export const SourceSnapshotStep: SourceSnapshotStepConstructor = sourceHistoryGlobal[sourceSnapshotStepKey]
  ?? (() => {
    Step.jsonID('genofficeSourceSnapshot', SourceSnapshotStepImpl)
    sourceHistoryGlobal[sourceSnapshotStepKey] = SourceSnapshotStepImpl
    return SourceSnapshotStepImpl
  })()

export function sourceSnapshotFromTransaction(transaction: Transaction): string | undefined {
  return sourceSnapshotPairFromTransaction(transaction)?.source
}

/** 返回 transaction 中源码快照的双端值，供受保护事务校验精确的历史转换。 */
export function sourceSnapshotPairFromTransaction(transaction: Transaction): { beforeSource: string, source: string } | undefined {
  let beforeSource: string | undefined
  let source: string | undefined
  for (const step of transaction.steps) {
    if (!(step instanceof SourceSnapshotStep)) continue
    beforeSource ??= step.beforeSource
    source = step.source
  }
  return beforeSource === undefined || source === undefined ? undefined : { beforeSource, source }
}
