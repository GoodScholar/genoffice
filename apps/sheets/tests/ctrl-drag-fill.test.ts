import {
  CellValueType,
  ICommandService,
  IUniverInstanceService,
  LocaleType,
  LogLevel,
  Univer,
  UniverInstanceType,
} from '@univerjs/core'
import type { ICellData, IRange } from '@univerjs/core'
import { AutoFillCommand, UniverSheetsPlugin } from '@univerjs/sheets'
import { describe, expect, it } from 'vitest'

import { installCtrlDragFill } from '../src/renderer/ctrl-drag-fill'

const cell = (row: number, col = 0): IRange => ({
  startRow: row,
  endRow: row,
  startColumn: col,
  endColumn: col,
})

function pointer(type: string, ctrlKey: boolean): Event {
  return Object.assign(new Event(type), { pointerId: 1, button: 0, ctrlKey })
}

function setup(seed: ICellData): {
  univer: Univer
  values(): unknown[]
  fill(sourceRange: IRange, targetRange: IRange, ctrlKey: boolean): Promise<void>
} {
  const univer = new Univer({ logLevel: LogLevel.ERROR, locale: LocaleType.EN_US, locales: {} })
  univer.registerPlugin(UniverSheetsPlugin)
  univer.createUnit(UniverInstanceType.UNIVER_SHEET, {
    id: 'book',
    name: 'Book',
    sheetOrder: ['sheet'],
    styles: {},
    sheets: {
      sheet: {
        id: 'sheet',
        name: 'Sheet',
        rowCount: 10,
        columnCount: 10,
        cellData: { 3: { 0: seed } },
      },
    },
  })
  const grid = new EventTarget()
  const pointerTarget = new EventTarget()
  installCtrlDragFill({ univer }, grid, pointerTarget)
  const commands = univer.__getInjector().get(ICommandService)
  const sheet = univer
    .__getInjector()
    .get(IUniverInstanceService)
    .getUniverSheetInstance('book')
    ?.getSheetBySheetId('sheet')
  return {
    univer,
    values: () => [0, 1, 2, 3, 4, 5, 6].map((row) => sheet?.getCellRaw(row, 0)?.v),
    fill: async (sourceRange, targetRange, ctrlKey) => {
      grid.dispatchEvent(pointer('pointerdown', ctrlKey))
      pointerTarget.dispatchEvent(pointer('pointerup', ctrlKey))
      await commands.executeCommand(AutoFillCommand.id, {
        unitId: 'book',
        subUnitId: 'sheet',
        sourceRange,
        targetRange,
      })
    },
  }
}

describe('single-number Ctrl-drag fill', () => {
  it('increments downward and preserves the starting cell', async () => {
    const fixture = setup({ v: 1008, t: CellValueType.NUMBER })
    try {
      await fixture.fill(cell(3), { ...cell(3), endRow: 6 }, true)
      expect(fixture.values()).toEqual([undefined, undefined, undefined, 1008, 1009, 1010, 1011])
    } finally {
      fixture.univer.dispose()
    }
  })

  it('decrements upward from the starting cell', async () => {
    const fixture = setup({ v: 1008, t: CellValueType.NUMBER })
    try {
      await fixture.fill(cell(3), { ...cell(0), endRow: 3 }, true)
      expect(fixture.values()).toEqual([1005, 1006, 1007, 1008, undefined, undefined, undefined])
    } finally {
      fixture.univer.dispose()
    }
  })

  it('keeps ordinary drag as copy', async () => {
    const fixture = setup({ v: 1008, t: CellValueType.NUMBER })
    try {
      await fixture.fill(cell(3), { ...cell(3), endRow: 6 }, false)
      expect(fixture.values()).toEqual([undefined, undefined, undefined, 1008, 1008, 1008, 1008])
    } finally {
      fixture.univer.dispose()
    }
  })

  it('keeps Univer’s existing number-like text fill behavior', async () => {
    const fixture = setup({ v: '1008', t: CellValueType.STRING })
    try {
      await fixture.fill(cell(3), { ...cell(3), endRow: 6 }, true)
      expect(fixture.values()).toEqual([
        undefined,
        undefined,
        undefined,
        '1008',
        '1009',
        '1010',
        '1011',
      ])
    } finally {
      fixture.univer.dispose()
    }
  })

  it('keeps boolean cells as booleans', async () => {
    const fixture = setup({ v: 1, t: CellValueType.BOOLEAN })
    try {
      await fixture.fill(cell(3), { ...cell(3), endRow: 5 }, true)
      expect(fixture.values()).toEqual([undefined, undefined, undefined, 1, 1, 1, undefined])
    } finally {
      fixture.univer.dispose()
    }
  })
})
