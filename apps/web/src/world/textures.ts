import { CanvasSource, Texture } from 'pixi.js';
import { PALETTE, cssColor, unitHash } from './palette';

/*
 * Procedurally generated textures (drawn once on a 2D canvas, uploaded to the GPU).
 * No image assets are loaded.
 */

/** Size of the citizen dot texture; the dot's visual radius is CITIZEN_TEXTURE_RADIUS. */
const DOT_TEXTURE_SIZE = 64;
export const CITIZEN_TEXTURE_RADIUS = DOT_TEXTURE_SIZE / 2;

function makeCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function canvasTexture(canvas: HTMLCanvasElement, mipmaps: boolean): Texture {
  return new Texture({
    source: new CanvasSource({
      resource: canvas,
      autoGenerateMipmaps: mipmaps,
      scaleMode: 'linear',
      addressMode: 'repeat',
    }),
  });
}

/**
 * White disc with a dark rim. Sprites tint it with the activity colour (the tint
 * multiplies, so the rim stays dark and separates the dot from any background).
 */
export function createCitizenTexture(): Texture {
  const canvas = makeCanvas(DOT_TEXTURE_SIZE, DOT_TEXTURE_SIZE);
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const c = DOT_TEXTURE_SIZE / 2;
    ctx.beginPath();
    ctx.arc(c, c, c - 1, 0, Math.PI * 2);
    ctx.fillStyle = cssColor(PALETTE.void);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(c, c, c - 9, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
  }
  return canvasTexture(canvas, true);
}

const RAIN_TEXTURE_SIZE = 128;
const RAIN_STREAKS = 26;

/**
 * Tileable texture of thin, slightly slanted rain streaks at deterministic
 * pseudo-random positions. Drawn white; the sprite's tint and alpha set the look.
 */
export function createRainTexture(): Texture {
  const size = RAIN_TEXTURE_SIZE;
  const canvas = makeCanvas(size, size);
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.strokeStyle = '#ffffff';
    ctx.lineCap = 'round';
    for (let i = 0; i < RAIN_STREAKS; i++) {
      const x = unitHash(i, 11) * size;
      const y = unitHash(i, 12) * size;
      const length = 7 + unitHash(i, 13) * 9;
      ctx.globalAlpha = 0.45 + unitHash(i, 14) * 0.55;
      ctx.lineWidth = 1;
      // Draw each streak at its position and wrapped copies so the tile repeats seamlessly.
      for (const ox of [-size, 0, size]) {
        for (const oy of [-size, 0, size]) {
          ctx.beginPath();
          ctx.moveTo(x + ox, y + oy);
          ctx.lineTo(x + ox + length * 0.22, y + oy + length);
          ctx.stroke();
        }
      }
    }
  }
  return canvasTexture(canvas, false);
}
