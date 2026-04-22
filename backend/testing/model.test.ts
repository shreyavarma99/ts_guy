import test from 'node:test'
import assert from 'node:assert/strict'

import { fitAccidentRegressor, getAccidentRegressor, logSpaceContributions, predictAccidentCount } from '../src/ml/accidentRegressor.js'
import type { SegmentRow } from '../src/segmentTypes.js'

function mkRow(partial: Partial<SegmentRow> & { segment_id: string }): SegmentRow {
  return {
    segment_id: partial.segment_id,
    geometry: partial.geometry ?? JSON.stringify({ type: 'LineString', coordinates: [[-97.74, 30.26], [-97.741, 30.261]] }),
    accident_count: partial.accident_count ?? 0,
    traffic_volume: partial.traffic_volume ?? 12000,
    speed_limit: partial.speed_limit ?? 35,
    num_lanes: partial.num_lanes ?? 2,
    road_type: partial.road_type ?? 'secondary',
    crosswalk_present: partial.crosswalk_present ?? 0,
    is_intersection: partial.is_intersection ?? 0,
    urban_density: partial.urban_density ?? 0.5,
  }
}

test('fits a regressor on synthetic rows', () => {
  const rows: SegmentRow[] = []
  for (let i = 0; i < 200; i++) {
    rows.push(
      mkRow({
        segment_id: `r/${i}`,
        accident_count: Math.max(0, Math.round((i % 20) / 3)),
        traffic_volume: 6000 + (i % 7) * 3000,
        speed_limit: 25 + (i % 4) * 10,
        num_lanes: 1 + (i % 3),
        urban_density: (i % 10) / 10,
        road_type: i % 2 === 0 ? 'secondary' : 'primary',
        crosswalk_present: i % 5 === 0 ? 1 : 0,
        is_intersection: i % 6 === 0 ? 1 : 0,
      }),
    )
  }

  fitAccidentRegressor(rows)
  const m = getAccidentRegressor()
  assert.ok(m, 'model should be fitted')
  assert.equal(m.target, 'log1p_accident_count')
  assert.equal(m.interceptOnlyFallback, false)
})

test('A/B: forcing crosswalk_present=1 does not increase predicted crashes', () => {
  // Train on a reasonable synthetic table.
  const rows: SegmentRow[] = []
  for (let i = 0; i < 120; i++) {
    rows.push(
      mkRow({
        segment_id: `train/${i}`,
        accident_count: (i % 9) + (i % 2),
        traffic_volume: 8000 + (i % 6) * 4000,
        speed_limit: 30 + (i % 3) * 10,
        num_lanes: 2,
        road_type: i % 3 === 0 ? 'primary' : 'secondary',
        urban_density: (i % 8) / 8,
        crosswalk_present: i % 4 === 0 ? 1 : 0,
        is_intersection: 1,
      }),
    )
  }
  fitAccidentRegressor(rows)

  const base = mkRow({
    segment_id: 'probe',
    accident_count: 0,
    crosswalk_present: 0,
    is_intersection: 1,
    traffic_volume: 16000,
    speed_limit: 40,
    num_lanes: 3,
    road_type: 'primary',
    urban_density: 0.8,
  })

  const p0 = predictAccidentCount(base)
  const p1 = predictAccidentCount({ ...base, crosswalk_present: 1 })
  assert.ok(p0 != null && p1 != null)
  assert.ok(p1 <= p0 + 1e-9, `expected p1 <= p0, got p0=${p0} p1=${p1}`)
})

test('crosswalk contribution is non-positive when crosswalk_present=1', () => {
  const rows: SegmentRow[] = []
  for (let i = 0; i < 90; i++) {
    rows.push(
      mkRow({
        segment_id: `train2/${i}`,
        accident_count: (i % 7) + (i % 3),
        traffic_volume: 5000 + (i % 5) * 5000,
        speed_limit: 25 + (i % 5) * 5,
        num_lanes: 1 + (i % 3),
        road_type: i % 2 === 0 ? 'secondary' : 'primary',
        urban_density: (i % 10) / 10,
        crosswalk_present: i % 3 === 0 ? 1 : 0,
        is_intersection: 0,
      }),
    )
  }
  fitAccidentRegressor(rows)

  const row = mkRow({ segment_id: 'c', crosswalk_present: 1 })
  const c = logSpaceContributions(row)
  assert.ok(c)
  assert.ok((c.crosswalk_present ?? 0) <= 1e-12, `expected <= 0, got ${c.crosswalk_present}`)
})

