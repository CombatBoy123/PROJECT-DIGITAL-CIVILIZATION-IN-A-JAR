import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { ZOOM_STEP, cameraKeyAction } from './camera';
import { Minimap, type MinimapHandle } from './Minimap';
import { HoverTooltip, MapControls, MapLegend } from './overlays';
import { WorldRenderer, type HoverInfo } from './renderer';
import type { CivWorldTestHook } from './test-hook';
import { sameSelection, type Selection, type WorldViewProps } from './types';
import './world.css';

/*
 * React shell of the world map. It owns one WorldRenderer (PixiJS) for its lifetime,
 * forwards props to it, and renders the HTML overlays (controls, legend, minimap,
 * tooltip). The renderer is a pure consumer of `layout` and `frames`; user
 * interaction is reported through `onSelect` only.
 *
 * Lifecycle: the renderer is created in an effect and destroyed in its cleanup.
 * PixiJS initialisation is asynchronous, so under React StrictMode the first
 * renderer may be destroyed before it finishes initialising; WorldRenderer handles
 * that by discarding the late application.
 */

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function WorldView(props: WorldViewProps) {
  const { layout, frames, selection, onSelect, highlight, citizenLabel, focus, focusNonce } = props;
  const surfaceRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<WorldRenderer | null>(null);
  const minimapRef = useRef<MinimapHandle | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const onSelectRef = useRef(onSelect);
  const [hoverTarget, setHoverTarget] = useState<Selection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const helpId = useId();

  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  /** Position the tooltip next to the pointer (flipped near the right/bottom edges). */
  const placeTooltip = useCallback((hover: HoverInfo | null) => {
    const el = tooltipRef.current;
    const surface = surfaceRef.current;
    if (!el || !surface || !hover) return;
    el.style.left = `${hover.x}px`;
    el.style.top = `${hover.y}px`;
    el.dataset.flipX = String(hover.x > surface.clientWidth * 0.62);
    el.dataset.flipY = String(hover.y > surface.clientHeight * 0.7);
  }, []);

  // Create the renderer once per mount.
  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const renderer = new WorldRenderer(surface, {
      onSelect: (s) => onSelectRef.current(s),
      onHover: (hover) => {
        placeTooltip(hover);
        const target = hover?.target ?? null;
        setHoverTarget((prev) => (sameSelection(prev, target) ? prev : target));
      },
      onCameraChange: () =>
        minimapRef.current?.update(renderer.getCamera(), renderer.getViewport()),
      onError: (e) => setError(errorMessage(e)),
    });
    rendererRef.current = renderer;
    const observer = new ResizeObserver((entries) => {
      const box = entries[entries.length - 1]?.contentRect;
      if (box) renderer.resize(box.width, box.height);
    });
    observer.observe(surface);
    renderer.resize(surface.clientWidth, surface.clientHeight);
    void renderer.init();

    const hook: CivWorldTestHook = {
      screenPointOf: (s) => renderer.screenPointOf(s),
      get ready() {
        return renderer.ready;
      },
    };
    window.__civWorldTestHook = hook;
    return () => {
      observer.disconnect();
      renderer.destroy();
      rendererRef.current = null;
      if (window.__civWorldTestHook === hook) delete window.__civWorldTestHook;
    };
  }, [placeTooltip]);

  useEffect(() => {
    rendererRef.current?.setLayout(layout);
  }, [layout]);
  useEffect(() => {
    rendererRef.current?.setFrames(frames);
  }, [frames]);
  useEffect(() => {
    rendererRef.current?.setSelection(selection);
  }, [selection]);
  useEffect(() => {
    rendererRef.current?.setHighlight(highlight ?? null);
  }, [highlight]);
  // A new nonce (or a new target) asks for the camera to move to the entity.
  useEffect(() => {
    if (focus) rendererRef.current?.focus(focus);
  }, [focus, focusNonce]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.target !== event.currentTarget) return;
    const action = cameraKeyAction(event);
    const renderer = rendererRef.current;
    if (!action || !renderer) return;
    event.preventDefault();
    if (action.type === 'pan') renderer.panStep(action.dx, action.dy);
    else if (action.type === 'zoom') renderer.zoomBy(action.factor);
    else if (action.type === 'fit') renderer.fit();
    else onSelectRef.current(null);
  };

  return (
    <div className="world-view" data-testid="world-view">
      <div
        ref={surfaceRef}
        className="world-surface"
        tabIndex={0}
        role="application"
        aria-roledescription="map"
        aria-label="World map"
        aria-describedby={helpId}
        onKeyDown={onKeyDown}
      />
      <p id={helpId} className="world-sr-only">
        Arrow keys or W, A, S, D pan the map; plus and minus zoom; 0 fits the whole map; Escape
        clears the selection. Click a citizen or building to select it.
      </p>
      {error ? (
        <div className="world-error" role="alert">
          The map could not be displayed ({error}). This browser may not support WebGL.
        </div>
      ) : (
        <>
          <MapControls
            onZoomIn={() => rendererRef.current?.zoomBy(ZOOM_STEP)}
            onZoomOut={() => rendererRef.current?.zoomBy(1 / ZOOM_STEP)}
            onFit={() => rendererRef.current?.fit()}
          />
          <MapLegend frames={frames} />
          <Minimap
            ref={minimapRef}
            map={layout.map}
            onNavigate={(wx, wy) => rendererRef.current?.centreOn(wx, wy)}
          />
          <HoverTooltip
            ref={tooltipRef}
            target={hoverTarget}
            layout={layout}
            frames={frames}
            citizenLabel={citizenLabel}
          />
        </>
      )}
    </div>
  );
}
