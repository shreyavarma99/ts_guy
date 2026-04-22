import './env.js'

import express from 'express'
import cors from 'cors'
import { point } from '@turf/turf'

import { getDataLoadState, getSegments, startBackgroundDataLoad } from './dataStore.js'
import { parseGeometry } from './segmentTypes.js'
import { scoreSegment } from './scoring.js'
import type { GeoJsonFeature, GeoJsonFeatureCollection } from './types.js'

const app = express()
app.use(cors())
app.use(express.json({ limit: '32kb' }))

app.get('/health', (_req, res) => {
  const { state, error } = getDataLoadState()
  res.json({ status: 'ok', data: state, error })
})

function dataGuard(_req: express.Request, res: express.Response, next: express.NextFunction) {
  const { state, error } = getDataLoadState()
  if (state === 'ready') return next()
  if (state === 'error') {
    return res.status(500).json({
      type: 'FeatureCollection',
      features: [],
      error: error ?? 'Dataset failed to load',
    })
  }
  return res.status(503).json({
    type: 'FeatureCollection',
    features: [],
    message: 'Dataset is still loading (first run can take several minutes). Retry shortly.',
    data: state,
  })
}

app.get('/segments', dataGuard, (_req, res) => {
  const rows = getSegments()

  const features: GeoJsonFeature[] = []
  for (const row of rows) {
    const geom = parseGeometry(row.geometry)
    if (geom?.type !== 'LineString') continue
    const score = scoreSegment(row)
    features.push({
      type: 'Feature',
      geometry: geom,
      properties: {
        segment_id: row.segment_id,
        ...score,
        traffic_volume: row.traffic_volume,
        speed_limit: row.speed_limit,
        num_lanes: row.num_lanes,
        road_type: row.road_type,
        crosswalk_present: row.crosswalk_present ? 1 : 0,
        is_intersection: row.is_intersection ? 1 : 0,
        urban_density: row.urban_density,
      },
    })
  }

  const fc: GeoJsonFeatureCollection = { type: 'FeatureCollection', features }
  res.json(fc)
})

app.get('/intersections', dataGuard, (req, res) => {
  const maxSafety = Number(req.query.max_safety ?? 0.6)
  const rows = getSegments()

  const features: GeoJsonFeature[] = []
  for (const row of rows) {
    if (!row.is_intersection) continue
    const score = scoreSegment(row)
    if (score.safety_score > maxSafety) continue

    const geom = parseGeometry(row.geometry)
    if (geom?.type !== 'Point') continue
    const coords = (geom as any).coordinates as [number, number]

    const pt = point(coords)
    features.push({
      type: 'Feature',
      geometry: pt.geometry as any,
      properties: {
        segment_id: row.segment_id,
        ...score,
        traffic_volume: row.traffic_volume,
        speed_limit: row.speed_limit,
        num_lanes: row.num_lanes,
        road_type: row.road_type,
        crosswalk_present: row.crosswalk_present ? 1 : 0,
        is_intersection: row.is_intersection ? 1 : 0,
        urban_density: row.urban_density,
      },
    })
  }

  const fc: GeoJsonFeatureCollection = { type: 'FeatureCollection', features }
  res.json(fc)
})

/**
 * What-if: re-score a segment/intersection as if `crosswalk_present` were 1 (ridge model unchanged).
 */
app.post('/what-if/crosswalk', dataGuard, (req, res) => {
  const segmentId =
    typeof req.body?.segment_id === 'string' ? String(req.body.segment_id).trim() : ''
  if (!segmentId) {
    return res.status(400).json({ error: 'JSON body must include segment_id (string).' })
  }

  const rows = getSegments()
  const row = rows.find((r) => r.segment_id === segmentId)
  if (!row) {
    return res.status(404).json({ error: `No segment or intersection with id "${segmentId}".` })
  }

  // What-if always compares "no crosswalk" vs "with crosswalk" so the UI can show 0→1 even if
  // the dataset currently thinks a crosswalk is present (OSM tagging can be noisy).
  const observed = row.crosswalk_present ? 1 : 0
  const baseline = scoreSegment({ ...row, crosswalk_present: 0 })
  const withCrosswalk = scoreSegment({ ...row, crosswalk_present: 1 })

  res.json({
    segment_id: segmentId,
    observed_crosswalk_present: observed,
    baseline: {
      crosswalk_present: 0,
      predicted_accident_count: baseline.predicted_accident_count,
      safety_score: baseline.safety_score,
      explanation: baseline.explanation,
    },
    with_crosswalk: {
      crosswalk_present: 1,
      predicted_accident_count: withCrosswalk.predicted_accident_count,
      safety_score: withCrosswalk.safety_score,
      explanation: withCrosswalk.explanation,
    },
  })
})

const port = Number(process.env.PORT ?? 8000)

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Road Safety API listening on http://localhost:${port}`)
  // eslint-disable-next-line no-console
  console.log('[data] Starting background dataset load (first cold build can take several minutes)...')
  void startBackgroundDataLoad().then(() => {
    const { state, error } = getDataLoadState()
    if (state === 'ready') {
      // eslint-disable-next-line no-console
      console.log('[data] Dataset ready.')
    } else if (state === 'error') {
      // eslint-disable-next-line no-console
      console.error('[data] Dataset in error state:', error)
    }
  })
})
