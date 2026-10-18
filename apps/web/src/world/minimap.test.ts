import { describe, expect, it } from 'vitest';
import { minimapLayout, minimapToWorld, worldRectToMinimap } from './minimap';

describe('minimap', () => {
  const layout = minimapLayout({ x: 0, y: 0, width: 1600, height: 800 }, 160);

  it('fits the map into the box keeping its aspect', () => {
    expect(layout).toEqual({ width: 160, height: 80, scale: 0.1 });
  });

  it('maps minimap pixels to world pixels', () => {
    expect(minimapToWorld(layout, 80, 40)).toEqual({ x: 800, y: 400 });
  });

  it('clips the viewport frame to the minimap', () => {
    expect(worldRectToMinimap(layout, { x: 400, y: 200, width: 400, height: 200 })).toEqual({
      x: 40,
      y: 20,
      width: 40,
      height: 20,
    });
    expect(worldRectToMinimap(layout, { x: -400, y: -400, width: 3000, height: 3000 })).toEqual({
      x: 0,
      y: 0,
      width: 160,
      height: 80,
    });
  });
});
