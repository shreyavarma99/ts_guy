export type GeoJsonGeometry =
  | { type: 'Point'; coordinates: [number, number] }
  | { type: 'LineString'; coordinates: [number, number][] }
  | { type: string; coordinates: unknown }

export type GeoJsonFeature<P extends Record<string, unknown> = Record<string, unknown>> = {
  type: 'Feature'
  geometry: GeoJsonGeometry
  properties: P
}

export type GeoJsonFeatureCollection<P extends Record<string, unknown> = Record<string, unknown>> = {
  type: 'FeatureCollection'
  features: Array<GeoJsonFeature<P>>
}

