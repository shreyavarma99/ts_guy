import { lineString, point, pointToLineDistance } from '@turf/turf'

import type { SegmentRow } from '../segmentTypes.js'
import { parseBBox } from './bbox.js'
import { mapboxRoadFeatureCount } from './mapboxTilequery.js'
import { fetchOsmCrossingNodes, fetchOsmHighwayWays, type OsmCrossingNode, type OsmWay } from './overpassWays.js'
import { fetchAustinCrashesInBBox, type CrashPoint } from './socrataCrashes.js'

const MAJOR = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary'])

function coordKey(c: [number, number]) {
  return `${c[0].toFixed(6)},${c[1].toFixed(6)}`
}

function trafficVolumeProxy(highway: string): number {
  switch (highway) {
    case 'motorway':
      return 55_000
    case 'trunk':
      return 40_000
    case 'primary':
      return 28_000
    case 'secondary':
      return 16_000
    case 'tertiary':
      return 12_000
    case 'residential':
      return 6_000
    case 'living_street':
      return 3_500
    case 'unclassified':
      return 9_000
    case 'service':
      return 4_500
    default:
      return 7_500
  }
}

function parseMaxspeedMph(tags: Record<string, string>, highway: string): number {
  const raw = tags.maxspeed
  if (raw) {
    const m = raw.match(/(\d+)/)
    if (m) {
      let n = Number(m[1])
      if (Number.isFinite(n)) {
        if (raw.toLowerCase().includes('kmh')) n = Math.round(n * 0.621371)
        return clamp(n, 10, 85)
      }
    }
  }
  if (highway === 'motorway') return 70
  if (highway === 'trunk') return 55
  if (highway === 'primary') return 45
  if (highway === 'secondary') return 40
  if (highway === 'tertiary') return 35
  if (highway === 'residential' || highway === 'living_street') return 30
  return 35
}

function parseLanes(tags: Record<string, string>, highway: string): number {
  const raw = tags.lanes
  if (raw) {
    const m = raw.match(/(\d+)/)
    if (m) return clamp(Number(m[1]), 1, 8)
  }
  if (highway === 'motorway' || highway === 'trunk') return 3
  if (highway === 'primary' || highway === 'secondary') return 2
  return 1
}

/**
 * OSM rarely puts `crossing=*` on drivable `highway=*` ways, but when it does we treat it as
 * a marked / controlled crossing. Also checks a few auxiliary tags used in some regions.
 */
function crosswalkPresentFromTags(tags: Record<string, string>): number {
  const crossing = (tags.crossing ?? '').toLowerCase()
  if (crossing === 'no' || crossing === 'false') return 0
  const positiveCrossing = new Set([
    'zebra',
    'traffic_signals',
    'marked',
    'uncontrolled',
    'island',
    'traffic_calming',
    'yes',
    'informal',
    'unmarked',
  ])
  if (crossing && positiveCrossing.has(crossing)) return 1

  const signals = (tags['crossing:signals'] ?? '').toLowerCase()
  if (signals === 'yes' || signals === 'button') return 1

  const zebra = (tags['crossing:zebra'] ?? '').toLowerCase()
  if (zebra === 'yes') return 1

  const marked = (tags['crossing:marked'] ?? '').toLowerCase()
  if (marked === 'yes') return 1

  const ped = (tags['pedestrian_crossing'] ?? '').toLowerCase()
  if (ped === 'yes' || ped === 'traffic_signals') return 1

  return 0
}

/** Distance from segment polyline to nearest `highway=crossing` node (OSM pattern). */
const CROSSING_NODE_JOIN_RADIUS_M = 22

function crossingBuckets(nodes: OsmCrossingNode[], cell = 0.01): Map<string, OsmCrossingNode[]> {
  const m = new Map<string, OsmCrossingNode[]>()
  for (const n of nodes) {
    const key = `${Math.floor(n.lng / cell)}:${Math.floor(n.lat / cell)}`
    const arr = m.get(key) ?? []
    arr.push(n)
    m.set(key, arr)
  }
  return m
}

