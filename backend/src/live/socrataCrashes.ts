import type { BBox } from './bbox'

export type CrashPoint = { id: string; lng: number; lat: number }

const CRASH_DATASET = 'y2wy-tgr5'
const BASE = `https://data.austintexas.gov/resource/${CRASH_DATASET}.json`

/**
 * Paginated fetch of crash points inside bbox (live City of Austin open data).
 */
export async function fetchAustinCrashesInBBox(bbox: BBox, opts?: { pageSize?: number; maxRows?: number }): Promise<CrashPoint[]> {
  const pageSize = opts?.pageSize ?? 50_000
  const maxRows = opts?.maxRows ?? 200_000
  const where = `latitude is not null and longitude is not null and within_box(point, ${bbox.south}, ${bbox.west}, ${bbox.north}, ${bbox.east})`

  const out: CrashPoint[] = []
  let offset = 0

  while (out.length < maxRows) {
    const params = new URLSearchParams({
      $select: 'id,latitude,longitude',
      $where: where,
      $limit: String(pageSize),
      $offset: String(offset),
    })
    const url = `${BASE}?${params.toString()}`
    const res = await fetch(url, { headers: { accept: 'application/json' } })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Socrata crash fetch failed: ${res.status} ${res.statusText} ${text.slice(0, 200)}`)
    }
    const rows = (await res.json()) as Array<{ id: string; latitude: string; longitude: string }>
    if (!rows.length) break

    for (const r of rows) {
      const lat = Number(r.latitude)
      const lng = Number(r.longitude)
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue
      out.push({ id: String(r.id), lat, lng })
    }

    if (rows.length < pageSize) break
    offset += pageSize
  }

  return out
}
