import type { Building, Weather } from '@civ/sim-core';
import type { LayoutResponse } from '@civ/shared';
import { Application, Container, Graphics, TilingSprite, type Texture } from 'pixi.js';
import { hourAt, nightAlpha, weatherOverlay } from './atmosphere';
import {
  constrain,
  easeOutCubic,
  fitBounds,
  focusOn,
  lerpCamera,
  pan,
  sameCamera,
  screenToWorld,
  worldToScreen,
  zoomAt,
  zoomLimitsFor,
  type Camera,
  type Vec2,
  type Viewport,
  type ZoomLimits,
} from './camera';
import { CitizenLayer, citizenScreenRadius } from './citizen-layer';
import type { FrameStore } from './frame-store';
import { buildingCentre, buildingRect, mapBounds } from './geometry';
import { hitTest } from './hit-test';
import { PALETTE } from './palette';
import { PointerInput, type PointerInputHandler } from './pointer-input';
import { drawBuildings, drawGround, drawLaneMarkings } from './static-layers';
import { createCitizenTexture, createRainTexture } from './textures';
import { sameSelection, type Selection } from './types';

/*
 * WorldRenderer owns the PixiJS application that draws the map. It is a pure
 * consumer of the layout and the FrameStore: nothing it does feeds back into the
 * simulation.
 *
 * Scene graph (bottom to top):
 *
 *   worldBelow   camera-transformed, world pixels
 *     ground       roads, zoned blocks, fields, lots       (static, per layout)
 *     lanes        road centre lines, only when zoomed in  (static, per layout)
 *     buildings    houses, plazas, parks                   (static, per layout)
 *   nightTint    screen space, opacity from the calendar hour
 *   weatherTint  screen space, slight darkening in bad weather
 *   worldAbove   camera-transformed, world pixels
 *     citizens     one sprite per citizen                  (per frame / per animation frame)
 *     hover        outline of the entity under the pointer
 *     selection    outline of the selected entity (follows moving citizens)
 *   rain         screen space, tiling streak texture scrolled while it rains
 *
 * Citizens sit above the night tint so that they stay readable (and read as lit
 * windows and lanterns) at night.
 *
 * The render loop is driven by requestAnimationFrame but only re-renders when
 * something changed: the camera, a new frame, travelling citizens advancing
 * (render tick moving), the night tint, or rain. A paused simulation with an idle
 * camera costs no GPU work. The render rate is independent of the simulation rate.
 */

export interface HoverInfo {
  target: Selection | null;
  /** Pointer position in CSS pixels relative to the map surface. */
  x: number;
  y: number;
}

export interface WorldRendererCallbacks {
  onSelect(selection: Selection | null): void;
  onHover(hover: HoverInfo | null): void;
  /** The camera or viewport changed (used by the minimap). */
  onCameraChange(): void;
  /** Initialisation failed (e.g. no WebGL); the map cannot be shown. */
  onError(error: unknown): void;
}

/** Road centre lines are drawn from this zoom level on. */
const LANE_MIN_ZOOM = 1.3;
/** Focusing an entity zooms in to at least this level. */
const FOCUS_MIN_ZOOM = 1.6;
const FOCUS_DURATION_MS = 450;
const STEP_DURATION_MS = 160;
/** Screen-pixel slack around click/hover targets. */
const HIT_TOLERANCE_PX = 4;
/** Frames slower than this (ms) mean rendering is overloading the main thread. */
const OVERLOAD_FRAME_MS = 50;
/** Bounds of the ambient render interval while overloaded. */
const MIN_THROTTLED_INTERVAL_MS = 250;
const MAX_THROTTLED_INTERVAL_MS = 1000;
const MAX_COST_SAMPLE_MS = 1500;

interface CameraAnimation {
  from: Camera;
  to: Camera;
  start: number;
  duration: number;
}

interface FrameSummary {
  tick: number;
  hour: number;
  weather: Weather;
}

export class WorldRenderer {
  private app: Application | null = null;
  private destroyed = false;
  private input: PointerInput | null = null;
  private raf = 0;
  private lastNow = 0;
  /** Smoothed cost (ms) of a rendered animation frame; see renderNow. */
  private renderCostMs = 0;
  private renderedLastFrame = false;
  private ambientPending = false;
  private lastRender = 0;

