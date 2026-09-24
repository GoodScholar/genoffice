import { CellValueType, Direction, IUniverInstanceService } from '@univerjs/core'
import { AUTO_FILL_APPLY_TYPE, IAutoFillService } from '@univerjs/sheets'

import type { UniverRuntime } from './univer-state'

/** Add a one-step numeric series to Univer's ordinary fill/undo pipeline. */
export function installCtrlDragFill(
  runtime: Pick<UniverRuntime, 'univer'>,
  gridHost: EventTarget,
  pointerTarget: EventTarget = window,
): { dispose(): void } {
  const injector = runtime.univer.__getInjector()
  const sheets = injector.get(IUniverInstanceService)
  let dragPointerId: number | null = null
  let ctrlReleased = false

  const onPointerDown = (event: Event): void => {
    const pointer = event as PointerEvent
    if (pointer.button === 0) dragPointerId = pointer.pointerId
  }
  const onPointerUp = (event: Event): void => {
    const pointer = event as PointerEvent
    if (pointer.pointerId !== dragPointerId) return
    dragPointerId = null
    ctrlReleased = pointer.ctrlKey
    // Univer executes the fill command during this pointer-up event.
    queueMicrotask(() => {
      ctrlReleased = false
    })
  }
  const reset = (): void => {
    dragPointerId = null
    ctrlReleased = false
  }

  const seedFor = (unitId: string, subUnitId: string, row: number, col: number): number | null => {
    const cell = sheets
      .getUniverSheetInstance(unitId)
      ?.getSheetBySheetId(subUnitId)
      ?.getCellRaw(row, col)
    return cell &&
      cell.t !== CellValueType.BOOLEAN &&
      typeof cell.v === 'number' &&
      Number.isFinite(cell.v) &&
      !cell.f &&
      !cell.si
      ? cell.v
      : null
  }

  const hook = injector.get(IAutoFillService).addHook({
    id: 'genoffice-ctrl-drag-number-series',
    onBeforeFillData: ({ source, unitId, subUnitId }) => {
      if (!ctrlReleased || source.rows.length !== 1 || source.cols.length !== 1) return
      if (seedFor(unitId, subUnitId, source.rows[0]!, source.cols[0]!) === null) return
      return AUTO_FILL_APPLY_TYPE.SERIES
    },
    onBeforeSubmit: ({ source, target, unitId, subUnitId }, direction, applyType, cellValue) => {
      if (!ctrlReleased || applyType !== AUTO_FILL_APPLY_TYPE.SERIES) return
      if (source.rows.length !== 1 || source.cols.length !== 1) return
      const seed = seedFor(unitId, subUnitId, source.rows[0]!, source.cols[0]!)
      if (seed === null) return
      const vertical = direction === Direction.DOWN || direction === Direction.UP
      const reverse = direction === Direction.UP || direction === Direction.LEFT
      const axis = vertical ? target.rows : target.cols
      axis.forEach((position, index) => {
        const row = vertical ? position : source.rows[0]!
        const col = vertical ? source.cols[0]! : position
        const filled = cellValue[row]?.[col]
        const value = seed + (reverse ? index - axis.length : index + 1)
        if (filled && Number.isFinite(value)) filled.v = value
      })
    },
  })

  gridHost.addEventListener('pointerdown', onPointerDown, true)
  pointerTarget.addEventListener('pointerup', onPointerUp, true)
  pointerTarget.addEventListener('pointercancel', reset)
  pointerTarget.addEventListener('blur', reset)
  return {
    dispose: () => {
      hook.dispose()
      gridHost.removeEventListener('pointerdown', onPointerDown, true)
      pointerTarget.removeEventListener('pointerup', onPointerUp, true)
      pointerTarget.removeEventListener('pointercancel', reset)
      pointerTarget.removeEventListener('blur', reset)
    },
  }
}
