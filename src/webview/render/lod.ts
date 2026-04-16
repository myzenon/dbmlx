export type LodLevel = 'rect' | 'header' | 'full';

/**
 * Level of detail selection based on zoom factor.
 *
 * rect   — zoom < 0.3:  just a colored rectangle, no text (fast-path for >1000 visible)
 * header — zoom < 0.6:  table name only, no columns
 * full   — zoom >= 0.6: full columns rendered
 *
 * Thresholds chosen empirically; tune in specs/07-performance-budgets.md if needed.
 */
export function lodForZoom(zoom: number): LodLevel {
  if (zoom < 0.3) return 'rect';
  if (zoom < 0.6) return 'header';
  return 'full';
}
