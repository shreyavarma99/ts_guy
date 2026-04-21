import type { SegmentRow } from './segmentTypes.js'
import { getAccidentRegressor, logSpaceContributions, predictAccidentCount } from './ml/accidentRegressor.js'

export type SegmentScore = {
  predicted_accident_count: number
  safety_score: number // [0,1] higher is safer
  explanation: {
    model: 'ridge_log1p'
    risk: {
      total: number
      contributions: {
        intercept: number
        traffic_volume: number
        speed_limit: number
        num_lanes: number
        urban_density: number
        is_intersection: number
        road_type: number
        crosswalk_present: number
      }
    }
    normalized: {
      traffic_volume: number
      speed_limit: number
      num_lanes: number
      urban_density: number
      is_intersection: number
      crosswalk_present: number
    }
    notes: string[]
  }
}

function clamp01(x: number) {
  if (x < 0) return 0
  if (x > 1) return 1
  return x
}

function mlZNorm(row: SegmentRow) {
  const m = getAccidentRegressor()
  if (!m) return null
  const logTv = Math.log1p(Math.max(0, row.traffic_volume))
  const z0 = (logTv - m.means[0]) / m.stds[0]
  const z1 = (row.speed_limit - m.means[1]) / m.stds[1]
  const z2 = (row.num_lanes - m.means[2]) / m.stds[2]
  const z3 = (row.urban_density - m.means[3]) / m.stds[3]
  return { z0, z1, z2, z3 }
}

function ridgeScore(row: SegmentRow): SegmentScore {
  const m = getAccidentRegressor()
  if (!m) {
    throw new Error('[scoring] Accident regressor is not fitted; scoreSegment called before data load completed.')
  }

  const predicted = predictAccidentCount(row) ?? 0
  const safety = Math.exp(-0.08 * Math.max(0, predicted))
  const contribs = logSpaceContributions(row)!

  const logTotal =
    contribs.intercept +
    contribs.traffic_volume +
    contribs.speed_limit +
    contribs.num_lanes +
    contribs.urban_density +
    contribs.crosswalk_present +
    contribs.is_intersection +
    contribs.road_type

  const zn = mlZNorm(row)!

  const notes: string[] = [
    'Predictions use a ridge regression trained on log1p(observed crash counts) for the current segment dataset (same features as the API).',
  ]
  if (m.interceptOnlyFallback) {
    notes.push(
      'Intercept-only fallback: the full ridge system was numerically singular for this table; every row uses the same mean log1p crash level until more or less collinear data is available.',
    )
  }
  if (!row.crosswalk_present) {
    notes.push('No crosswalk / crossing treatment detected in OSM tags (feature = 0).')
  }
  if (row.is_intersection) notes.push('Intersection rows include an intersection indicator feature.')

  return {
    predicted_accident_count: predicted,
    safety_score: clamp01(safety),
    explanation: {
      model: 'ridge_log1p',
      risk: {
        total: logTotal,
        contributions: {
          intercept: contribs.intercept,
          traffic_volume: contribs.traffic_volume,
          speed_limit: contribs.speed_limit,
          num_lanes: contribs.num_lanes,
          urban_density: contribs.urban_density,
          is_intersection: contribs.is_intersection,
          road_type: contribs.road_type,
          crosswalk_present: contribs.crosswalk_present,
        },
      },
      normalized: {
        traffic_volume: zn.z0,
        speed_limit: zn.z1,
        num_lanes: zn.z2,
        urban_density: zn.z3,
        is_intersection: row.is_intersection ? 1 : 0,
        crosswalk_present: row.crosswalk_present ? 1 : 0,
      },
      notes,
    },
  }
}

export function scoreSegment(row: SegmentRow): SegmentScore {
  return ridgeScore(row)
}