function crossingNearLine(coords: [number, number][], buckets: Map<string, OsmCrossingNode[]>, radiusM: number, cell = 0.01): boolean {
  if (coords.length < 2 || buckets.size === 0) return false
  const ls = lineString(coords)
  const bb = bboxOfCoords(coords, 0.003)
  const ix0 = Math.floor(bb.minLng / cell)
  const ix1 = Math.floor(bb.maxLng / cell)
  const iy0 = Math.floor(bb.minLat / cell)
  const iy1 = Math.floor(bb.maxLat / cell)
  for (let ix = ix0 - 1; ix <= ix1 + 1; ix++) {
    for (let iy = iy0 - 1; iy <= iy1 + 1; iy++) {
      const arr = buckets.get(`${ix}:${iy}`)
      if (!arr) continue
      for (const n of arr) {
        const d = pointToLineDistance(point([n.lng, n.lat]), ls, { units: 'meters' })
        if (d <= radiusM) return true
      }
    }
  }
  return false
}

function crossingNearPoint(lng: number, lat: number, buckets: Map<string, OsmCrossingNode[]>, radiusM: number, cell = 0.01): boolean {
  if (buckets.size === 0) return false
  const ix = Math.floor(lng / cell)
  const iy = Math.floor(lat / cell)
  for (let dx = -2; dx <= 2; dx++) {
    for (let dy = -2; dy <= 2; dy++) {
      const arr = buckets.get(`${ix + dx}:${iy + dy}`)
      if (!arr) continue
      for (const n of arr) {
        if (haversineMeters(lat, lng, n.lat, n.lng) <= radiusM) return true
      }
    }
  }
  return false
}

function crosswalkPresentCombined(tags: Record<string, string>, nearCrossingNode: boolean): number {
  if (crosswalkPresentFromTags(tags)) return 1
  return nearCrossingNode ? 1 : 0
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n))
}

function crashBuckets(crashes: CrashPoint[], cell = 0.01): Map<string, CrashPoint[]> {
  const m = new Map<string, CrashPoint[]>()
  for (const c of crashes) {
    const key = `${Math.floor(c.lng / cell)}:${Math.floor(c.lat / cell)}`
    const arr = m.get(key) ?? []
    arr.push(c)
    m.set(key, arr)
  }
  return m
}

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371000
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2)
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  return R * c
}

function crashesNearPoint(buckets: Map<string, CrashPoint[]>, lng: number, lat: number, radiusM: number, cell = 0.01) {
  const ix = Math.floor(lng / cell)
  const iy = Math.floor(lat / cell)
  const out: CrashPoint[] = []
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const arr = buckets.get(`${ix + dx}:${iy + dy}`)
      if (!arr) continue
      for (const c of arr) {
        const dist = haversineMeters(c.lat, c.lng, lat, lng)
        if (dist <= radiusM) out.push(c)
      }
    }
  }
  return out
}

function bboxOfCoords(coords: [number, number][], pad = 0.002) {
  let minLng = Infinity,
    minLat = Infinity,
    maxLng = -Infinity,
    maxLat = -Infinity
  for (const [lng, lat] of coords) {
    minLng = Math.min(minLng, lng)
    minLat = Math.min(minLat, lat)
    maxLng = Math.max(maxLng, lng)
    maxLat = Math.max(maxLat, lat)
  }
  return { minLng: minLng - pad, minLat: minLat - pad, maxLng: maxLng + pad, maxLat: maxLat + pad }
}

