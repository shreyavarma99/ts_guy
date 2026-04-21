import { useEffect, useMemo, useRef, useState } from 'react'
import mapboxgl, { type AnyLayer, type Map as MapboxMap } from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import styles from './MapView.module.css'

const MAPBOX_STYLE = 'mapbox://styles/mapbox/satellite-streets-v12'
const SAFETY_SEGMENTS_SOURCE_ID = 'safety-segments'
const SAFETY_INTERSECTIONS_SOURCE_ID = 'safety-intersections'
const SELECTED_INTERSECTION_LAYER_ID = 'selected-intersection'
const SELECTED_SEGMENT_LAYER_ID = 'selected-segment'

function getApiBase(): string {
  return (import.meta.env.VITE_API_BASE as string | undefined) ?? 'http://localhost:8000'
}

type SafetyFeature = GeoJSON.Feature<
  GeoJSON.Geometry,
  {
    segment_id: string
    predicted_accident_count: number
    safety_score: number
    explanation?: unknown
    [k: string]: unknown
  }
>

type FeatureCollection = GeoJSON.FeatureCollection<GeoJSON.Geometry, any>

function getToken(): string {
  const token = import.meta.env.VITE_MAPBOX_TOKEN as string | undefined
  if (!token) {
    throw new Error(
      'Missing Mapbox token. Set VITE_MAPBOX_TOKEN in frontend/.env.local (or .env).',
    )
  }
  return token
}

