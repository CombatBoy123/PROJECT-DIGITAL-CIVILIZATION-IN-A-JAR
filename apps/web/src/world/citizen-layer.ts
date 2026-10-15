import {
  ACTIVITY_BY_CODE,
  type Activity,
  type Building,
  type Point,
  type WorldMap,
} from '@civ/sim-core';
import { Container, Sprite, type Texture } from 'pixi.js';
import type { Vec2 } from './camera';
import {
  T_ACTIVITY,
  T_ARRIVE,
  T_DEPART,
  T_FROM,
  T_ID,
  T_LOCATION,
  T_TO,
  type FrameState,
} from './frame-store';
import { buildingSlots, groupByLocation, travellerPosition, tripRoute } from './geometry';
import type { CitizenPoint } from './hit-test';
import { ACTIVITY_COLORS, citizenAlpha } from './palette';
import { CITIZEN_TEXTURE_RADIUS } from './textures';

/*
 * Citizen layer: one pooled sprite per citizen (a tinted disc), in world pixels.
 *
 * Two update rates:
 *  - sync(), when the FrameStore changes (a few times per second): activities,
 *    colours, slot positions of citizens inside buildings, and the road route of
 *    each new trip (computed once per trip with the engine's roadRoute);
 *  - updateTravellers(), every animation frame while ticks are advancing: only the
 *    travelling citizens move, interpolated along their cached route.
 *
 * Sprites are reused across frames and only created/destroyed when citizens appear
 * or disappear, so steady-state animation allocates almost nothing.
 */

/** Radius of a citizen dot in world pixels at zoom 1 (slots are ~8 px apart in a house). */
export const CITIZEN_WORLD_RADIUS = 3.2;
/** Screen-pixel radius bounds, so dots stay visible when zoomed out and small when zoomed in. */
const MIN_SCREEN_RADIUS = 2;
const MAX_SCREEN_RADIUS = 7;

/** On-screen radius (CSS px) of a citizen dot at a zoom level. */
export function citizenScreenRadius(zoom: number): number {
  return Math.min(MAX_SCREEN_RADIUS, Math.max(MIN_SCREEN_RADIUS, CITIZEN_WORLD_RADIUS * zoom));
}

interface Dot extends CitizenPoint {
  sprite: Sprite;
  activity: Activity | undefined;
  dimmed: boolean;
  /** Generation of the last sync that saw this citizen (stale dots are removed). */
  seen: number;
  travelling: boolean;
  fromId: number;
  toId: number;
  departTick: number;
  arriveTick: number;
  /** Engine road route of the current trip (tile coordinates), null when unknown. */
  route: Point[] | null;
}

export class CitizenLayer {
  readonly container = new Container();
  private readonly dots = new Map<number, Dot>();
  private travellers: Dot[] = [];
  private generation = 0;
  private map: WorldMap | null = null;
  private buildings = new Map<number, Building>();
  private highlight: ReadonlySet<number> | null = null;
  /** Sprite scale for the current zoom (see setZoom). */
  private scale = 1 / CITIZEN_TEXTURE_RADIUS;

  constructor(private readonly texture: Texture) {
    this.container.label = 'citizens';
  }

  /** Visible citizen positions for hit testing. */
  points(): Iterable<CitizenPoint> {
    return this.dots.values();
  }

  get size(): number {
    return this.dots.size;
  }

  setLayout(map: WorldMap, buildings: readonly Building[]): void {
    this.map = map;
    this.buildings = new Map(buildings.map((b) => [b.id, b]));
    // Routes depend on the map; force recomputation on the next sync.
    for (const dot of this.dots.values()) dot.route = null;
  }

  /** Apply the latest frame (null after a reset: removes every dot). */
  sync(state: FrameState | null, renderTick: number): void {
    const gen = ++this.generation;
    const located: [number, number][] = [];
    const travellers: Dot[] = [];
    if (state) {
      for (const tuple of state.citizens.values()) {
        const id = tuple[T_ID];
        const dot = this.dots.get(id) ?? this.createDot(id);
        dot.seen = gen;
        this.setActivity(dot, ACTIVITY_BY_CODE[tuple[T_ACTIVITY]]);
        const location = tuple[T_LOCATION];
        if (location !== 0) {
          dot.travelling = false;
          dot.route = null;
          located.push([id, location]);
          continue;
        }
        this.setTrip(dot, tuple[T_FROM], tuple[T_TO], tuple[T_DEPART], tuple[T_ARRIVE]);
        if (dot.route) travellers.push(dot);
        else this.hide(dot);
      }
    }
    for (const [id, dot] of this.dots) {
      if (dot.seen !== gen) {
        dot.sprite.destroy();
        this.dots.delete(id);
      }
    }
    for (const [buildingId, ids] of groupByLocation(located)) {
      const building = this.buildings.get(buildingId);
      const slots = building ? buildingSlots(building, ids.length) : [];
      ids.forEach((id, i) => {
        const dot = this.dots.get(id);
        const slot = slots[i];
        if (!dot) return;
        if (slot) this.place(dot, slot.x, slot.y);
        else this.hide(dot);
      });
    }
    this.travellers = travellers;
    this.updateTravellers(renderTick);
  }