  // Scene
  private readonly worldBelow = new Container({ label: 'world-below' });
  private readonly worldAbove = new Container({ label: 'world-above' });
  private readonly nightTint = new Graphics();
  private readonly weatherTint = new Graphics();
  private readonly hoverGfx = new Graphics();
  private readonly selectionGfx = new Graphics();
  private ground: Graphics | null = null;
  private lanes: Graphics | null = null;
  private buildingsGfx: Graphics | null = null;
  private rain: TilingSprite | null = null;
  private citizens: CitizenLayer | null = null;
  private textures: Texture[] = [];

  // Inputs
  private layout: LayoutResponse | null = null;
  private staticLayout: LayoutResponse | null = null;
  private buildingsById = new Map<number, Building>();
  private frames: FrameStore | null = null;
  private unsubscribeFrames: (() => void) | null = null;
  private framesDirty = true;
  private summary: FrameSummary | null = null;
  private lastRenderTick = Number.NaN;
  private selection: Selection | null = null;
  private hovered: Selection | null = null;
  private highlight: ReadonlySet<number> | null = null;
  private pointer: Vec2 | null = null;
  private dragging = false;
  private pendingFocus: Selection | null = null;

  // Camera
  private camera: Camera = { x: 0, y: 0, zoom: 1 };
  private viewport: Viewport = { width: 0, height: 0 };
  private limits: ZoomLimits = { min: 0.05, max: 6 };
  private fitted = false;
  private animation: CameraAnimation | null = null;
  private cameraDirty = true;
  private appliedZoom = Number.NaN;
  private needsRender = true;

  private readonly reducedMotion: MediaQueryList | null =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : null;

  constructor(
    private readonly host: HTMLElement,
    private readonly callbacks: WorldRendererCallbacks,
  ) {}

  /**
   * Create the PixiJS application (asynchronous in v8). Safe against destroy() being
   * called before initialisation finishes (React StrictMode mounts, unmounts and
   * mounts again): the late application is destroyed instead of being attached.
   */
  async init(): Promise<void> {
    const app = new Application();
    try {
      await app.init({
        width: Math.max(1, this.viewport.width || this.host.clientWidth),
        height: Math.max(1, this.viewport.height || this.host.clientHeight),
        antialias: true,
        resolution: window.devicePixelRatio || 1,
        autoDensity: true,
        background: PALETTE.void,
        autoStart: false,
        sharedTicker: false,
        preference: 'webgl',
      });
    } catch (error) {
      if (!this.destroyed) this.callbacks.onError(error);
      return;
    }
    if (this.destroyed) {
      app.destroy(true, { children: true });
      return;
    }
    this.app = app;
    app.ticker.stop();
    const canvas = app.canvas;
    canvas.classList.add('world-canvas');
    canvas.setAttribute('data-testid', 'world-canvas');
    this.host.appendChild(canvas);

    const citizenTexture = createCitizenTexture();
    const rainTexture = createRainTexture();
    this.textures = [citizenTexture, rainTexture];
    this.citizens = new CitizenLayer(citizenTexture);
    // Props may have arrived before initialisation finished.
    this.citizens.setHighlight(this.highlight);
    this.rain = new TilingSprite({ texture: rainTexture, width: 1, height: 1 });
    this.rain.tint = PALETTE.rain;
    this.rain.visible = false;
    // Transparent full-screen layers are hidden, not drawn at alpha 0 (fill rate matters
    // on software GL, e.g. headless browsers).
    this.nightTint.alpha = 0;
    this.nightTint.visible = false;
    this.weatherTint.alpha = 0;
    this.weatherTint.visible = false;
    this.worldAbove.addChild(this.citizens.container, this.hoverGfx, this.selectionGfx);
    app.stage.addChild(
      this.worldBelow,
      this.nightTint,
      this.weatherTint,
      this.worldAbove,
      this.rain,
    );

    this.input = new PointerInput(canvas, this.pointerHandler);
    this.updateCursor();
    if (this.layout) this.rebuildStatic(this.layout);
    this.resize(
      this.viewport.width || this.host.clientWidth,
      this.viewport.height || this.host.clientHeight,
    );
    this.raf = requestAnimationFrame(this.loop);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    this.unsubscribeFrames?.();
    this.unsubscribeFrames = null;
    this.input?.destroy();
    this.input = null;
    const app = this.app;
    this.app = null;
    if (app) {
      // Shared textures are owned here, not by the sprites that use them.
      this.citizens?.destroy();
      app.destroy(true, { children: true });
      for (const texture of this.textures) texture.destroy(true);
    }
    this.textures = [];
    this.citizens = null;
  }