export function MapView() {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<MapboxMap | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [segments, setSegments] = useState<SafetyFeature[]>([])
  const [intersections, setIntersections] = useState<SafetyFeature[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [unsafeCutoff, setUnsafeCutoff] = useState<number>(0.95)

  const selected = useMemo(() => {
    if (!selectedId) return null
    return (
      intersections.find((f) => f.properties?.segment_id === selectedId) ??
      segments.find((f) => f.properties?.segment_id === selectedId) ??
      null
    )
  }, [intersections, segments, selectedId])

  useEffect(() => {
    if (!containerRef.current) return
    if (mapRef.current) return

    if (!mapboxgl.supported()) {
      setError(
        'Mapbox cannot start in this browser/environment (WebGL not supported).',
      )
      return
    }

    let token: string
    try {
      token = getToken()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return
    }

    mapboxgl.accessToken = token

    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: MAPBOX_STYLE,
      center: [-97.7431, 30.2672], // Austin (matches demo backend data)
      zoom: 14,
      pitch: 60,
      bearing: -17,
      antialias: true,
    })

    mapRef.current = map

    map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), 'top-right')
    map.addControl(new mapboxgl.FullscreenControl(), 'top-right')

    map.on('error', (e) => {
      const msg =
        (e as any)?.error?.message ??
        (e as any)?.error?.toString?.() ??
        (e as any)?.message ??
        'Mapbox error'
      setError(String(msg))
    })

    map.on('style.load', () => {
      // Terrain (hills/mountains) for more 3D context.
      map.addSource('mapbox-dem', {
        type: 'raster-dem',
        url: 'mapbox://mapbox.mapbox-terrain-dem-v1',
        tileSize: 512,
        maxzoom: 14,
      })

      map.setTerrain({ source: 'mapbox-dem', exaggeration: 1.25 })

      map.addLayer({
        id: 'sky',
        type: 'sky',
        paint: {
          'sky-type': 'atmosphere',
          'sky-atmosphere-sun': [0.0, 0.0],
          'sky-atmosphere-sun-intensity': 15,
        },
      })

      // Add 3D buildings. Most Mapbox styles have a `composite` source
      // with a `building` layer that includes `extrude` info.
      const layers = map.getStyle().layers ?? []
      const labelLayerId = layers.find((l) => l.type === 'symbol' && (l.layout as any)?.['text-field'])
        ?.id

      const buildings3d: AnyLayer = {
        id: 'buildings-3d',
        source: 'composite',
        'source-layer': 'building',
        type: 'fill-extrusion',
        minzoom: 14,
        filter: ['==', ['get', 'extrude'], 'true'],
        paint: {
          'fill-extrusion-color': '#aaa',
          'fill-extrusion-opacity': 1,
          'fill-extrusion-height': [
            'interpolate',
            ['linear'],
            ['zoom'],
            14,
            0,
            14.2,
            ['coalesce', ['get', 'height'], 0],
          ],
          'fill-extrusion-base': ['coalesce', ['get', 'min_height'], 0],
        },
      }

      try {
        map.addLayer(buildings3d, labelLayerId)
      } catch {
        // If the style doesn't have the expected source/layer, fail gracefully.
      }

      // Slight fog improves depth perception (especially with terrain).
      try {
        map.setFog({
          range: [0.5, 10],
          color: '#d6ecff',
          'high-color': '#add8ff',
          'space-color': '#000000',
          'star-intensity': 0.15,
        })
      } catch {
        // Older style specs may not support fog; ignore.
      }

      void loadSafetyLayers(map, {
        onData: (next) => {
          setSegments(next.segments)
          setIntersections(next.intersections)
          // default-select the worst (lowest safety) intersection if available
          const worst = [...next.intersections].sort(
            (a, b) => (a.properties?.safety_score ?? 1) - (b.properties?.safety_score ?? 1),
          )[0]
          if (worst && !selectedId) setSelectedId(worst.properties.segment_id)
        },
        onError: (e) => setError(e instanceof Error ? e.message : String(e)),
      }, unsafeCutoff)
    })

    return () => {
      mapRef.current = null
      map.remove()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    if (!selected) return

    const { lng, lat } = getFeatureCenter(selected)
    map.flyTo({ center: [lng, lat], zoom: Math.max(map.getZoom(), 16), speed: 1.2, curve: 1.4 })

    // highlight selection on-map (no heatmap/overlay coloring)
    setSelectedSources(map, selected)
  }, [selected])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    void refreshIntersections(map, unsafeCutoff)
      .then((next) => {
        setIntersections(next)
        if (selectedId && !next.some((f) => f.properties?.segment_id === selectedId)) {
          setSelectedId(next[0]?.properties?.segment_id ?? null)
        }
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unsafeCutoff])

  return (
    <div className={styles.root}>
      <div ref={containerRef} className={styles.map} />
      <div className={styles.sidebar}>
        <div className={styles.sidebarHeader}>Safety dashboard</div>
        <div className={styles.sidebarSub}>
          Click a location to fly there and view why it scored that way.
        </div>

        <div className={styles.sectionTitle}>Intersections (unsafe)</div>
        <div className={styles.cutoffRow}>
          <label className={styles.cutoffLabel}>
            unsafe cutoff <span className={styles.mono}>{unsafeCutoff.toFixed(2)}</span>
          </label>
          <input
            className={styles.cutoff}
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={unsafeCutoff}
            onChange={(e) => setUnsafeCutoff(Number(e.target.value))}
          />
        </div>
        <div className={styles.list}>
          {intersections.map((f) => {
            const id = f.properties.segment_id
            const { lng, lat } = getFeatureCenter(f)
            const score = Number(f.properties.safety_score ?? 0)
            const active = selectedId === id
            return (
              <button
                key={id}
                className={`${styles.listItem} ${active ? styles.listItemActive : ''}`}
                onClick={() => setSelectedId(id)}
              >
                <div className={styles.listItemTop}>
                  <div className={styles.mono}>{id}</div>
                  <div className={styles.scorePill}>score {score.toFixed(3)}</div>
                </div>
                <div className={styles.monoMuted}>
                  {lat.toFixed(5)}, {lng.toFixed(5)}
                </div>
              </button>
            )
          })}
          {intersections.length === 0 ? (
            <div className={styles.empty}>
              No intersections under cutoff {unsafeCutoff.toFixed(2)}. Slide the cutoff higher to
              include more.
            </div>
          ) : null}
        </div>

        <div className={styles.sectionTitle}>Details</div>
        {selected ? (
          <SafetyDetails feature={selected} />
        ) : (
          <div className={styles.empty}>Select a location.</div>
        )}
      </div>
      {error ? (
        <div className={styles.error}>
          <div className={styles.errorTitle}>Map failed to load</div>
          <div className={styles.errorText}>{error}</div>
          <div className={styles.errorText}>
            Ensure your token is in <code>frontend/.env.local</code> as{' '}
            <code>VITE_MAPBOX_TOKEN=...</code> and restart <code>npm run dev</code>.
          </div>
          <div className={styles.errorText}>
            Also ensure the backend is running at <code>{getApiBase()}</code>.
          </div>
        </div>
      ) : null}
    </div>
  )
}

