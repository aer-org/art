/**
 * useInspectorEscape — single keydown handler that closes the topmost
 * open layer of a stage inspector stack.
 *
 * Pages typically stack panels (stage → L3 view → optional L4 overlay).
 * Each layer wants Esc to close itself, but only the topmost: pressing
 * Esc while the L3 viewer is open should not also close the L2 sidebar.
 *
 * The caller passes layers from innermost to outermost. The first one
 * with a truthy `open` value gets its `close()` invoked; the rest are
 * left alone. Layers that are not currently open are skipped.
 */
import { useEffect } from 'react';

export interface InspectorLayer {
  /** Truthy when this layer is currently visible. */
  open: unknown;
  /** Called to dismiss this layer. */
  close: () => void;
}

export function useInspectorEscape(layers: InspectorLayer[]): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      for (const layer of layers) {
        if (layer.open) {
          layer.close();
          return;
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // The layer array is reconstructed on every render but its
    // identity rarely matters — we re-bind cheaply each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, layers.flatMap((l) => [l.open, l.close]));
}
