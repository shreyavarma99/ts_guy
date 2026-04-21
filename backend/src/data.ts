/**
 * @deprecated Import from `segmentTypes` / `dataStore` instead.
 * Kept as a thin compatibility shim for older imports.
 */
export { SegmentRowSchema, type SegmentRow, parseGeometry } from './segmentTypes.js'
export { getSegments, getDataLoadState, startBackgroundDataLoad } from './dataStore.js'