async function loadSafetyLayers(
  map: MapboxMap,
  handlers: {
    onData: (next: { segments: SafetyFeature[]; intersections: SafetyFeature[] }) => void
    onError: (e: unknown) => void
  },
  unsafeCutoff: number,
) {
  const apiBase = getApiBase().replace(/\/+$/, '')

  const [segments, intersections] = await Promise.all([
    fetchJson(`${apiBase}/segments`),
    fetchJson(`${apiBase}/intersections?max_safety=${encodeURIComponent(String(unsafeCutoff))}`),
  ])

  const segmentFeatures = (segments as FeatureCollection).features as SafetyFeature[]
  const intersectionFeatures = (intersections as FeatureCollection).features as SafetyFeature[]
  handlers.onData({ segments: segmentFeatures, intersections: intersectionFeatures })

  // Segments
  if (map.getSource(SAFETY_SEGMENTS_SOURCE_ID)) {
    ;(map.getSource(SAFETY_SEGMENTS_SOURCE_ID) as mapboxgl.GeoJSONSource).setData(segments)
  } else {
    map.addSource(SAFETY_SEGMENTS_SOURCE_ID, {
      type: 'geojson',
      data: segments,
    })

    map.addLayer({
      id: 'safety-segments-line',
      type: 'line',
      source: SAFETY_SEGMENTS_SOURCE_ID,
      filter: ['==', ['geometry-type'], 'LineString'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-width': ['interpolate', ['linear'], ['zoom'], 11, 2, 15, 5, 18, 10],
        'line-opacity': 0.55,
        'line-color': '#ffffff',
      },
    })
  }

  // Intersections (unsafe)
  if (map.getSource(SAFETY_INTERSECTIONS_SOURCE_ID)) {
    ;(map.getSource(SAFETY_INTERSECTIONS_SOURCE_ID) as mapboxgl.GeoJSONSource).setData(
      intersections,
    )
  } else {
    map.addSource(SAFETY_INTERSECTIONS_SOURCE_ID, {
      type: 'geojson',
      data: intersections,
    })

    map.addLayer({
      id: 'safety-intersections',
      type: 'circle',
      source: SAFETY_INTERSECTIONS_SOURCE_ID,
      filter: ['==', ['geometry-type'], 'Point'],
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 4, 15, 8, 18, 12],
        'circle-color': '#ff3b30',
        'circle-opacity': 0.95,
        'circle-stroke-width': 2,
        'circle-stroke-color': '#fff',
      },
    })
  }

  ensureSelectionLayers(map)
}

async function refreshIntersections(map: MapboxMap, unsafeCutoff: number): Promise<SafetyFeature[]> {
  const apiBase = getApiBase().replace(/\/+$/, '')
  const intersections = await fetchJson(
    `${apiBase}/intersections?max_safety=${encodeURIComponent(String(unsafeCutoff))}`,
  )
  const intersectionFeatures = (intersections as FeatureCollection).features as SafetyFeature[]

  if (map.getSource(SAFETY_INTERSECTIONS_SOURCE_ID)) {
    ;(map.getSource(SAFETY_INTERSECTIONS_SOURCE_ID) as mapboxgl.GeoJSONSource).setData(intersections)
  }

  return intersectionFeatures
}

async function fetchJson(url: string) {
  const maxAttempts = 360 // ~12 minutes if mostly 3s sleeps
  let lastMessage = ''

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' } })

      if (res.status === 503) {
        const body = await res.json().catch(() => null)
        lastMessage =
          (body && typeof body === 'object' && 'message' in body && String((body as any).message)) ||
          'Backend is still building the Austin dataset.'
        await new Promise((r) => setTimeout(r, 3000))
        continue
      }

      if (res.status === 500) {
        const text = await res.text()
        let err = text
        try {
          const body = JSON.parse(text) as { error?: string }
          if (body?.error) err = body.error
        } catch {
          // use raw text
        }
        throw new Error(err || `Backend error ${res.status}`)
      }

      if (!res.ok) throw new Error(`Backend request failed: ${res.status} ${res.statusText}`)
      return await res.json()
    } catch (e) {
      const isNetwork =
        e instanceof TypeError ||
        (e instanceof Error && /failed to fetch|networkerror|load failed/i.test(e.message))
      if (isNetwork) {
        lastMessage = `Cannot reach backend at ${getApiBase()}. Start it with: cd backend && npm run dev`
        await new Promise((r) => setTimeout(r, 1500))
        continue
      }
      throw e
    }
  }

  throw new Error(
    `${lastMessage || 'Timed out waiting for backend.'} (tried ${maxAttempts} times). URL: ${url}`,
  )
}

