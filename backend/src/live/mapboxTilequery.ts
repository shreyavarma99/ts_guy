/**
 * Mapbox Tilequery: use Mapbox Streets vector data at a lon/lat to validate
 * road junction complexity (proxy for "intersection" in Mapbox's road network).
 *
 * Docs: https://docs.mapbox.com/api/maps/tilequery/
 */
export async function mapboxRoadFeatureCount(
  accessToken: string,
  lng: number,
  lat: number,
  opts?: { radiusM?: number; limit?: number },
): Promise<{ count: number; classes: string[] }> {
  const radiusM = opts?.radiusM ?? 28
  const limit = opts?.limit ?? 8
  const tileset = 'mapbox.mapbox-streets-v8'
  const url = new URL(`https://api.mapbox.com/v4/${tileset}/tilequery/${lng},${lat}.json`)
  url.searchParams.set('radius', String(radiusM))
  url.searchParams.set('limit', String(limit))
  url.searchParams.set('layers', 'road')
  url.searchParams.set('access_token', accessToken)

  const res = await fetch(url.toString())
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Mapbox tilequery failed: ${res.status} ${text.slice(0, 200)}`)
  }
  const json: any = await res.json()
  const features = Array.isArray(json?.features) ? json.features : []
  const classes = features
    .map((f: any) => String(f?.properties?.class ?? f?.properties?.type ?? ''))
    .filter(Boolean)

  return { count: features.length, classes }
}
