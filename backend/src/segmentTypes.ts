import { z } from 'zod'

const SegmentRowCore = z.object({
  segment_id: z.string(),
  geometry: z.string(),
  accident_count: z.coerce.number(),
  traffic_volume: z.coerce.number(),
  speed_limit: z.coerce.number(),
  num_lanes: z.coerce.number(),
  road_type: z.string(),
  crosswalk_present: z.coerce.number(),
  is_intersection: z.coerce.number(),
  urban_density: z.coerce.number(),
})

/** Accepts legacy `sidewalk_present` column name from older CSV/cache rows. */
export const SegmentRowSchema = z.preprocess((val) => {
  if (val && typeof val === 'object' && !Array.isArray(val)) {
    const v = val as Record<string, unknown>
    if (v.crosswalk_present == null && v.sidewalk_present != null) {
      return { ...v, crosswalk_present: v.sidewalk_present }
    }
  }
  return val
}, SegmentRowCore)

export type SegmentRow = z.infer<typeof SegmentRowCore>

export function parseGeometry(geometryJson: string): any {
  let geom: unknown
  try {
    geom = JSON.parse(geometryJson)
  } catch {
    throw new Error('geometry must be a JSON string containing a GeoJSON geometry object')
  }
  if (!geom || typeof geom !== 'object' || !('type' in (geom as any)) || !('coordinates' in (geom as any))) {
    throw new Error('geometry must be a GeoJSON geometry object with type + coordinates')
  }
  return geom as any
}
