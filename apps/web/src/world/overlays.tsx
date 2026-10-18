import type { LayoutResponse } from '@civ/shared';
import type { Ref } from 'react';
import type { FrameStore } from './frame-store';
import { ACTIVITY_COLORS, ACTIVITY_LEGEND, CITIZEN_ALPHA, cssColor } from './palette';
import { countActivities, describeHover } from './summaries';
import type { Selection } from './types';
import { useFrameVersion } from './use-frame-version';

/*
 * HTML overlays drawn on top of the map canvas: activity legend, zoom controls and
 * the hover tooltip. Numbers come from the latest frame.
 */

/** Activity colour key with live counts from the latest frame. */
export function MapLegend({ frames }: { frames: FrameStore }) {
  useFrameVersion(frames);
  const state = frames.state;
  const counts = state ? countActivities(state.citizens.values()) : null;
  return (
    <div
      className="world-legend"
      data-testid="world-legend"
      aria-label="Citizen activity legend"
      role="group"
    >
      <ul>
        {ACTIVITY_LEGEND.map(({ activity, label }) => (
          <li key={activity} data-activity={activity}>
            <span
              className="world-legend-swatch"
              aria-hidden="true"
              style={{
                background: cssColor(ACTIVITY_COLORS[activity]),
                opacity: activity === 'sleeping' ? CITIZEN_ALPHA.sleeping + 0.2 : 1,
              }}
            />
            <span className="world-legend-label">{label}</span>
            {counts && <span className="world-legend-count">{counts[activity]}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function MapControls({
  onZoomIn,
  onZoomOut,
  onFit,
}: {
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
}) {
  return (
    <div className="world-controls" role="group" aria-label="Map view">
      <button
        type="button"
        className="world-control"
        onClick={onZoomIn}
        aria-label="Zoom in"
        title="Zoom in (+)"
        data-testid="world-zoom-in"
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M8 3v10M3 8h10" />
        </svg>
      </button>
      <button
        type="button"
        className="world-control"
        onClick={onZoomOut}
        aria-label="Zoom out"
        title="Zoom out (−)"
        data-testid="world-zoom-out"
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M3 8h10" />
        </svg>
      </button>
      <button
        type="button"
        className="world-control"
        onClick={onFit}
        aria-label="Fit map to view"
        title="Fit to view (0)"
        data-testid="world-fit"
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" />
        </svg>
      </button>
    </div>
  );
}

/**
 * Tooltip for the entity under the pointer. Its position is set imperatively by
 * WorldView (through `ref`) so pointer movement does not re-render React; only a
 * change of hovered entity or a new frame does.
 */
export function HoverTooltip({
  target,
  layout,
  frames,
  citizenLabel,
  ref,
}: {
  target: Selection | null;
  layout: LayoutResponse;
  frames: FrameStore;
  citizenLabel?: (id: number) => string | undefined;
  ref?: Ref<HTMLDivElement>;
}) {
  useFrameVersion(frames, target !== null);
  const text = target
    ? describeHover(target, layout, frames.state?.citizens ?? null, citizenLabel)
    : null;
  return (
    <div
      ref={ref}
      className="world-tooltip"
      data-testid="world-tooltip"
      hidden={!text}
      aria-hidden="true"
    >
      {text && (
        <>
          <div className="world-tooltip-title">{text.title}</div>
          {text.lines.map((line) => (
            <div key={line} className="world-tooltip-line">
              {line}
            </div>
          ))}
        </>
      )}
    </div>
  );
}