  /** True once the map is drawn and the camera is placed (used by browser tests). */
  get ready(): boolean {
    return (
      this.app !== null &&
      this.staticLayout !== null &&
      this.fitted &&
      this.viewport.width > 0 &&
      this.viewport.height > 0
    );
  }

  // ---------------------------------------------------------------- inputs

  setLayout(layout: LayoutResponse): void {
    const previous = this.layout;
    this.layout = layout;
    if (previous && previous.map === layout.map && previous.buildings === layout.buildings) return;
    this.buildingsById = new Map(layout.buildings.map((b) => [b.id, b]));
    const resized =
      !previous ||
      previous.map.width !== layout.map.width ||
      previous.map.height !== layout.map.height;
    if (resized) this.fitted = false;
    if (this.app) this.rebuildStatic(layout);
    this.updateLimits();
    this.ensureFitted();
  }

  setFrames(frames: FrameStore): void {
    if (frames === this.frames) return;
    this.unsubscribeFrames?.();
    this.frames = frames;
    this.unsubscribeFrames = frames.subscribe(() => {
      this.framesDirty = true;
    });
    this.framesDirty = true;
  }

  setSelection(selection: Selection | null): void {
    if (sameSelection(selection, this.selection)) return;
    this.selection = selection;
    this.drawMarkers();
  }

  setHighlight(highlight: ReadonlySet<number> | null): void {
    if (highlight === this.highlight) return;
    this.highlight = highlight;
    this.citizens?.setHighlight(highlight);
    this.needsRender = true;
  }

  /** Resize the drawing surface (CSS pixels). */
  resize(width: number, height: number): void {
    const w = Math.max(0, Math.floor(width));
    const h = Math.max(0, Math.floor(height));
    this.viewport = { width: w, height: h };
    const app = this.app;
    if (!app || w === 0 || h === 0) return;
    app.renderer.resize(w, h, window.devicePixelRatio || 1);
    this.nightTint.clear().rect(0, 0, w, h).fill(PALETTE.nightTint);
    this.weatherTint.clear().rect(0, 0, w, h).fill(PALETTE.stormTint);
    if (this.rain) {
      this.rain.width = w;
      this.rain.height = h;
    }
    this.updateLimits();
    this.ensureFitted();
    this.setCamera(this.camera);
    this.cameraDirty = true;
    // Render now: resizing clears the canvas, and waiting for the next frame would flash.
    this.renderNow(performance.now());
  }

  // ---------------------------------------------------------------- camera commands

  getCamera(): Camera {
    return this.camera;
  }

  getViewport(): Viewport {
    return this.viewport;
  }

  /** Zoom about the viewport centre (buttons, keyboard). */
  zoomBy(factor: number): void {
    const base = this.animation?.to ?? this.camera;
    const { width, height } = this.viewport;
    this.animateTo(
      zoomAt(base, this.viewport, width / 2, height / 2, factor, this.limits),
      STEP_DURATION_MS,
    );
  }

  /** Pan by a screen delta with a short animation (keyboard). */
  panStep(dx: number, dy: number): void {
    const base = this.animation?.to ?? this.camera;
    this.animateTo(pan(base, dx, dy), STEP_DURATION_MS);
  }

  /** Show the whole map. */
  fit(animate = true): void {
    if (!this.layout || this.viewport.width === 0) return;
    const target = fitBounds(mapBounds(this.layout.map), this.viewport, this.limits);
    if (animate) this.animateTo(target, FOCUS_DURATION_MS);
    else this.setCamera(target);
  }

  /** Centre on a world point immediately (minimap navigation). */
  centreOn(wx: number, wy: number): void {
    this.animation = null;
    this.setCamera({ x: wx, y: wy, zoom: this.camera.zoom });
  }

  /**
   * Centre the camera on an entity (zooming in if far out). If the entity is not
   * known yet (e.g. frames not received), the focus is retried on the next frame.
   */
  focus(target: Selection, animate = true): void {
    const p = this.positionOf(target);
    if (!p) {
      this.pendingFocus = target;
      return;
    }
    this.pendingFocus = null;
    const next = focusOn(this.animation?.to ?? this.camera, p.x, p.y, FOCUS_MIN_ZOOM, this.limits);
    if (animate) this.animateTo(next, FOCUS_DURATION_MS);
    else this.setCamera(next);
  }

