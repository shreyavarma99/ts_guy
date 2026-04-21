import type { BBox } from './bbox'

export type OsmWay = {
  id: number
  highway: string
  nodes: number[]
  coords: [number, number][]
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

export async function fetchOsmHighwayWays(bbox: BBox, opts?: { timeoutSec?: number }): Promise<OsmWay[]> {
  const timeoutSec = opts?.timeoutSec ?? 180
  const q = `[out:json][timeout:${timeoutSec}];
(
  way["highway"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});
);
out geom;
`

  const headers = {
    'content-type': 'text/plain; charset=utf-8',
    accept: '*/*',
    // Some Overpass instances return 406/blocks if the default Node fetch UA is missing or generic.
    'user-agent': 'ts_guy-road-safety/1.0 (+https://github.com/)',
  }

  let lastErr = ''
  for (const url of OVERPASS_ENDPOINTS) {
    const res = await fetch(url, { method: 'POST', headers, body: q })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      lastErr = `${url} -> ${res.status} ${text.slice(0, 160)}`
      continue
    }

    const json: any = await res.json()
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

  throw new Error(`Overpass fetch failed on all mirrors: ${lastErr}`)
}