function countCrashesNearLine(coords: [number, number][], buckets: Map<string, CrashPoint[]>, radiusM: number) {
  const ls = lineString(coords)
  const bb = bboxOfCoords(coords, 0.002)
  let n = 0
  const seen = new Set<string>()
  const cell = 0.01
  const ix0 = Math.floor(bb.minLng / cell)
  const ix1 = Math.floor(bb.maxLng / cell)
  const iy0 = Math.floor(bb.minLat / cell)
  const iy1 = Math.floor(bb.maxLat / cell)
  for (let ix = ix0 - 1; ix <= ix1 + 1; ix++) {
    for (let iy = iy0 - 1; iy <= iy1 + 1; iy++) {
      const arr = buckets.get(`${ix}:${iy}`)
      if (!arr) continue
      for (const c of arr) {
        if (c.lng < bb.minLng || c.lng > bb.maxLng || c.lat < bb.minLat || c.lat > bb.maxLat) continue
        const d = pointToLineDistance(point([c.lng, c.lat]), ls, { units: 'meters' })
        if (d <= radiusM && !seen.has(c.id)) {
          seen.add(c.id)
          n++
        }
      }
    }
  }
  return n
}

function wayRankForCap(w: OsmWay) {
  const major = MAJOR.has(w.highway) ? 1000 : 0
  return major + trafficVolumeProxy(w.highway) + w.coords.length
}

function pickDominantWayAtCoord(waysAtPoint: OsmWay[], coord: [number, number]): OsmWay {
  const score = (w: OsmWay) => {
    const major = MAJOR.has(w.highway) ? 10 : 0
    const tv = trafficVolumeProxy(w.highway) / 1000
    const dist = Math.min(...w.coords.map((c) => haversineMeters(coord[1], coord[0], c[1], c[0])))
    return major + tv - dist / 1000
  }
  return [...waysAtPoint].sort((a, b) => score(b) - score(a))[0]!
}

function nearestWay(waysAll: OsmWay[], coord: [number, number]): OsmWay {
  let best = waysAll[0]!
  let bestD = Infinity
  const p = point(coord)
  for (const w of waysAll) {
    if (w.coords.length < 2) continue
    const d = pointToLineDistance(p, lineString(w.coords), { units: 'meters' })
    if (d < bestD) {
      bestD = d
      best = w
    }
  }
  return best
}

function urbanDensityFromCounts(localCrashCount: number, maxLocal: number) {
  if (maxLocal <= 0) return 0.5
  return clamp(localCrashCount / maxLocal, 0, 1)
}

type Cand = { key: string; coord: [number, number]; degree: number; major: boolean; score: number }