  /**
   * Client (viewport) coordinates of an entity's centre, or null when unknown,
   * outside the visible map area, or covered by an overlay control.
   */
  screenPointOf(target: Selection): Vec2 | null {
    const app = this.app;
    const p = this.positionOf(target);
    if (!app || !p || !this.ready) return null;
    const s = worldToScreen(this.camera, this.viewport, p.x, p.y);
    if (s.x < 0 || s.y < 0 || s.x > this.viewport.width || s.y > this.viewport.height) return null;
    const rect = app.canvas.getBoundingClientRect();
    const client = { x: rect.left + s.x, y: rect.top + s.y };
    const topmost = document.elementFromPoint(client.x, client.y);
    return topmost === app.canvas ? client : null;
  }

  // ---------------------------------------------------------------- pointer input

  /** Gestures from PointerInput, in screen pixels relative to the canvas. */
  private readonly pointerHandler: PointerInputHandler = {
    panBy: (dx, dy) => this.setCamera(pan(this.camera, dx, dy)),
    zoomAt: (sx, sy, factor) =>
      this.setCamera(zoomAt(this.camera, this.viewport, sx, sy, factor, this.limits)),
    click: (sx, sy) => this.callbacks.onSelect(this.pick(sx, sy)),
    hover: (point) => {
      this.pointer = point;
      this.refreshHover(true);
    },
    gestureStart: () => {
      this.animation = null;
      this.pendingFocus = null;
    },
    setDragging: (dragging) => {
      this.dragging = dragging;
      this.updateCursor();
    },
  };

  // ---------------------------------------------------------------- internals

  private readonly loop = (now: number): void => {
    this.raf = requestAnimationFrame(this.loop);
    this.renderNow(now);
  };

  /**
   * Bring every layer up to date for time `now` and render if anything changed.
   *
   * Changes are either urgent (direct feedback to the user: camera, selection, hover,
   * highlight) or ambient (new frames, travellers advancing, night tint, rain). Urgent
   * changes always render immediately. Ambient renders are throttled when rendering is
   * expensive (e.g. software WebGL without a GPU), so continuous animation cannot
   * monopolise the main thread and starve the rest of the page.
   */
  private renderNow(now: number): void {
    const app = this.app;
    const citizens = this.citizens;
    if (!app || !citizens || this.viewport.width === 0 || this.viewport.height === 0) return;
    const elapsed = this.lastNow > 0 ? Math.max(0, now - this.lastNow) : 0;
    this.lastNow = now;
    // The interval following a rendered frame measures what rendering costs here.
    // Very long intervals (background tab, debugger) say nothing about rendering.
    if (this.renderedLastFrame && elapsed > 0 && elapsed < MAX_COST_SAMPLE_MS) {
      this.renderCostMs =
        this.renderCostMs === 0 ? elapsed : this.renderCostMs * 0.8 + elapsed * 0.2;
    }

    let urgent = this.needsRender;
    this.needsRender = false;
    if (this.animation) {
      this.stepAnimation(now);
      urgent = true;
    }
    if (this.cameraDirty) {
      this.applyCamera();
      urgent = true;
    }

    let ambient = false;
    const renderTick = this.frames ? this.frames.renderTick(now) : 0;
    if (this.framesDirty) {
      this.framesDirty = false;
      this.syncFrames(renderTick);
      ambient = true;
    } else if (renderTick !== this.lastRenderTick && citizens.travellerCount > 0) {
      citizens.updateTravellers(renderTick);
      ambient = true;
    }
    this.lastRenderTick = renderTick;
    if (this.updateAtmosphere(renderTick, Math.min(100, elapsed))) ambient = true;
    // syncFrames may have redrawn markers (hover changed under the pointer).
    if (this.needsRender) {
      this.needsRender = false;
      urgent = true;
    }
    this.ambientPending ||= ambient;

    const render = urgent || (this.ambientPending && this.ambientRenderDue(now));
    this.renderedLastFrame = render;
    if (!render) return;
    this.trackMarkers();
    app.render();
    this.ambientPending = false;
    this.lastRender = now;
  }

  /** Whether an ambient-only render may happen now (see renderNow). */
  private ambientRenderDue(now: number): boolean {
    if (this.renderCostMs <= OVERLOAD_FRAME_MS) return true;
    const interval = Math.min(
      MAX_THROTTLED_INTERVAL_MS,
      Math.max(MIN_THROTTLED_INTERVAL_MS, this.renderCostMs * 3),
    );
    return now - this.lastRender >= interval;
  }

