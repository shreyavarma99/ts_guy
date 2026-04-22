import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import mapboxgl, { type AnyLayer, type Map as MapboxMap } from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import {
  buildCrosswalkZebraGeoJSON,
  CROSSWALK_SIM_SOURCE_ID,
  emptyCrosswalkSimCollection,
} from './crosswalkGraphic.js'
import styles from './MapView.module.css'

const MAPBOX_STYLE = 'mapbox://styles/mapbox/satellite-streets-v12'
const SAFETY_SEGMENTS_SOURCE_ID = 'safety-segments'
const SAFETY_INTERSECTIONS_SOURCE_ID = 'safety-intersections'
const SELECTED_INTERSECTION_LAYER_ID = 'selected-intersection'
const SELECTED_SEGMENT_LAYER_ID = 'selected-segment'

/** Drag payload so we only accept our own draggable, not random text drags. */
const CROSSWALK_DND_TYPE = 'application/x-tsguy-crosswalk'

const SAFETY_LAYER_IDS = ['safety-intersections', 'safety-segments-line'] as const

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

type WhatIfScoreSide = {
  crosswalk_present: number
  predicted_accident_count: number
  safety_score: number
  explanation?: unknown
}

type WhatIfCrosswalkResponse = {
  segment_id: string
  observed_crosswalk_present: number
  baseline: WhatIfScoreSide
  with_crosswalk: WhatIfScoreSide
}

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
  const [whatIf, setWhatIf] = useState<WhatIfCrosswalkResponse | null>(null)
  const [whatIfLoading, setWhatIfLoading] = useState(false)
  const [whatIfError, setWhatIfError] = useState<string | null>(null)
  const [crosswalkDragActive, setCrosswalkDragActive] = useState(false)
  const crosswalkDndRef = useRef(false)

  const demoIntersections = useMemo((): SafetyFeature[] => {
    const mk = (id: string, lng: number, lat: number, safety: number, predicted: number): SafetyFeature => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lng, lat] },
      properties: {
        segment_id: id,
        safety_score: safety,
        predicted_accident_count: predicted,
        explanation: {
          model: 'demo',
          risk: { contributions: { demo: -1 } },
          notes: ['Demo row (mock data).'],
        },
        __demo: 1,
      },
    })

    // Put these near central Austin so fly-to feels natural.
    return [
      mk('demo-safe/1', -97.7431, 30.2672, 0.996, 0.12),
      mk('demo-safe/2', -97.7419, 30.2684, 0.992, 0.25),
    ]
  }, [])

  const selected = useMemo(() => {
    if (!selectedId) return null
    return (
      demoIntersections.find((f) => f.properties?.segment_id === selectedId) ??
      intersections.find((f) => f.properties?.segment_id === selectedId) ??
      segments.find((f) => f.properties?.segment_id === selectedId) ??
      null
    )
  }, [demoIntersections, intersections, segments, selectedId])

  const requestWhatIf = useCallback(async (segmentId: string) => {
    if (segmentId.startsWith('demo-safe/')) {
      setWhatIf(null)
      setWhatIfError('Crosswalk simulation is disabled for demo (mock) rows. Select a real segment/intersection.')
      return
    }
    setWhatIfError(null)
    setWhatIfLoading(true)
    try {
      const apiBase = getApiBase().replace(/\/+$/, '')
      const data = (await fetchJsonPost(`${apiBase}/what-if/crosswalk`, {
        segment_id: segmentId,
      })) as WhatIfCrosswalkResponse
      setWhatIf(data)
      setSelectedId(segmentId)
    } catch (e) {
      setWhatIf(null)
      setWhatIfError(e instanceof Error ? e.message : String(e))
    } finally {
      setWhatIfLoading(false)
    }
  }, [])

  const requestWhatIfRef = useRef(requestWhatIf)
  requestWhatIfRef.current = requestWhatIf

  const segmentsRef = useRef(segments)
  const intersectionsRef = useRef(intersections)
  segmentsRef.current = segments
  intersectionsRef.current = intersections

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
      // If this Map instance was unmounted (e.g. route change or React dev remount), ignore — calling
      // `map.addSource` / `getStyle` on a removed instance can throw inside Mapbox.
      if (mapRef.current !== map) {
        return
      }

      try {
        // Terrain (hills/mountains) for more 3D context. Idempotent if `style.load` runs twice.
        if (!map.getSource('mapbox-dem')) {
          map.addSource('mapbox-dem', {
            type: 'raster-dem',
            url: 'mapbox://mapbox.mapbox-terrain-dem-v1',
            tileSize: 512,
            maxzoom: 14,
          })
        }

        map.setTerrain({ source: 'mapbox-dem', exaggeration: 1.25 })

        if (!map.getLayer('sky')) {
          map.addLayer({
            id: 'sky',
            type: 'sky',
            paint: {
              'sky-type': 'atmosphere',
              'sky-atmosphere-sun': [0.0, 0.0],
              'sky-atmosphere-sun-intensity': 15,
            },
          })
        }

        // Add 3D buildings only when the style exposes Mapbox `composite` + building layer.
        if (map.getSource('composite') && !map.getLayer('buildings-3d')) {
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
            // Style variant without building extrusion data.
          }
        }

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
      } catch (err) {
        if (mapRef.current === map) {
          setError(err instanceof Error ? err.message : String(err))
        }
        return
      }

      const isMapAlive = () => mapRef.current === map
      void loadSafetyLayers(
        map,
        {
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
        },
        unsafeCutoff,
        isMapAlive,
      )
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
    void refreshIntersections(map, unsafeCutoff, () => mapRef.current === map)
      .then((next) => {
        if (next === null) return
        setIntersections(next)
        if (selectedId && !next.some((f) => f.properties?.segment_id === selectedId)) {
          setSelectedId(next[0]?.properties?.segment_id ?? null)
        }
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unsafeCutoff])

  useEffect(() => {
    const map = mapRef.current
    if (!map || error) return

    const canvas = map.getCanvas()

    const isOurDrag = (e: DragEvent) => {
      const types = e.dataTransfer?.types ? [...e.dataTransfer.types] : []
      return types.includes(CROSSWALK_DND_TYPE)
    }

    const onDragOver = (e: DragEvent) => {
      if (!crosswalkDndRef.current && !isOurDrag(e)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    }

    const onDrop = (e: DragEvent) => {
      if (!crosswalkDndRef.current && !isOurDrag(e)) return
      e.preventDefault()
      const rect = canvas.getBoundingClientRect()
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top
      const pad = 14
      let hits: mapboxgl.GeoJSONFeature[] = []
      try {
        hits = map.queryRenderedFeatures(
          [
            [x - pad, y - pad],
            [x + pad, y + pad],
          ],
          { layers: [...SAFETY_LAYER_IDS] },
        )
      } catch {
        setWhatIfError('Map query failed — try again after the map finishes loading.')
        return
      }
      const hit = hits[0] as unknown as SafetyFeature | undefined
      const id = hit?.properties?.segment_id
      if (!id || typeof id !== 'string') {
        setWhatIfError('Drop on a highlighted road segment or red intersection dot (zoom in if needed).')
        setWhatIf(null)
        return
      }
      const lngLat = map.unproject([x, y])
      applyCrosswalkGraphicToMap(map, hit, lngLat, [
        ...segmentsRef.current,
        ...intersectionsRef.current,
      ])
      void requestWhatIfRef.current(id)
    }

    canvas.addEventListener('dragover', onDragOver)
    canvas.addEventListener('drop', onDrop)
    return () => {
      canvas.removeEventListener('dragover', onDragOver)
      canvas.removeEventListener('drop', onDrop)
    }
  }, [error, segments.length, intersections.length])

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
          {[...demoIntersections, ...intersections].map((f) => {
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

      <div className={styles.crosswalkDock}>
        <div className={styles.dockTitle}>Crosswalk simulation</div>
        <div className={styles.dockRow}>
          <div
            className={styles.dragChip}
            draggable
            onDragStart={(e) => {
              crosswalkDndRef.current = true
              setCrosswalkDragActive(true)
              e.dataTransfer.setData(CROSSWALK_DND_TYPE, '1')
              e.dataTransfer.setData('text/plain', 'crosswalk')
              e.dataTransfer.effectAllowed = 'copy'
            }}
            onDragEnd={() => {
              crosswalkDndRef.current = false
              setCrosswalkDragActive(false)
            }}
            title="Drag onto the map or the drop zone"
          >
            <span className={styles.dragChipCrosswalk} aria-hidden />
            <span>Add crosswalk</span>
          </div>
          <div
            className={`${styles.dropPad} ${crosswalkDragActive ? styles.dropPadActive : ''} ${
              selectedId ? styles.dropPadReady : styles.dropPadDisabled
            }`}
            onDragOver={(e) => {
              if (!crosswalkDndRef.current) return
              e.preventDefault()
              e.dataTransfer.dropEffect = 'copy'
            }}
            onDrop={(e) => {
              e.preventDefault()
              crosswalkDndRef.current = false
              setCrosswalkDragActive(false)
              if (!selectedId) {
                setWhatIfError('Select a location in the list first, or drop the chip on the map.')
                return
              }
              const m = mapRef.current
              const sel =
                intersections.find((f) => f.properties?.segment_id === selectedId) ??
                segments.find((f) => f.properties?.segment_id === selectedId)
              if (m && sel) {
                const c = getFeatureCenter(sel)
                applyCrosswalkGraphicToMap(m, sel, { lng: c.lng, lat: c.lat }, [
                  ...segments,
                  ...intersections,
                ])
              }
              void requestWhatIf(selectedId)
            }}
          >
            Drop on <strong>selection</strong>
          </div>
          <button
            type="button"
            className={styles.dockButton}
            disabled={!selectedId || whatIfLoading}
            onClick={() => {
              if (!selectedId) return
              const m = mapRef.current
              const sel =
                intersections.find((f) => f.properties?.segment_id === selectedId) ??
                segments.find((f) => f.properties?.segment_id === selectedId)
              if (m && sel) {
                const c = getFeatureCenter(sel)
                applyCrosswalkGraphicToMap(m, sel, { lng: c.lng, lat: c.lat }, [
                  ...segments,
                  ...intersections,
                ])
              }
              void requestWhatIf(selectedId)
            }}
          >
            {whatIfLoading ? 'Running…' : 'Run on selected'}
          </button>
          {whatIf ? (
            <button
              type="button"
              className={styles.dockButtonGhost}
              onClick={() => {
                setWhatIf(null)
                setWhatIfError(null)
                clearCrosswalkGraphicOnMap(mapRef.current)
              }}
            >
              Clear compare
            </button>
          ) : null}
        </div>
        <div className={styles.dockHint}>
          Drag <strong>Add crosswalk</strong> onto a <strong>road</strong> or <strong>intersection</strong> on the map,
          or drop it on “selection” after clicking a list item. Scores are recomputed on the server with{' '}
          <code className={styles.inlineCode}>crosswalk_present = 1</code>.
        </div>
        {whatIfError ? <div className={styles.dockError}>{whatIfError}</div> : null}
        {whatIf ? <CrosswalkWhatIfPanel data={whatIf} /> : null}
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
  isMapAlive?: () => boolean,
) {
  const apiBase = getApiBase().replace(/\/+$/, '')

  const [segments, intersections] = await Promise.all([
    fetchJson(`${apiBase}/segments`),
    fetchJson(`${apiBase}/intersections?max_safety=${encodeURIComponent(String(unsafeCutoff))}`),
  ])

  const aliveAfterFetch = isMapAlive?.() ?? true
  if (!aliveAfterFetch) {
    return
  }

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
  ensureCrosswalkSimLayers(map)
}

function ensureCrosswalkSimLayers(map: MapboxMap) {
  if (map.getSource(CROSSWALK_SIM_SOURCE_ID)) return
  map.addSource(CROSSWALK_SIM_SOURCE_ID, {
    type: 'geojson',
    data: emptyCrosswalkSimCollection(),
  })
  const beforeId = map.getLayer(SELECTED_INTERSECTION_LAYER_ID) ? SELECTED_INTERSECTION_LAYER_ID : undefined
  map.addLayer(
    {
      id: 'crosswalk-sim-stripe',
      type: 'line',
      source: CROSSWALK_SIM_SOURCE_ID,
      filter: ['==', ['get', 'kind'], 'stripe'],
      layout: { 'line-cap': 'square' },
      paint: {
        'line-color': '#ffffff',
        'line-width': ['interpolate', ['linear'], ['zoom'], 14, 2.5, 17, 6, 19, 9],
        'line-opacity': 0.95,
      },
    },
    beforeId,
  )
  map.addLayer(
    {
      id: 'crosswalk-sim-edge',
      type: 'line',
      source: CROSSWALK_SIM_SOURCE_ID,
      filter: ['==', ['get', 'kind'], 'edge'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#e6c82e',
        'line-width': ['interpolate', ['linear'], ['zoom'], 14, 1.5, 17, 3.5],
        'line-opacity': 0.9,
      },
    },
    beforeId,
  )
}

function applyCrosswalkGraphicToMap(
  map: MapboxMap,
  feature: SafetyFeature,
  lngLat: { lng: number; lat: number },
  contextFeatures: SafetyFeature[],
) {
  if (!map.getSource(CROSSWALK_SIM_SOURCE_ID)) return
  const fc = buildCrosswalkZebraGeoJSON(feature, [lngLat.lng, lngLat.lat], contextFeatures)
  ;(map.getSource(CROSSWALK_SIM_SOURCE_ID) as mapboxgl.GeoJSONSource).setData(fc)
}

function clearCrosswalkGraphicOnMap(map: MapboxMap | null) {
  if (!map?.getSource(CROSSWALK_SIM_SOURCE_ID)) return
  ;(map.getSource(CROSSWALK_SIM_SOURCE_ID) as mapboxgl.GeoJSONSource).setData(emptyCrosswalkSimCollection())
}

async function refreshIntersections(
  map: MapboxMap,
  unsafeCutoff: number,
  isMapAlive?: () => boolean,
): Promise<SafetyFeature[] | null> {
  const apiBase = getApiBase().replace(/\/+$/, '')
  const intersections = await fetchJson(
    `${apiBase}/intersections?max_safety=${encodeURIComponent(String(unsafeCutoff))}`,
  )
  if (isMapAlive && !isMapAlive()) {
    return null
  }

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

async function fetchJsonPost(url: string, body: unknown) {
  const maxAttempts = 120
  let lastMessage = ''
  const payload = JSON.stringify(body)

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: payload,
      })

      if (res.status === 503) {
        const b = await res.json().catch(() => null)
        lastMessage =
          (b && typeof b === 'object' && 'message' in b && String((b as any).message)) ||
          'Backend is still building the Austin dataset.'
        await new Promise((r) => setTimeout(r, 3000))
        continue
      }

      if (res.status === 500) {
        const text = await res.text()
        let err = text
        try {
          const obj = JSON.parse(text) as { error?: string }
          if (obj?.error) err = obj.error
        } catch {
          // keep raw
        }
        throw new Error(err || `Backend error ${res.status}`)
      }

      if (res.status === 400 || res.status === 404) {
        const text = await res.text()
        let msg = text || `Request failed (${res.status})`
        try {
          const obj = JSON.parse(text) as { error?: string }
          if (obj?.error) msg = obj.error
        } catch {
          // keep msg from body text
        }
        throw new Error(msg)
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
      {explanation?.model ? (
        <div className={styles.detailRow}>
          <div className={styles.detailLabel}>Model</div>
          <div className={styles.mono}>{String(explanation.model)}</div>
        </div>
      ) : null}

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

function CrosswalkWhatIfPanel({ data }: { data: WhatIfCrosswalkResponse }) {
  const b = data.baseline
  const w = data.with_crosswalk
  const dSafety = w.safety_score - b.safety_score
  const pctSafety = b.safety_score > 0 ? (dSafety / b.safety_score) * 100 : 0
  // Signed so a decrease shows as a negative percent (user wants it styled red).
  const pctCrashSigned =
    b.predicted_accident_count > 0
      ? ((w.predicted_accident_count - b.predicted_accident_count) / b.predicted_accident_count) * 100
      : 0

  const bc = (b.explanation as any)?.risk?.contributions?.crosswalk_present
  const wc = (w.explanation as any)?.risk?.contributions?.crosswalk_present

  return (
    <div className={styles.whatIfPanel}>
      <div className={styles.whatIfHead}>
        <span className={styles.monoMuted}>compare</span>
        <span className={styles.mono}>{data.segment_id}</span>
      </div>
      <div className={styles.whatIfGrid}>
        <div />
        <div className={styles.whatIfColH}>Before (current)</div>
        <div className={styles.whatIfColH}>After (simulated)</div>

        <div className={styles.whatIfRowL}>Safety score ↑</div>
        <div className={styles.mono}>{b.safety_score.toFixed(3)}</div>
        <div className={styles.mono}>
          {w.safety_score.toFixed(3)}
          <DeltaPill value={pctSafety} goodIfPositive unit="%" />
        </div>

        <div className={styles.whatIfRowL}>Predicted crashes ↓</div>
        <div className={styles.mono}>{b.predicted_accident_count.toFixed(2)}</div>
        <div className={styles.mono}>
          {w.predicted_accident_count.toFixed(2)}
          <DeltaPill value={pctCrashSigned} goodIfPositive unit="%" />
        </div>

        <div className={styles.whatIfRowL}>crosswalk_present (what-if)</div>
        <div className={styles.mono}>{b.crosswalk_present}</div>
        <div className={styles.mono}>{w.crosswalk_present}</div>

        <div className={styles.whatIfRowL}>crosswalk_present (dataset)</div>
        <div className={styles.mono}>{data.observed_crosswalk_present}</div>
        <div className={styles.mono}>{data.observed_crosswalk_present}</div>

        <div className={styles.whatIfRowL}>Model term (log space)</div>
        <div className={styles.mono}>{bc != null ? bc.toFixed(3) : '—'}</div>
        <div className={styles.mono}>{wc != null ? wc.toFixed(3) : '—'}</div>
      </div>
      {data.observed_crosswalk_present === 1 ? (
        <div className={styles.whatIfNote}>
          Note: the dataset currently has <code className={styles.inlineCode}>crosswalk_present = 1</code> here
          (OSM detection), but the what-if still forces a 0→1 comparison to show marginal model impact.
        </div>
      ) : null}
    </div>
  )
}

function DeltaPill({
  value,
  goodIfPositive,
  unit,
  invertColors,
}: {
  value: number
  goodIfPositive: boolean
  unit?: string
  invertColors?: boolean
}) {
  if (!Number.isFinite(value) || Math.abs(value) < 0.05) return null
  const good = goodIfPositive ? value > 0 : value < 0
  const cls = (invertColors ? !good : good) ? styles.deltaGood : styles.deltaBad
  const sign = value > 0 ? '+' : ''
  return (
    <span className={`${styles.deltaPill} ${cls}`}>
      {sign}
      {Math.abs(value) >= 10 ? value.toFixed(1) : value.toFixed(2)}
      {unit ?? ''}
    </span>
  )
}
