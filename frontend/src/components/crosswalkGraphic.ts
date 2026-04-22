/**
 * Builds GeoJSON for a “zebra” crosswalk graphic (white bars across the road + ladder edges).
 * Uses meter-scale offsets on the WGS84 ellipsoid (good enough at city scale).
 */

export const CROSSWALK_SIM_SOURCE_ID = 'crosswalk-sim'

export type LngLat = [number, number]

type SafetyLike = {
  geometry?: GeoJSON.Geometry
  properties?: { segment_id?: string }
}

/** Move from (lng, lat) by bearing (deg clockwise from N) and distance (m). */
export function destination(lng: number, lat: number, bearingDeg: number, distM: number): LngLat {
  const R = 6371000
  const br = (bearingDeg * Math.PI) / 180
  const lat1 = (lat * Math.PI) / 180
  const lng1 = (lng * Math.PI) / 180
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(distM / R) + Math.cos(lat1) * Math.sin(distM / R) * Math.cos(br),
  )
  const lng2 =
    lng1 +
    Math.atan2(
      Math.sin(br) * Math.sin(distM / R) * Math.cos(lat1),
      Math.cos(distM / R) - Math.sin(lat1) * Math.sin(lat2),
    )
  return [(lng2 * 180) / Math.PI, (lat2 * 180) / Math.PI]
}

function bearing(a: LngLat, b: LngLat): number {
  const [lng1, lat1] = a.map((d) => (d * Math.PI) / 180)
  const [lng2, lat2] = b.map((d) => (d * Math.PI) / 180)
  const y = Math.sin(lng2 - lng1) * Math.cos(lat2)
  const x =
    Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(lng2 - lng1)
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360
}

function haversineM(a: LngLat, b: LngLat): number {
  const R = 6371000
  const [lng1, lat1] = a
  const [lng2, lat2] = b
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLng = ((lng2 - lng1) * Math.PI) / 180
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)))
}

function nearestPointOnLineString(
  coords: [number, number][],
  lng: number,
  lat: number,
): { point: LngLat; segIndex: number } {
  let bestD = Infinity
  let best: { point: LngLat; segIndex: number } = { point: [lng, lat], segIndex: 0 }
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i]!
    const b = coords[i + 1]!
    const ax = a[0],
      ay = a[1],
      bx = b[0],
      by = b[1]
    const abx = bx - ax,
      aby = by - ay
    const apx = lng - ax,
      apy = lat - ay
    const ab2 = abx * abx + aby * aby
    const t = ab2 < 1e-22 ? 0 : Math.max(0, Math.min(1, (apx * abx + apy * aby) / ab2))
    const px = ax + t * abx
    const py = ay + t * aby
    const d = haversineM([px, py], [lng, lat])
    if (d < bestD) {
      bestD = d
      best = { point: [px, py], segIndex: i }
    }
  }
  return best
}

function nearestRoadBearingFromSegments(point: LngLat, segments: SafetyLike[]): number | null {
  let bestD = Infinity
  let bestB: number | null = null
  for (const f of segments) {
    const g = f.geometry
    if (!g || g.type !== 'LineString' || !Array.isArray((g as GeoJSON.LineString).coordinates)) continue
    const coords = (g as GeoJSON.LineString).coordinates as [number, number][]
    if (coords.length < 2) continue
    const np = nearestPointOnLineString(coords, point[0], point[1])
    const d = haversineM(np.point, point)
    if (d < bestD && d < 250) {
      bestD = d
      const i = np.segIndex
      bestB = bearing(coords[i]!, coords[i + 1]!)
    }
  }
  return bestB
}

const ROAD_HALF_WIDTH_M = 5.5
const CROSSWALK_HALF_LENGTH_M = 3.2
const STRIPE_WIDTH_M = 0.4
const STRIPE_GAP_M = 0.35

/**
 * White zebra stripes + yellow ladder rails, aligned across the road at `dropLngLat` when possible.
 */
export function buildCrosswalkZebraGeoJSON(
  feature: SafetyLike,
  dropLngLat: LngLat,
  lineSegmentsForContext: SafetyLike[],
): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = []
  const geom = feature.geometry
  let roadBearing: number | null = null
  let center: LngLat = dropLngLat

  if (geom?.type === 'LineString' && Array.isArray(geom.coordinates) && geom.coordinates.length >= 2) {
    const coords = geom.coordinates as [number, number][]
    const np = nearestPointOnLineString(coords, dropLngLat[0], dropLngLat[1])
    center = np.point
    const i = np.segIndex
    roadBearing = bearing(coords[i]!, coords[i + 1]!)
  } else if (geom?.type === 'Point' && Array.isArray(geom.coordinates)) {
    center = [geom.coordinates[0]!, geom.coordinates[1]!] as LngLat
    roadBearing = nearestRoadBearingFromSegments(center, lineSegmentsForContext)
  }

  if (roadBearing == null) {
    roadBearing = 90
  }

  const perp = (roadBearing + 90) % 360

  const step = STRIPE_WIDTH_M + STRIPE_GAP_M
  const n = Math.max(5, Math.floor((2 * CROSSWALK_HALF_LENGTH_M) / step))
  const startOff = -CROSSWALK_HALF_LENGTH_M + STRIPE_WIDTH_M / 2

  for (let k = 0; k < n; k++) {
    const along = startOff + k * step
    const cx = destination(center[0], center[1], roadBearing, along)
    const a = destination(cx[0], cx[1], perp, -ROAD_HALF_WIDTH_M)
    const b = destination(cx[0], cx[1], perp, ROAD_HALF_WIDTH_M)
    features.push({
      type: 'Feature',
      properties: { kind: 'stripe' },
      geometry: { type: 'LineString', coordinates: [a, b] },
    })
  }

  const c1 = destination(center[0], center[1], roadBearing, -CROSSWALK_HALF_LENGTH_M)
  const c2 = destination(center[0], center[1], roadBearing, CROSSWALK_HALF_LENGTH_M)
  const e1a = destination(c1[0], c1[1], perp, -ROAD_HALF_WIDTH_M)
  const e1b = destination(c1[0], c1[1], perp, ROAD_HALF_WIDTH_M)
  const e2a = destination(c2[0], c2[1], perp, -ROAD_HALF_WIDTH_M)
  const e2b = destination(c2[0], c2[1], perp, ROAD_HALF_WIDTH_M)

  features.push(
    {
      type: 'Feature',
      properties: { kind: 'edge' },
      geometry: { type: 'LineString', coordinates: [e1a, e1b] },
    },
    {
      type: 'Feature',
      properties: { kind: 'edge' },
      geometry: { type: 'LineString', coordinates: [e2a, e2b] },
    },
    {
      type: 'Feature',
      properties: { kind: 'edge' },
      geometry: { type: 'LineString', coordinates: [e1a, e2a] },
    },
    {
      type: 'Feature',
      properties: { kind: 'edge' },
      geometry: { type: 'LineString', coordinates: [e1b, e2b] },
    },
  )

  return { type: 'FeatureCollection', features }
}

export function emptyCrosswalkSimCollection(): GeoJSON.FeatureCollection {
  return { type: 'FeatureCollection', features: [] }
}