  private syncFrames(renderTick: number): void {
    const state = this.frames?.state ?? null;
    this.summary = state
      ? { tick: state.tick, hour: state.calendar.hour, weather: state.weather }
      : null;
    this.citizens?.sync(state, renderTick);
    if (this.pendingFocus) this.focus(this.pendingFocus);
    this.refreshHover(false);
  }

  private rebuildStatic(layout: LayoutResponse): void {
    for (const g of [this.ground, this.lanes, this.buildingsGfx]) g?.destroy();
    this.ground = drawGround(layout.map);
    this.lanes = drawLaneMarkings(layout.map);
    this.buildingsGfx = drawBuildings(layout.buildings);
    this.lanes.visible = this.camera.zoom >= LANE_MIN_ZOOM;
    this.worldBelow.addChild(this.ground, this.lanes, this.buildingsGfx);
    this.citizens?.setLayout(layout.map, layout.buildings);
    this.staticLayout = layout;
    this.framesDirty = true;
    this.drawMarkers();
  }

  private updateLimits(): void {
    if (!this.layout || this.viewport.width === 0 || this.viewport.height === 0) return;
    this.limits = zoomLimitsFor(mapBounds(this.layout.map), this.viewport);
  }

  /** Fit the whole map once a layout and a non-empty viewport are both known. */
  private ensureFitted(): void {
    if (this.fitted || !this.layout || this.viewport.width === 0 || this.viewport.height === 0) {
      return;
    }
    this.animation = null;
    this.camera = fitBounds(mapBounds(this.layout.map), this.viewport, this.limits);
    this.fitted = true;
    this.cameraDirty = true;
  }

  private setCamera(next: Camera): void {
    const bounded = this.layout ? constrain(next, mapBounds(this.layout.map), this.limits) : next;
    if (sameCamera(bounded, this.camera) && !this.cameraDirty) return;
    this.camera = bounded;
    this.cameraDirty = true;
  }

  private animateTo(target: Camera, duration: number): void {
    const to = this.layout ? constrain(target, mapBounds(this.layout.map), this.limits) : target;
    if (this.reducedMotion?.matches || duration <= 0) {
      this.animation = null;
      this.setCamera(to);
      return;
    }
    this.animation = { from: this.camera, to, start: performance.now(), duration };
    this.needsRender = true;
  }

  private stepAnimation(now: number): void {
    const a = this.animation;
    if (!a) return;
    const t = (now - a.start) / a.duration;
    this.setCamera(t >= 1 ? a.to : lerpCamera(a.from, a.to, easeOutCubic(t)));
    if (t >= 1) this.animation = null;
  }

  /** Apply the camera to both world containers; zoom-dependent details follow. */
  private applyCamera(): void {
    this.cameraDirty = false;
    const { x, y, zoom } = this.camera;
    const ox = this.viewport.width / 2 - x * zoom;
    const oy = this.viewport.height / 2 - y * zoom;
    this.worldBelow.scale.set(zoom);
    this.worldBelow.position.set(ox, oy);
    this.worldAbove.scale.set(zoom);
    this.worldAbove.position.set(ox, oy);
    if (zoom !== this.appliedZoom) {
      this.appliedZoom = zoom;
      this.citizens?.setZoom(zoom);
      if (this.lanes) this.lanes.visible = zoom >= LANE_MIN_ZOOM;
      this.drawMarkers();
    }
    this.callbacks.onCameraChange();
  }

  private positionOf(target: Selection): Vec2 | null {
    if (target.kind === 'building') {
      const b = this.buildingsById.get(target.id);
      return b ? buildingCentre(b) : null;
    }
    return this.citizens?.positionOf(target.id) ?? null;
  }

  private pick(sx: number, sy: number): Selection | null {
    if (!this.layout || !this.citizens) return null;
    const w = screenToWorld(this.camera, this.viewport, sx, sy);
    const zoom = this.camera.zoom;
    return hitTest(this.citizens.points(), this.layout.buildings, w.x, w.y, {
      zoom,
      citizenRadiusPx: citizenScreenRadius(zoom),
      tolerancePx: HIT_TOLERANCE_PX,
    });
  }

