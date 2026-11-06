// The ten liquid shapes (colour index mod 10: drop, flame, leaf, star, moon,
// wave, gem, spiral, eye, rune) that the browser build stamped on every
// layer from an inline SVG sprite (js/ui.js buildShapeSprite, a 24 × 24 view
// box), so a colour is never the only channel. The SVG paths are filled, or
// stroked 2 units wide with round caps, by draw.path at any size, position and
// turn; the engine keeps them parsed.
import * as draw from "starhermit:draw";

interface Shape { fill?: string; stroke?: string; strokeAlpha?: number; pupil?: string }
const SHAPES: Shape[] = [
  { fill: "M12 3C12 3 5 12 5 16a7 7 0 0 0 14 0C19 12 12 3 12 3Z" }, // drop
  { fill: "M12 2c2 5 6 7 6 12a6 6 0 0 1-12 0C6 9 10 7 12 2Z" }, // flame
  { fill: "M4 20C4 10 10 4 20 4c0 10-6 16-16 16Z", stroke: "M4 20C9 15 13 11 18 6" }, // leaf
  { fill: "M12 2l2.5 7H22l-6 4.5L18 21l-6-4.5L6 21l2-7.5L2 9h7.5Z" }, // star
  { fill: "M20 14A8 8 0 1 1 10 4a6.5 6.5 0 0 0 10 10Z" }, // moon
  { stroke: "M2 12c3-4 5 4 8 0s5 4 8 0" }, // wave
  { fill: "M12 2l8 7-8 13L4 9Z", stroke: "M4 9h16M12 2v20", strokeAlpha: 0.5 }, // gem
  { stroke: "M12 4a8 8 0 1 0 8 8 6 6 0 1 1-6-6 4 4 0 1 0 4 4" }, // spiral
  { fill: "M2 12c4-7 16-7 20 0-4 7-16 7-20 0Z", pupil: "M9 12a3 3 0 1 0 6 0a3 3 0 1 0-6 0Z" }, // eye
  { stroke: "M12 2v20M6 6l6 4 6-4M6 18l6-4 6 4" }, // rune
];

/** "#rrggbb" or "#rrggbbaa" with its alpha multiplied by `k`. */
function alpha(color: string, k: number): string {
  if (k >= 1) return color;
  const h = color.replace("#", "");
  const a = h.length >= 8 ? parseInt(h.slice(6, 8), 16) : 255;
  return `#${h.slice(0, 6)}${Math.round(a * k).toString(16).padStart(2, "0")}`;
}

/**
 * Draws shape `index` (mod 10) centred at (cx, cy) in a `size`-pixel square
 * (the SVG's 24 units), turned `turn` radians clockwise, in `color`; the
 * eye's pupil in `pupil`.
 */
export function drawShape(index: number, cx: number, cy: number, size: number, turn: number, color: string, pupil = "#14100e"): void {
  const s = SHAPES[((index % 10) + 10) % 10]!;
  const k = size / 24;
  const c = Math.cos(turn), sn = Math.sin(turn);
  // The view box's centre lands on (cx, cy); the path turns about its own origin.
  const x = cx - 12 * k * (c - sn), y = cy - 12 * k * (sn + c);
  const at = { scale: k, rotation: turn };
  if (s.fill) draw.path(s.fill, x, y, { ...at, fill: color });
  if (s.stroke) draw.path(s.stroke, x, y, { ...at, stroke: alpha(color, s.strokeAlpha ?? 1), lineWidth: Math.max(1, 2 * k) / k, lineCap: size >= 12 ? "round" : "butt" });
  if (s.pupil) draw.path(s.pupil, x, y, { ...at, fill: pupil });
}
