import type { SegmentRow } from './segmentTypes.js'

export type SegmentScore = {
  predicted_accident_count: number
  safety_score: number // [0,1] higher is safer
  explanation: {
    risk: {
      total: number
      contributions: {
        traffic_volume: number
        speed_limit: number
        num_lanes: number
        urban_density: number
        is_intersection: number
        road_type: number
        sidewalk_present: number
      }
    }
    normalized: {
      traffic_volume: number
      speed_limit: number
      num_lanes: number
      urban_density: number
      is_intersection: number
      sidewalk_present: number
    }
    notes: string[]
  }
}

function clamp01(x: number) {
  if (x < 0) return 0
  if (x > 1) return 1
  return x
}

/**
 * Baseline risk model (non-ML) that matches your feature list.
 * You can later swap this with a trained model without changing the API.
 */
export function scoreSegment(row: SegmentRow): SegmentScore {
  // Normalize-ish features
  const tv = Math.log1p(Math.max(0, row.traffic_volume)) / Math.log(1 + 60000) // ~0..1
  const spd = clamp01((row.speed_limit - 15) / 55) // 15..70 mph -> 0..1
  const lanes = clamp01((row.num_lanes - 1) / 5) // 1..6 -> 0..1
  const dense = clamp01(row.urban_density) // expect 0..1
  const intersection = row.is_intersection ? 1 : 0
  const sidewalk = row.sidewalk_present ? 1 : 0

  // Road-type adjustment (very rough prior)
  const roadTypePenalty =
    row.road_type.includes('motorway') || row.road_type.includes('trunk')
      ? 0.35
      : row.road_type.includes('primary')
        ? 0.2
        : row.road_type.includes('secondary')
          ? 0.12
          : row.road_type.includes('residential')
            ? 0.05
            : 0.1

  // Risk in [0, ~1.6]
  const cTraffic = 0.55 * tv
  const cSpeed = 0.28 * spd
  const cLanes = 0.18 * lanes
  const cDense = 0.25 * dense
  const cIntersection = 0.35 * intersection
  const cRoadType = roadTypePenalty
  const cSidewalk = -0.22 * sidewalk

  const risk =
    cTraffic + cSpeed + cLanes + cDense + cIntersection + cRoadType + cSidewalk

  // Convert risk -> predicted accidents (rough scale)
  const predicted = Math.max(0, 0.5 + 22 * Math.pow(clamp01(risk / 1.6), 1.7))

  // Convert predicted accidents -> safety score (exp decay)
  const safety = Math.exp(-0.08 * predicted)

  const notes: string[] = []
  if (!row.sidewalk_present) notes.push('No sidewalk present increases predicted risk in this baseline model.')
  if (row.is_intersection) notes.push('Intersections are modeled as higher risk due to conflict points.')
  if (row.traffic_volume >= 20000) notes.push('High traffic volume strongly increases predicted risk.')
  if (row.speed_limit >= 40) notes.push('Higher speed limits increase predicted severity/risk.')

  return {
    predicted_accident_count: predicted,
    safety_score: clamp01(safety),
    explanation: {
      risk: {
        total: risk,
        contributions: {
          traffic_volume: cTraffic,
          speed_limit: cSpeed,
          num_lanes: cLanes,
          urban_density: cDense,
          is_intersection: cIntersection,
          road_type: cRoadType,
          sidewalk_present: cSidewalk,
        },
      },
      normalized: {
        traffic_volume: tv,
        speed_limit: spd,
        num_lanes: lanes,
        urban_density: dense,
        is_intersection: intersection,
        sidewalk_present: sidewalk,
      },
      notes,
    },
  }
}