function ensureSelectionLayers(map: MapboxMap) {
  if (!map.getSource('selected')) {
    map.addSource('selected', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    })
  }

  if (!map.getLayer(SELECTED_INTERSECTION_LAYER_ID)) {
    map.addLayer({
      id: SELECTED_INTERSECTION_LAYER_ID,
      type: 'circle',
      source: 'selected',
      filter: ['==', ['geometry-type'], 'Point'],
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 10, 15, 16, 18, 22],
        'circle-color': '#ffffff',
        'circle-opacity': 0.15,
        'circle-stroke-width': 3,
        'circle-stroke-color': '#ff3b30',
      },
    })
  }

  if (!map.getLayer(SELECTED_SEGMENT_LAYER_ID)) {
    map.addLayer({
      id: SELECTED_SEGMENT_LAYER_ID,
      type: 'line',
      source: 'selected',
      filter: ['==', ['geometry-type'], 'LineString'],
      paint: {
        'line-width': ['interpolate', ['linear'], ['zoom'], 11, 5, 15, 9, 18, 14],
        'line-color': '#ff3b30',
        'line-opacity': 0.95,
      },
    })
  }
}

function setSelectedSources(map: MapboxMap, feature: SafetyFeature) {
  ensureSelectionLayers(map)
  const fc: FeatureCollection = { type: 'FeatureCollection', features: [feature] }
  ;(map.getSource('selected') as mapboxgl.GeoJSONSource).setData(fc)
}

function getFeatureCenter(feature: SafetyFeature): { lng: number; lat: number } {
  const geom: any = feature.geometry
  if (!geom) return { lng: -97.7431, lat: 30.2672 }
  if (geom.type === 'Point' && Array.isArray(geom.coordinates)) {
    return { lng: geom.coordinates[0], lat: geom.coordinates[1] }
  }
  if (geom.type === 'LineString' && Array.isArray(geom.coordinates) && geom.coordinates.length > 0) {
    const mid = geom.coordinates[Math.floor(geom.coordinates.length / 2)]
    return { lng: mid[0], lat: mid[1] }
  }
  return { lng: -97.7431, lat: 30.2672 }
}

function SafetyDetails({ feature }: { feature: SafetyFeature }) {
  const props = feature.properties ?? ({} as any)
  const { lng, lat } = getFeatureCenter(feature)

  const explanation = props.explanation as any | undefined
  const contrib = explanation?.risk?.contributions as Record<string, number> | undefined
  const notes: string[] = Array.isArray(explanation?.notes) ? explanation.notes : []

  const predicted = Number(props.predicted_accident_count ?? 0)
  const safety = Number(props.safety_score ?? 0)

  return (
    <div className={styles.details}>
      <div className={styles.detailRow}>
        <div className={styles.detailLabel}>Segment</div>
        <div className={styles.mono}>{String(props.segment_id ?? '')}</div>
      </div>
      <div className={styles.detailRow}>
        <div className={styles.detailLabel}>Coordinates</div>
        <div className={styles.mono}>
          {lat.toFixed(5)}, {lng.toFixed(5)}
        </div>
      </div>
      <div className={styles.detailRow}>
        <div className={styles.detailLabel}>Safety score</div>
        <div className={styles.mono}>{safety.toFixed(3)}</div>
      </div>
      <div className={styles.detailRow}>
        <div className={styles.detailLabel}>Predicted accidents</div>
        <div className={styles.mono}>{predicted.toFixed(2)}</div>
      </div>

      <div className={styles.sectionTitleSmall}>Why this score</div>
      {contrib ? (
        <div className={styles.contribList}>
          {Object.entries(contrib)
            .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
            .map(([k, v]) => (
              <div key={k} className={styles.contribRow}>
                <div className={styles.monoMuted}>{k}</div>
                <div className={styles.mono}>{v >= 0 ? '+' : ''}{v.toFixed(3)}</div>
              </div>
            ))}
        </div>
      ) : (
        <div className={styles.empty}>No explanation returned for this feature.</div>
      )}

      {notes.length ? (
        <ul className={styles.notes}>
          {notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

