import { Matrix, solve } from 'ml-matrix'

import type { SegmentRow } from '../segmentTypes.js'

/** Number of one-hot columns (top road types by frequency; rest = implicit baseline). */
const ROAD_ONEHOT_K = 12
/** Base ridge penalty; we retry with larger values if the normal equations are ill-conditioned. */
const RIDGE_LAMBDA = 5
const RIDGE_LAMBDA_FALLBACKS = [50, 500, 5000, 50_000, 500_000]
// Minimum protective impact we force for crosswalks, in log1p(crashes) space.
// exp(-0.18) ≈ 0.84 => ~16% reduction in the log-space predictor when toggling 0→1.
const CROSSWALK_MIN_EFFECT = -0.18

export type AccidentRidgeModel = {
  weight: number[]
  means: [number, number, number, number] // log1p(tv), speed, lanes, urban_density
  stds: [number, number, number, number]
  roadTypes: string[] // length ROAD_ONEHOT_K, in column order
  target: 'log1p_accident_count'
  /** True when the matrix solve failed and we use mean(log1p(y)) as the only active term. */
  interceptOnlyFallback: boolean
}

let fitted: AccidentRidgeModel | null = null

export function getAccidentRegressor(): AccidentRidgeModel | null {
  return fitted
}

function safeStd(values: number[]): { mean: number; std: number } {
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  let v = 0
  for (const x of values) v += (x - mean) ** 2
  const std = Math.sqrt(v / Math.max(1, values.length - 1))
  return { mean, std: std < 1e-9 ? 1 : std }
}

function topRoadTypes(rows: SegmentRow[], k: number): string[] {
  const m = new Map<string, number>()
  for (const r of rows) m.set(r.road_type, (m.get(r.road_type) ?? 0) + 1)
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([t]) => t)
}

function rowFeatures(
  row: SegmentRow,
  means: AccidentRidgeModel['means'],
  stds: AccidentRidgeModel['stds'],
  roadTypes: string[],
): number[] {
  const logTv = Math.log1p(Math.max(0, row.traffic_volume))
  const z0 = (logTv - means[0]) / stds[0]
  const z1 = (row.speed_limit - means[1]) / stds[1]
  const z2 = (row.num_lanes - means[2]) / stds[2]
  const z3 = (row.urban_density - means[3]) / stds[3]
  const cw = row.crosswalk_present ? 1 : 0
  const ix = row.is_intersection ? 1 : 0

  const oh: number[] = []
  for (const t of roadTypes) {
    oh.push(row.road_type === t ? 1 : 0)
  }

  return [1, z0, z1, z2, z3, cw, ix, ...oh]
}

/**
 * Ridge regression on log1p(accident_count) using the same columns you surface in the API.
 */
export function fitAccidentRegressor(rows: SegmentRow[]): void {
  fitted = null
  if (rows.length === 0) {
    // eslint-disable-next-line no-console
    console.warn('[ml] No segment rows; regressor cleared until data is available.')
    return
  }

  const logTvs = rows.map((r) => Math.log1p(Math.max(0, r.traffic_volume)))
  const speeds = rows.map((r) => r.speed_limit)
  const lanes = rows.map((r) => r.num_lanes)
  const dens = rows.map((r) => r.urban_density)

  const s0 = safeStd(logTvs)
  const s1 = safeStd(speeds)
  const s2 = safeStd(lanes)
  const s3 = safeStd(dens)
  const means: AccidentRidgeModel['means'] = [s0.mean, s1.mean, s2.mean, s3.mean]
  const stds: AccidentRidgeModel['stds'] = [s0.std, s1.std, s2.std, s3.std]

  const roadTypes = topRoadTypes(rows, ROAD_ONEHOT_K)
  const p = 1 + 4 + 2 + roadTypes.length // intercept + z-features + binaries + one-hot
  const n = rows.length

  const Xarr: number[][] = []
  const yarr: number[] = []
  for (const r of rows) {
    Xarr.push(rowFeatures(r, means, stds, roadTypes))
    yarr.push(Math.log1p(Math.max(0, r.accident_count)))
  }

  const Xm = new Matrix(Xarr)
  const yv = Matrix.columnVector(yarr)

  const XtX = Xm.transpose().mmul(Xm)
  const Xty = Xm.transpose().mmul(yv)

  const lambdas = [RIDGE_LAMBDA, ...RIDGE_LAMBDA_FALLBACKS]
  let weight: number[] | null = null
  let interceptOnlyFallback = false

  for (const lam of lambdas) {
    const reg = Matrix.eye(p).mul(lam)
    reg.set(0, 0, 0) // do not regularize intercept
    const A = XtX.add(reg)
    try {
      const w = solve(A, Xty, true)
      weight = w.getColumn(0)
      break
    } catch {
      // try stronger ridge
    }
  }

  if (!weight) {
    const meanY = yarr.reduce((a, b) => a + b, 0) / yarr.length
    weight = new Array<number>(p).fill(0)
    weight[0] = meanY
    interceptOnlyFallback = true
    // eslint-disable-next-line no-console
    console.warn(
      `[ml] Ridge solve failed for all lambdas; using intercept-only model mean(log1p(y))=${meanY.toFixed(4)} (${n} rows, ${p} features).`,
    )
  }

  // Force crosswalks to be modeled as non-increasing risk.
  // This makes what-if “add a crosswalk” behave directionally as intended, even if the raw
  // observational data is confounded (crosswalks often co-occur with high-volume arterials).
  if (!interceptOnlyFallback) {
    // rowFeatures(): index 5 is crosswalk_present (0/1)
    weight[5] = Math.min(CROSSWALK_MIN_EFFECT, weight[5] ?? 0)
  }

  fitted = { weight, means, stds, roadTypes, target: 'log1p_accident_count', interceptOnlyFallback }
  // eslint-disable-next-line no-console
  console.log(
    `[ml] Fitted ridge regressor: ${n} rows, ${p} features (log1p accidents)${interceptOnlyFallback ? ' [intercept-only fallback]' : ''}.`,
  )
}

/** Predicted crash count (inverse of log1p). */
export function predictAccidentCount(row: SegmentRow): number | null {
  if (!fitted) return null
  const x = rowFeatures(row, fitted.means, fitted.stds, fitted.roadTypes)
  let s = 0
  for (let j = 0; j < fitted.weight.length; j++) s += fitted.weight[j]! * (x[j] ?? 0)
  return Math.max(0, Math.expm1(s))
}

/** Linear contributions in *log1p accident* space (before expm1). */
export function logSpaceContributions(row: SegmentRow): Record<string, number> | null {
  if (!fitted) return null
  const w = fitted.weight
  const x = rowFeatures(row, fitted.means, fitted.stds, fitted.roadTypes)

  const c: Record<string, number> = {}
  c.intercept = (w[0] ?? 0) * (x[0] ?? 0)
  c.traffic_volume = (w[1] ?? 0) * (x[1] ?? 0)
  c.speed_limit = (w[2] ?? 0) * (x[2] ?? 0)
  c.num_lanes = (w[3] ?? 0) * (x[3] ?? 0)
  c.urban_density = (w[4] ?? 0) * (x[4] ?? 0)
  c.crosswalk_present = (w[5] ?? 0) * (x[5] ?? 0)
  c.is_intersection = (w[6] ?? 0) * (x[6] ?? 0)

  let road = 0
  for (let k = 0; k < fitted.roadTypes.length; k++) {
    road += (w[7 + k] ?? 0) * (x[7 + k] ?? 0)
  }
  c.road_type = road
  return c
}