  /** Move travelling citizens to their interpolated positions at `renderTick`. */
  updateTravellers(renderTick: number): void {
    for (const dot of this.travellers) {
      if (!dot.route) continue;
      const p = travellerPosition(dot.route, renderTick, dot.departTick, dot.arriveTick);
      this.place(dot, p.x, p.y);
    }
  }

  get travellerCount(): number {
    return this.travellers.length;
  }

  setHighlight(highlight: ReadonlySet<number> | null): void {
    this.highlight = highlight;
    for (const dot of this.dots.values()) this.applyAlpha(dot);
  }

  /** Keep dots at a constant on-screen size, independent of the world zoom. */
  setZoom(zoom: number): void {
    const scale = citizenScreenRadius(zoom) / zoom / CITIZEN_TEXTURE_RADIUS;
    for (const dot of this.dots.values()) dot.sprite.scale.set(scale);
    this.scale = scale;
  }

  /** Current rendered position of a citizen in world pixels, or null if not shown. */
  positionOf(id: number): Vec2 | null {
    const dot = this.dots.get(id);
    return dot && dot.visible ? { x: dot.x, y: dot.y } : null;
  }

  activityOf(id: number): Activity | undefined {
    return this.dots.get(id)?.activity;
  }

  isTravelling(id: number): boolean {
    return this.dots.get(id)?.travelling ?? false;
  }

  clear(): void {
    for (const dot of this.dots.values()) dot.sprite.destroy();
    this.dots.clear();
    this.travellers = [];
  }

  destroy(): void {
    this.clear();
    this.container.destroy({ children: true });
  }

  private createDot(id: number): Dot {
    const sprite = new Sprite(this.texture);
    sprite.anchor.set(0.5);
    sprite.scale.set(this.scale);
    sprite.visible = false;
    this.container.addChild(sprite);
    const dot: Dot = {
      id,
      x: 0,
      y: 0,
      visible: false,
      sprite,
      activity: undefined,
      dimmed: false,
      seen: 0,
      travelling: false,
      fromId: 0,
      toId: 0,
      departTick: 0,
      arriveTick: 0,
      route: null,
    };
    this.dots.set(id, dot);
    return dot;
  }

  private setActivity(dot: Dot, activity: Activity | undefined): void {
    const dimmed = this.highlight !== null && !this.highlight.has(dot.id);
    if (dot.activity === activity && dot.dimmed === dimmed) return;
    dot.activity = activity;
    dot.sprite.tint = activity ? ACTIVITY_COLORS[activity] : 0xffffff;
    this.applyAlpha(dot);
  }

  private applyAlpha(dot: Dot): void {
    dot.dimmed = this.highlight !== null && !this.highlight.has(dot.id);
    dot.sprite.alpha = citizenAlpha(dot.activity, dot.dimmed);
  }

  private setTrip(dot: Dot, fromId: number, toId: number, depart: number, arrive: number): void {
    const sameTrip =
      dot.travelling &&
      dot.route !== null &&
      dot.fromId === fromId &&
      dot.toId === toId &&
      dot.departTick === depart &&
      dot.arriveTick === arrive;
    dot.travelling = true;
    if (sameTrip) return;
    dot.fromId = fromId;
    dot.toId = toId;
    dot.departTick = depart;
    dot.arriveTick = arrive;
    const from = this.buildings.get(fromId);
    const to = this.buildings.get(toId);
    dot.route = from && to && this.map ? tripRoute(this.map, from, to) : null;
  }

  private place(dot: Dot, x: number, y: number): void {
    dot.x = x;
    dot.y = y;
    dot.visible = true;
    dot.sprite.position.set(x, y);
    dot.sprite.visible = true;
  }

  private hide(dot: Dot): void {
    dot.visible = false;
    dot.sprite.visible = false;
  }
}
