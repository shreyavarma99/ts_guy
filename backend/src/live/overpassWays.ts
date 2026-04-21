import type { BBox } from './bbox'

export type OsmWay = {
  id: number
  highway: string
  nodes: number[]
  coords: [number, number][]
  tags: Record<string, string>
}

/** OSM node with highway=crossing (often carries crossing=* where ways do not). */
export type OsmCrossingNode = {
  id: number
  lng: number
  lat: number
  tags: Record<string, string>
}

const EXCLUDED = new Set([
  'footway',
  'path',
  'steps',
  'pedestrian',
  'corridor',
  'elevator',
  'bridleway',
  'cycleway',
])

// Prefer mirrors that are less likely to rate-limit / block automated requests.
const OVERPASS_ENDPOINTS = [
  'https://overpass.openstreetmap.fr/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass-api.de/api/interpreter',
]

const DEFAULT_HEADERS = {
  'content-type': 'text/plain; charset=utf-8',
  accept: '*/*',
  'user-agent': 'ts_guy-road-safety/1.0 (+https://github.com/)',
}

async function postOverpass(body: string, timeoutSec: number): Promise<any> {
  let lastErr = ''
  for (const url of OVERPASS_ENDPOINTS) {
    const res = await fetch(url, { method: 'POST', headers: DEFAULT_HEADERS, body })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      lastErr = `${url} -> ${res.status} ${text.slice(0, 160)}`
      continue
    }
    return res.json()
  }
  throw new Error(`Overpass fetch failed on all mirrors: ${lastErr}`)
}

export async function fetchOsmHighwayWays(bbox: BBox, opts?: { timeoutSec?: number }): Promise<OsmWay[]> {
  const timeoutSec = opts?.timeoutSec ?? 180
  const q = `[out:json][timeout:${timeoutSec}];
(
  way["highway"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});
);
out geom;
`

  const json: any = await postOverpass(q, timeoutSec)
  const elements = Array.isArray(json?.elements) ? json.elements : []
  const ways: OsmWay[] = []

  for (const el of elements) {
    if (el?.type !== 'way') continue
    const hw = String(el.tags?.highway ?? '')
    if (!hw || EXCLUDED.has(hw)) continue
    const geom = Array.isArray(el.geometry) ? el.geometry : []
    const coords: [number, number][] = []
    for (const n of geom) {
      const lon = Number(n.lon)
      const lat = Number(n.lat)
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue
      coords.push([lon, lat])
    }
    if (coords.length < 2) continue

    ways.push({
      id: Number(el.id),
      highway: hw,
      nodes: Array.isArray(el.nodes) ? el.nodes.map(Number) : [],
      coords,
      tags: el.tags && typeof el.tags === 'object' ? (el.tags as Record<string, string>) : {},
    })
  }

  return ways
}

function crossingNodeIsPositive(tags: Record<string, string>): boolean {
  const c = (tags.crossing ?? '').toLowerCase()
  if (c === 'no' || c === 'false') return false
  return true
}

/**
 * Pedestrian crossing nodes in the bbox (highway=crossing). Excludes explicit crossing=no.
 */
export async function fetchOsmCrossingNodes(bbox: BBox, opts?: { timeoutSec?: number }): Promise<OsmCrossingNode[]> {
  const timeoutSec = opts?.timeoutSec ?? 120
  const q = `[out:json][timeout:${timeoutSec}];
node["highway"="crossing"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});
out;
`

  const json: any = await postOverpass(q, timeoutSec)
  const elements = Array.isArray(json?.elements) ? json.elements : []
  const out: OsmCrossingNode[] = []

  for (const el of elements) {
    if (el?.type !== 'node') continue
    const lon = Number(el.lon)
    const lat = Number(el.lat)
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue
    const tags = el.tags && typeof el.tags === 'object' ? (el.tags as Record<string, string>) : {}
    if (!crossingNodeIsPositive(tags)) continue

    out.push({
      id: Number(el.id),
      lng: lon,
      lat,
      tags,
    })
  }

  return out
}
