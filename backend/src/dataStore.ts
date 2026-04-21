import './env.js'

import fs from 'node:fs'
import path from 'node:path'
import { parse } from 'csv-parse/sync'

import { buildLiveSegmentRows } from './live/build.js'
import { fitAccidentRegressor } from './ml/accidentRegressor.js'
import { SegmentRowSchema, type SegmentRow } from './segmentTypes.js'

function backendRoot() {
  return path.resolve(import.meta.dirname, '..')
}

function cachePath() {
  return path.resolve(backendRoot(), 'data/cache/segments.json')
}

function readCsvSegments(absCsv: string): SegmentRow[] {
  const raw = fs.readFileSync(absCsv, 'utf8')
  const records = parse(raw, { columns: true, skip_empty_lines: true, trim: true }) as unknown[]
  return records.map((r, i) => {
    const parsed = SegmentRowSchema.safeParse(r)
    if (!parsed.success) throw new Error(`Invalid row ${i} in ${absCsv}: ${parsed.error.message}`)
    return parsed.data
  })
}

function loadCacheIfFresh(maxAgeMs: number): SegmentRow[] | null {
  const p = cachePath()
  if (!fs.existsSync(p)) return null
  const stat = fs.statSync(p)
  if (Date.now() - stat.mtimeMs > maxAgeMs) return null
  const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as unknown
  if (!Array.isArray(parsed)) return null
  return parsed.map((r, i) => {
    const res = SegmentRowSchema.safeParse(r)
    if (!res.success) throw new Error(`Invalid cache row ${i}: ${res.error.message}`)
    return res.data
  })
}

let cached: SegmentRow[] | null = null

export type DataLoadState = 'idle' | 'loading' | 'ready' | 'error'

let loadState: DataLoadState = 'idle'
let loadError: string | null = null

export function getDataLoadState(): { state: DataLoadState; error: string | null } {
  return { state: loadState, error: loadError }
}

export function getSegments(): SegmentRow[] {
  if (loadState !== 'ready' || !cached) throw new Error('Data store not ready')
  return cached
}

function finalizeSegmentCache() {
  if (cached === null) return
  fitAccidentRegressor(cached)
}

async function hydrateFromSources(): Promise<void> {
  const csvOverride = process.env.SEGMENTS_CSV_PATH
  if (csvOverride) {
    const abs = path.isAbsolute(csvOverride) ? csvOverride : path.resolve(backendRoot(), csvOverride)
    cached = readCsvSegments(abs)
    finalizeSegmentCache()
    return
  }

  const token =
    process.env.MAPBOX_ACCESS_TOKEN?.trim() ||
    process.env.MAPBOX_TOKEN?.trim() ||
    process.env.VITE_MAPBOX_TOKEN?.trim()
  if (!token) {
    throw new Error(
      'Missing Mapbox token for the backend. Add MAPBOX_ACCESS_TOKEN to backend/.env (or backend/.env.local). In dev, the same public pk token you use for VITE_MAPBOX_TOKEN works for Tilequery.',
    )
  }

  const maxAgeHours = Number(process.env.CACHE_MAX_AGE_HOURS ?? 6)
  const maxAgeMs = Math.max(0, maxAgeHours) * 60 * 60 * 1000

  const fresh = maxAgeMs > 0 ? loadCacheIfFresh(maxAgeMs) : null
  if (fresh) {
    cached = fresh
    finalizeSegmentCache()
    return
  }

  const rows = await buildLiveSegmentRows({
    mapboxToken: token,
    bboxRaw: process.env.AUSTIN_BBOX,
    maxWaysRender: process.env.MAX_WAYS_RENDER ? Number(process.env.MAX_WAYS_RENDER) : undefined,
    maxWaysTopo: process.env.MAX_WAYS_TOPO ? Number(process.env.MAX_WAYS_TOPO) : undefined,
    maxIntersectionCandidates: process.env.MAX_IX_CANDIDATES ? Number(process.env.MAX_IX_CANDIDATES) : undefined,
    maxIntersections: process.env.MAX_INTERSECTIONS ? Number(process.env.MAX_INTERSECTIONS) : undefined,
    maxCrashRows: process.env.MAX_CRASH_ROWS ? Number(process.env.MAX_CRASH_ROWS) : undefined,
  })

  cached = rows

  const out = cachePath()
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, JSON.stringify(rows), 'utf8')
  finalizeSegmentCache()
}

/**
 * Loads (or rebuilds) the dataset. Safe to call once at startup; does not throw to the process
 * if loading fails — check `getDataLoadState()`.
 */
export async function startBackgroundDataLoad(): Promise<void> {
  if (loadState === 'loading') return
  if (loadState === 'ready') return

  loadState = 'loading'
  loadError = null
  cached = null

  try {
    await hydrateFromSources()
    loadState = 'ready'
  } catch (e) {
    loadState = 'error'
    loadError = e instanceof Error ? e.message : String(e)
    cached = null
    // eslint-disable-next-line no-console
    console.error('[data] Failed to load dataset:', loadError)
  }
}
