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
        sidewalk_present: row.sidewalk_present ? 1 : 0,
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
        sidewalk_present: row.sidewalk_present ? 1 : 0,
        is_intersection: row.is_intersection ? 1 : 0,
        urban_density: row.urban_density,
      },
    })
  }

  const fc: GeoJsonFeatureCollection = { type: 'FeatureCollection', features }
  res.json(fc)
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
