import { describe, expect, it } from 'vitest'

import { groupValue } from '@genoffice/xlsx-gateway/domain/pivot-grouping'
import {
  growPivotDefinition,
  recomputePivotData,
} from '@genoffice/xlsx-gateway/domain/pivot-engine'
import { parsePivotDefinition } from '@genoffice/xlsx-gateway/gateway/xlsx-pivot'

describe('groupValue', () => {
  it('groups dates by year / quarter / month from ISO strings', () => {
    expect(groupValue({ kind: 'date', dateUnit: 'year' }, '2026-07-01')).toEqual({
      label: '2026',
      sort: 2026,
    })
    expect(groupValue({ kind: 'date', dateUnit: 'quarter' }, '2026-07-01')).toEqual({
      label: 'Q3',
      sort: 3,
    })
    expect(groupValue({ kind: 'date', dateUnit: 'month' }, '2026/7/1')).toEqual({
      label: 'Jul',
      sort: 7,
    })
    // Quarter/month grouping merges across years (single-level grouping, not nested under year).
    expect(groupValue({ kind: 'date', dateUnit: 'month' }, '2025-07-20').label).toBe('Jul')
  })

  it('groups Excel serial dates', () => {
    // 46204 = 2026-07-01 (epoch 1899-12-30).
    expect(groupValue({ kind: 'date', dateUnit: 'year' }, 46204).label).toBe('2026')
    expect(groupValue({ kind: 'date', dateUnit: 'month' }, 46204).label).toBe('Jul')
  })

  it('groups numbers into fixed-step ranges', () => {
    const rule = { kind: 'range', rangeStep: 100 } as const
    expect(groupValue(rule, 0)).toEqual({ label: '0-100', sort: 0 })
    expect(groupValue(rule, 99.5)).toEqual({ label: '0-100', sort: 0 })
    expect(groupValue(rule, 100)).toEqual({ label: '100-200', sort: 100 })
    expect(groupValue(rule, -1)).toEqual({ label: '-100-0', sort: -100 })
    expect(groupValue({ kind: 'range', rangeStep: 50, rangeStart: 25 }, 60).label).toBe('25-75')
    // Numbers in string form get grouped too.
    expect(groupValue(rule, '150').label).toBe('100-200')
  })

  it.each([
    [0.1, 0, 0.3, '0.3-0.4', 0.3],
    [0.1, 0, 0.7, '0.7-0.8', 0.7],
    [0.1, 0, 1.1, '1.1-1.2', 1.1],
    [0.1, 0, 2.7, '2.7-2.8', 2.7],
    [0.05, 0, 0.3, '0.3-0.35', 0.3],
    [0.01, 0, 0.29, '0.29-0.3', 0.29],
    [0.1, 0.1, 0.3, '0.3-0.4', 0.3],
    [0.1, 100.1, 100.3, '100.3-100.4', 100.3],
    [0.1, 0, -2.1, '-2.1--2', -2.1],
    [0.1, -0.3, -0.1, '-0.1-0', -0.1],
    [0.1, 0, '0.3', '0.3-0.4', 0.3],
  ] as const)(
    'puts boundary %s/%s/%s in its own range',
    (rangeStep, rangeStart, value, label, sort) => {
      const result = groupValue({ kind: 'range', rangeStep, rangeStart }, value)
      expect(result.label).toBe(label)
      expect(result.sort).toBeCloseTo(sort, 10)
    },
  )

  it.each([
    [0.1, 0, 0.2999999999, '0.2-0.3'],
    [0.1, 0, 0.3000000001, '0.3-0.4'],
    [0.1, 0, -2.1000000001, '-2.2--2.1'],
    [0.1, 0, -2.0999999999, '-2.1--2'],
    [0.1, 100.1, 100.2999999999, '100.2-100.3'],
    [0.1, 100.1, 100.3000000001, '100.3-100.4'],
  ] as const)(
    'keeps non-boundary %s/%s/%s in its half-open range',
    (rangeStep, rangeStart, value, label) => {
      expect(groupValue({ kind: 'range', rangeStep, rangeStart }, value).label).toBe(label)
    },
  )

  it('scales the tolerance for tiny steps without advancing large integer buckets', () => {
    expect(groupValue({ kind: 'range', rangeStep: 1e-12 }, 2.999999999e-12).sort).toBe(2e-12)
    expect(groupValue({ kind: 'range', rangeStep: 1 }, 1e16).sort).toBe(1e16)
  })

  it('passes blanks and unparseable values through', () => {
    expect(groupValue({ kind: 'date', dateUnit: 'month' }, null)).toEqual({ label: '', sort: null })
    expect(groupValue({ kind: 'date', dateUnit: 'month' }, 'not a date')).toEqual({
      label: 'not a date',
      sort: null,
    })
    expect(groupValue({ kind: 'range', rangeStep: 100 }, 'n/a')).toEqual({
      label: 'n/a',
      sort: null,
    })
  })
})

