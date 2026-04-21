import { z } from 'zod'

const BBoxSchema = z.object({
  west: z.number(),
  south: z.number(),
  east: z.number(),
  north: z.number(),
})

export type BBox = z.infer<typeof BBoxSchema>

/**
 * AUSTIN_BBOX format: west,south,east,north (lon/lat, WGS84)
 * Example: -97.78,30.24,-97.68,30.32
 */
export function parseBBox(raw?: string): BBox {
  if (!raw || !raw.trim()) {
    return { west: -97.78, south: 30.24, east: -97.68, north: 30.32 }
  }
  const parts = raw.split(',').map((s) => Number(s.trim()))
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) {
    throw new Error(`Invalid AUSTIN_BBOX "${raw}". Expected west,south,east,north`)
  }
  const [west, south, east, north] = parts
  return BBoxSchema.parse({ west, south, east, north })
}
