import type { Node as ProseMirrorNode, Schema } from '@tiptap/pm/model'
import { Step, StepMap, StepResult, type Mappable } from '@tiptap/pm/transform'
import type { Transaction } from '@tiptap/pm/state'

/** A history-only source snapshot. It deliberately leaves the ProseMirror doc unchanged. */
export class SourceSnapshotStep extends Step {
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

  static fromJSON(_schema: Schema, json: { beforeSource: string, source: string }): SourceSnapshotStep {
    return new SourceSnapshotStep(json.beforeSource, json.source)
  }
}

Step.jsonID('genofficeSourceSnapshot', SourceSnapshotStep)

export function sourceSnapshotFromTransaction(transaction: Transaction): string | undefined {
  return transaction.steps.find((step): step is SourceSnapshotStep => step instanceof SourceSnapshotStep)?.source
}