/// Minimal definition: single row field (date, grouped by month) + one value field: the grouping
/// rule lives in a private extension inside the pivotTable extLst, and sharedItems are the group labels.
const GROUPED_PIVOT_XML =
  '<pivotTableDefinition name="PivotTable1" cacheId="1">' +
  '<location ref="E1:F4" firstHeaderRow="1" firstDataRow="1" firstDataCol="1"/>' +
  '<pivotFields count="2">' +
  '<pivotField axis="axisRow" showAll="0"><items count="3">' +
  '<item x="0"/><item x="1"/><item t="default"/></items></pivotField>' +
  '<pivotField dataField="1" showAll="0"/>' +
  '</pivotFields>' +
  '<rowFields count="1"><field x="0"/></rowFields>' +
  '<rowItems count="3"><i><x/></i><i><x v="1"/></i><i t="grand"><x/></i></rowItems>' +
  '<colItems count="1"><i/></colItems>' +
  '<dataFields count="1"><dataField name="Sum of Amount" fld="1"/></dataFields>' +
  '<extLst><ext uri="{AIO-PIVOT-GROUPINGS}" xmlns:aio="urn:aioffice:pivot">' +
  '<aio:aioPivotGroupings v="[{&quot;fieldIndex&quot;:0,&quot;kind&quot;:&quot;date&quot;,&quot;dateUnit&quot;:&quot;month&quot;}]"/>' +
  '</ext></extLst>' +
  '</pivotTableDefinition>'

const GROUPED_CACHE_XML =
  '<pivotCacheDefinition>' +
  '<cacheSource type="worksheet"><worksheetSource ref="A1:B5" sheet="Data"/></cacheSource>' +
  '<cacheFields count="2">' +
  '<cacheField name="Date"><sharedItems count="2"><s v="Jan"/><s v="Feb"/></sharedItems></cacheField>' +
  '<cacheField name="Amount"><sharedItems containsString="0" containsNumber="1"/></cacheField>' +
  '</cacheFields>' +
  '</pivotCacheDefinition>'

describe('grouped-field recompute', () => {
  it('aggregates decimal boundaries separately from values below the boundary', () => {
    const parsed = parsePivotDefinition(GROUPED_PIVOT_XML, GROUPED_CACHE_XML)
    const definition = {
      ...parsed,
      fields: parsed.fields.map((field, index) =>
        index === 0
          ? {
              ...field,
              name: 'Value',
              grouping: { kind: 'range', rangeStep: 0.1 } as const,
              sharedItems: ['0.2-0.3', '0.3-0.4'],
            }
          : field,
      ),
    }
    const result = recomputePivotData(definition, [
      ['Value', 'Amount'],
      [0.2999999999, 5],
      [0.3, 10],
      [0.3000000001, 7],
    ])
    expect(result.data).toEqual([[5], [17], [22]])
  })

  it('parses the grouping extension and recomputes by group label', () => {
    const definition = parsePivotDefinition(GROUPED_PIVOT_XML, GROUPED_CACHE_XML)
    expect(definition.unsupported).toEqual([])
    expect(definition.fields[0]!.grouping).toEqual({ kind: 'date', dateUnit: 'month' })
    const result = recomputePivotData(definition, [
      ['Date', 'Amount'],
      ['2026-01-05', 10],
      ['2026-01-20', 5],
      ['2026-02-02', 7],
    ])
    expect(result.data).toEqual([[15], [7], [22]])
  })

  it('grows the layout with new group labels (not raw values)', () => {
    const definition = parsePivotDefinition(GROUPED_PIVOT_XML, GROUPED_CACHE_XML)
    const source = [
      ['Date', 'Amount'],
      ['2026-01-05', 10],
      ['2026-02-02', 7],
      ['2026-03-08', 3],
      ['2026-03-19', 4],
    ]
    const growth = growPivotDefinition(definition, source)
    expect(growth.grown).toBe(true)
    expect(growth.definition.fields[0]!.sharedItems).toEqual(['Jan', 'Feb', 'Mar'])
    const result = recomputePivotData(growth.definition, source)
    expect(result.data).toEqual([[10], [7], [7], [24]])
  })

  it('fails closed on a corrupted grouping extension', () => {
    const corrupted = GROUPED_PIVOT_XML.replace(/v="\[[^"]*\]"/, 'v="not json"')
    const definition = parsePivotDefinition(corrupted, GROUPED_CACHE_XML)
    expect(definition.unsupported.join()).toContain('grouped-field extension metadata')
  })

  it('still flags foreign <fieldGroup> definitions as unsupported', () => {
    const withFieldGroup = GROUPED_CACHE_XML.replace(
      '</cacheField><cacheField name="Amount">',
      '<fieldGroup base="0"><rangePr groupBy="months"/></fieldGroup></cacheField><cacheField name="Amount">',
    )
    const definition = parsePivotDefinition(GROUPED_PIVOT_XML, withFieldGroup)
    expect(definition.unsupported.join()).toContain('grouped field "Date"')
  })
})