  /** Re-evaluate what is under the pointer (after pointer moves and new frames). */
  private refreshHover(pointerMoved: boolean): void {
    const point = this.dragging ? null : this.pointer;
    const target = point ? this.pick(point.x, point.y) : null;
    const changed = !sameSelection(target, this.hovered);
    if (changed) {
      this.hovered = target;
      this.drawMarkers();
      this.updateCursor();
    }
    if (changed || pointerMoved) {
      this.callbacks.onHover(point ? { target, x: point.x, y: point.y } : null);
    }
  }

  private updateCursor(): void {
    const canvas = this.app?.canvas;
    if (!canvas) return;
    canvas.style.cursor = this.dragging ? 'grabbing' : this.hovered ? 'pointer' : 'grab';
  }

  /**
   * Redraw hover and selection outlines. Building outlines are drawn in place;
   * citizen rings are drawn around the origin and moved by trackMarkers(). Line
   * widths are divided by the zoom so they stay constant on screen.
   */
  private drawMarkers(): void {
    const zoom = this.camera.zoom;
    this.drawMarker(
      this.hoverGfx,
      this.hovered && !sameSelection(this.hovered, this.selection) ? this.hovered : null,
      zoom,
      false,
    );
    this.drawMarker(this.selectionGfx, this.selection, zoom, true);
    this.trackMarkers();
    this.needsRender = true;
  }

  private drawMarker(g: Graphics, target: Selection | null, zoom: number, selected: boolean): void {
    g.clear();
    g.position.set(0, 0);
    if (!target) return;
    const px = 1 / zoom;
    const main = selected ? PALETTE.selection : PALETTE.hover;
    if (target.kind === 'citizen') {
      const r = (citizenScreenRadius(zoom) + (selected ? 3 : 2)) * px;
      if (selected)
        g.circle(0, 0, r + 2.5 * px).stroke({
          width: 2 * px,
          color: PALETTE.selectionAccent,
          alpha: 0.9,
        });
      g.circle(0, 0, r).stroke({
        width: (selected ? 2 : 1.5) * px,
        color: main,
        alpha: selected ? 1 : 0.8,
      });
      return;
    }
    const b = this.buildingsById.get(target.id);
    if (!b) return;
    const r = buildingRect(b);
    const pad = (selected ? 3 : 2) * px;
    if (selected) {
      const outer = pad + 2.5 * px;
      g.rect(r.x - outer, r.y - outer, r.width + 2 * outer, r.height + 2 * outer).stroke({
        width: 2 * px,
        color: PALETTE.selectionAccent,
        alpha: 0.9,
      });
    }
    g.rect(r.x - pad, r.y - pad, r.width + 2 * pad, r.height + 2 * pad).stroke({
      width: (selected ? 2 : 1.5) * px,
      color: main,
      alpha: selected ? 1 : 0.7,
    });
  }

  /** Move citizen rings to their citizens' current positions (every rendered frame). */
  private trackMarkers(): void {
    this.trackMarker(this.selectionGfx, this.selection);
    this.trackMarker(this.hoverGfx, this.hovered);
  }

  private trackMarker(g: Graphics, target: Selection | null): void {
    if (!target || target.kind !== 'citizen') {
      g.visible = true;
      return;
    }
    const p = this.citizens?.positionOf(target.id) ?? null;
    g.visible = p !== null;
    if (p) g.position.set(p.x, p.y);
  }

  /** Night tint and weather. Returns true when something visible changed. */
  private updateAtmosphere(renderTick: number, dt: number): boolean {
    const s = this.summary;
    let changed = false;
    const night = s ? nightAlpha(hourAt(s.hour, s.tick, renderTick)) : 0;
    if (Math.abs(night - this.nightTint.alpha) > 0.001) {
      this.nightTint.alpha = night;
      this.nightTint.visible = night > 0;
      changed = true;
    }
    const weather = weatherOverlay(s?.weather ?? 'clear');
    if (weather.darken !== this.weatherTint.alpha) {
      this.weatherTint.alpha = weather.darken;
      this.weatherTint.visible = weather.darken > 0;
      changed = true;
    }
    const rain = this.rain;
    if (rain) {
      const visible = weather.rainAlpha > 0;
      if (rain.visible !== visible || rain.alpha !== weather.rainAlpha) {
        rain.visible = visible;
        rain.alpha = weather.rainAlpha;
        changed = true;
      }
      if (visible && !this.reducedMotion?.matches && dt > 0) {
        rain.tilePosition.x += (weather.rainDrift * dt) / 1000;
        rain.tilePosition.y += (weather.rainSpeed * dt) / 1000;
        changed = true;
      }
    }
    return changed;
  }
}
