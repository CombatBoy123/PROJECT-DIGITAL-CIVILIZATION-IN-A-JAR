import type { WorldMap } from '@civ/sim-core';
import { useImperativeHandle, useMemo, useRef, type PointerEvent, type Ref } from 'react';
import { visibleWorldRect, type Camera, type Viewport } from './camera';
import { TILE_PX, mapBounds } from './geometry';
import { minimapLayout, minimapToWorld, worldRectToMinimap } from './minimap';
import { MINIMAP_ZONE_COLORS, PALETTE, cssColor } from './palette';

/*
 * Corner overview of the whole map: zones and the current viewport rectangle.
 * Click or drag on it to move the camera. It is a small SVG (one rect per block);
 * the viewport frame is moved imperatively through the `update` handle, so camera
 * motion does not re-render React. (SVG rather than a second <canvas>, so the map
 * keeps exactly one canvas.)
 */

export interface MinimapHandle {
  update(camera: Camera, viewport: Viewport): void;
}

const MAX_SIZE = 152;
/** Half the frame's stroke width, in minimap pixels. */
const FRAME_INSET = 1;

export function Minimap({
  map,
  onNavigate,
  ref,
}: {
  map: WorldMap;
  onNavigate: (wx: number, wy: number) => void;
  ref?: Ref<MinimapHandle>;
}) {
  const frameRef = useRef<SVGRectElement>(null);
  const layout = useMemo(() => minimapLayout(mapBounds(map), MAX_SIZE), [map]);
  const blockSize = map.blockSize * TILE_PX * layout.scale;

  useImperativeHandle(
    ref,
    () => ({
      update(camera, viewport) {
        const frame = frameRef.current;
        if (!frame || viewport.width === 0) return;
        const r = worldRectToMinimap(layout, visibleWorldRect(camera, viewport));
        // Keep the whole stroke inside the minimap so the frame stays visible at the edges.
        const x0 = Math.min(Math.max(r.x, FRAME_INSET), layout.width - FRAME_INSET);
        const y0 = Math.min(Math.max(r.y, FRAME_INSET), layout.height - FRAME_INSET);
        const x1 = Math.max(Math.min(r.x + r.width, layout.width - FRAME_INSET), x0);
        const y1 = Math.max(Math.min(r.y + r.height, layout.height - FRAME_INSET), y0);
        frame.setAttribute('x', String(x0));
        frame.setAttribute('y', String(y0));
        frame.setAttribute('width', String(x1 - x0));
        frame.setAttribute('height', String(y1 - y0));
      },
    }),
    [layout],
  );

  const navigate = (event: PointerEvent<SVGSVGElement>): void => {
    // The SVG is scaled by CSS with the container; convert to layout pixels first.
    const rect = event.currentTarget.getBoundingClientRect();
    const k = rect.width > 0 ? layout.width / rect.width : 1;
    const p = minimapToWorld(
      layout,
      (event.clientX - rect.left) * k,
      (event.clientY - rect.top) * k,
    );
    onNavigate(p.x, p.y);
  };

  return (
    <svg
      className="world-minimap"
      data-testid="world-minimap"
      width={layout.width}
      height={layout.height}
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      // Pointer-only shortcut; the focused map offers the same navigation by keyboard.
      aria-hidden="true"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        navigate(event);
      }}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) navigate(event);
      }}
    >
      <rect width={layout.width} height={layout.height} fill={cssColor(PALETTE.road)} />
      {map.blocks.map((block) => (
        <rect
          key={block.id}
          x={block.x * TILE_PX * layout.scale}
          y={block.y * TILE_PX * layout.scale}
          width={blockSize}
          height={blockSize}
          fill={cssColor(MINIMAP_ZONE_COLORS[block.zone])}
        />
      ))}
      <rect
        ref={frameRef}
        className="world-minimap-frame"
        width={0}
        height={0}
        fill="rgba(242, 240, 255, 0.10)"
        stroke={cssColor(PALETTE.selection)}
        strokeWidth={2 * FRAME_INSET}
      />
    </svg>
  );
}