export async function buildLiveSegmentRows(env: {
  mapboxToken: string
  bboxRaw?: string
  maxWaysRender?: number
  maxWaysTopo?: number
  maxIntersectionCandidates?: number
  maxIntersections?: number
  maxCrashRows?: number
}): Promise<SegmentRow[]> {
  const bbox = parseBBox(env.bboxRaw)
  const maxWaysRender = env.maxWaysRender ?? 2500
  const maxWaysTopo = env.maxWaysTopo ?? 6500
  const maxIntersectionCandidates = env.maxIntersectionCandidates ?? 900
  const maxIntersections = env.maxIntersections ?? 250
  const maxCrashRows = env.maxCrashRows ?? 120_000

  const [crashes, waysAllRaw, crossingNodes] = await Promise.all([
    fetchAustinCrashesInBBox(bbox, { maxRows: maxCrashRows }),
    fetchOsmHighwayWays(bbox),
    fetchOsmCrossingNodes(bbox),
  ])

  const buckets = crashBuckets(crashes)
  const crossBuckets = crossingBuckets(crossingNodes)

  const waysAll = [...waysAllRaw].sort((a, b) => wayRankForCap(b) - wayRankForCap(a)).slice(0, maxWaysTopo)
  const waysRender = waysAll.slice(0, maxWaysRender)

  // OSM-derived junction candidates: vertices shared by multiple ways (within capped topo set)
  const coordToWayIds = new Map<string, Set<number>>()
  for (const w of waysAll) {
    const seen = new Set<string>()
    for (const c of w.coords) {
      const k = coordKey(c)
      if (seen.has(k)) continue
      seen.add(k)
      const set = coordToWayIds.get(k) ?? new Set<number>()
      set.add(w.id)
      coordToWayIds.set(k, set)
    }
  }

  const cands: Cand[] = []
  for (const [key, set] of coordToWayIds.entries()) {
    const degree = set.size
    if (degree < 2) continue

    const wayObjs = [...set]
      .map((id) => waysAll.find((w) => w.id === id))
      .filter(Boolean) as OsmWay[]

    const major = wayObjs.some((w) => MAJOR.has(w.highway))
    if (degree < 3 && !major) continue

    const [lngS, latS] = key.split(',')
    const coord: [number, number] = [Number(lngS), Number(latS)]
    const score = degree + (major ? 2 : 0)
    cands.push({ key, coord, degree, major, score })
  }

  cands.sort((a, b) => b.score - a.score)
  const candSlice = cands.slice(0, maxIntersectionCandidates)

  // Mapbox Streets tilequery confirms "road network complexity" near the OSM candidate.
  const confirmed: Array<{ coord: [number, number] }> = []
  for (const c of candSlice) {
    const { count } = await mapboxRoadFeatureCount(env.mapboxToken, c.coord[0], c.coord[1])
    if (count >= 2) confirmed.push({ coord: c.coord })
    if (confirmed.length >= maxIntersections) break
    await new Promise((r) => setTimeout(r, 15))
  }

  const wayAccidents = waysRender.map((w) => countCrashesNearLine(w.coords, buckets, 22))
  const maxWayAcc = Math.max(1, ...wayAccidents)

  const rows: SegmentRow[] = []

  for (let i = 0; i < waysRender.length; i++) {
    const w = waysRender[i]!
    const accident_count = wayAccidents[i] ?? 0
    rows.push({
      segment_id: `osm-way/${w.id}`,
      geometry: JSON.stringify({ type: 'LineString', coordinates: w.coords }),
      accident_count,
      traffic_volume: trafficVolumeProxy(w.highway),
      speed_limit: parseMaxspeedMph(w.tags, w.highway),
      num_lanes: parseLanes(w.tags, w.highway),
      road_type: w.highway,
      crosswalk_present: crosswalkPresentCombined(
        w.tags,
        crossingNearLine(w.coords, crossBuckets, CROSSING_NODE_JOIN_RADIUS_M),
      ),
      is_intersection: 0,
      urban_density: urbanDensityFromCounts(accident_count, maxWayAcc),
    })
  }

  const maxIxAcc = Math.max(30, maxWayAcc)
  for (const { coord } of confirmed) {
    const key = coordKey(coord)
    const set = coordToWayIds.get(key) ?? new Set<number>()
    const wayObjs = [...set]
      .map((id) => waysAll.find((w) => w.id === id))
      .filter(Boolean) as OsmWay[]

    const dom = wayObjs.length ? pickDominantWayAtCoord(wayObjs, coord) : nearestWay(waysAll, coord)

    const nearby = crashesNearPoint(buckets, coord[0], coord[1], 42)
    const accident_count = new Set(nearby.map((c) => c.id)).size

    rows.push({
      segment_id: `mapbox-ix/${key}`,
      geometry: JSON.stringify({ type: 'Point', coordinates: coord }),
      accident_count,
      traffic_volume: trafficVolumeProxy(dom.highway),
      speed_limit: parseMaxspeedMph(dom.tags, dom.highway),
      num_lanes: parseLanes(dom.tags, dom.highway),
      road_type: dom.highway,
      crosswalk_present: crosswalkPresentCombined(
        dom.tags,
        crossingNearPoint(coord[0], coord[1], crossBuckets, CROSSING_NODE_JOIN_RADIUS_M),
      ),
      is_intersection: 1,
      urban_density: urbanDensityFromCounts(accident_count, maxIxAcc),
    })
  }

  return rows
}
