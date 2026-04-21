import { z } from 'zod'

export const SegmentRowSchema = z.object({
  segment_id: z.string(),
  geometry: z.string(),
  accident_count: z.coerce.number(),
  traffic_volume: z.coerce.number(),
  speed_limit: z.coerce.number(),
  num_lanes: z.coerce.number(),
  road_type: z.string(),
  sidewalk_present: z.coerce.number(),
  is_intersection: z.coerce.number(),
  urban_density: z.coerce.number(),
})

export type SegmentRow = z.infer<typeof SegmentRowSchema>

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
