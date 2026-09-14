import type { Editor } from '@tiptap/core'
import type { MdOp } from '../editor/ops'

/** A proposed replacement for one protected source fragment.  Proposals are
 * deliberately inert: only confirmation through the document session writes. */
export interface SourcePatch {
  id: string
  origin: 'conversion' | 'ai'
  fragmentId: string
  expectedRaw: string
  nextRaw: string
  baseRevision: number
}

export type PatchValidation =
  | { ok: true }
  | { ok: false; error: 'fragment-missing' | 'raw-changed' | 'revision-changed' }

export interface SourcePatchTarget {
  id: string
  raw: string
}

/** The only bridge used by AI/UI adapters for protected-source mutations. */
export interface SourceProtectionAccess {
  mode(): 'visual' | 'source'
  /** Stable protected labels and their exact raw text, for read-only AI context. */
  context(): string
  /** Statically resolve every protected target before an op batch is dispatched. */
  protectedIdsForOps(editor: Editor, ops: MdOp[]): string[]
  propose(fragmentId: string, expectedRaw: string, nextRaw: string): SourcePatch
  publish(patch: SourcePatch): void
}

let patchSequence = 0

export function createSourcePatch(
  origin: SourcePatch['origin'],
  fragmentId: string,
  expectedRaw: string,
  nextRaw: string,
  baseRevision: number,
): SourcePatch {
  return {
    id: `source-patch-${++patchSequence}`,
    origin,
    fragmentId,
    expectedRaw,
    nextRaw,
    baseRevision,
  }
}

export function validateSourcePatch(
  patch: SourcePatch,
  revision: number,
  fragments: readonly SourcePatchTarget[],
): PatchValidation {
  if (patch.baseRevision !== revision) return { ok: false, error: 'revision-changed' }
  const fragment = fragments.find((candidate) => candidate.id === patch.fragmentId)
  if (!fragment) return { ok: false, error: 'fragment-missing' }
  if (fragment.raw !== patch.expectedRaw) return { ok: false, error: 'raw-changed' }
  return { ok: true }
}
