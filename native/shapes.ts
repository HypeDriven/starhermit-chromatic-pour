// The ten liquid shapes (colour index mod 10: drop, flame, leaf, star, moon,
// wave, gem, spiral, eye, rune) that the browser build stamped on every
// layer from an inline SVG sprite (js/ui.js buildShapeSprite, a 24 × 24 view
// box), so a colour is never the only channel. The SVG paths are parsed and
// their curves and arcs sampled once into polygons (filled shapes) and
// polylines (stroked shapes, 2 units wide with round caps), then drawn with
// starhermit:draw at any size, position and turn.
import * as draw from "starhermit:draw";

type Pt = [number, number];
interface Shape { fills: Pt[][]; strokes: { pts: Pt[]; alpha: number }[]; dots: { x: number; y: number; r: number; pupil: boolean }[] }

/** SVG path data → subpaths of sampled points (absolute and relative M L H V C S Q A Z). */
function parsePath(d: string): Pt[][] {
  const toks = d.match(/[a-zA-Z]|-?(?:\d*\.\d+|\d+)(?:e-?\d+)?/g) ?? [];
  const out: Pt[][] = [];
  let cur: Pt[] = [];
  let x = 0, y = 0, sx = 0, sy = 0, lc: Pt | null = null;
  let i = 0, cmd = "";
  const num = (): number => Number(toks[i++]);
  const isNum = (): boolean => i < toks.length && !/[a-zA-Z]/.test(toks[i]!);
  const cubic = (c1: Pt, c2: Pt, p: Pt): void => {
    const p0: Pt = [x, y];
    for (let k = 1; k <= 12; k++) {
      const t = k / 12, u = 1 - t;
      cur.push([u * u * u * p0[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * p[0],
        u * u * u * p0[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * p[1]]);
    }
    lc = c2; x = p[0]; y = p[1];
  };
  const arc = (rx: number, ry: number, rot: number, large: number, sweep: number, px: number, py: number): void => {
    // endpoint → centre parameterization (SVG implementation notes F.6.5)
    const phi = (rot * Math.PI) / 180, cs = Math.cos(phi), sn = Math.sin(phi);
    const dx = (x - px) / 2, dy = (y - py) / 2;
    const x1 = cs * dx + sn * dy, y1 = -sn * dx + cs * dy;
    rx = Math.abs(rx); ry = Math.abs(ry);
    const lam = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
    if (lam > 1) { rx *= Math.sqrt(lam); ry *= Math.sqrt(lam); }
    const num2 = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
    const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
    let co = Math.sqrt(Math.max(0, num2 / den));
    if (large === sweep) co = -co;
    const cx1 = (co * rx * y1) / ry, cy1 = (-co * ry * x1) / rx;
    const cx = cs * cx1 - sn * cy1 + (x + px) / 2, cy = sn * cx1 + cs * cy1 + (y + py) / 2;
    const ang = (ux: number, uy: number, vx: number, vy: number): number => {
      const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
      return a;
    };
    const t1 = ang(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
    let dt = ang((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
    if (!sweep && dt > 0) dt -= 2 * Math.PI;
    if (sweep && dt < 0) dt += 2 * Math.PI;
    const n = Math.max(6, Math.ceil(Math.abs(dt) / (Math.PI / 12)));
    for (let k = 1; k <= n; k++) {
      const t = t1 + (dt * k) / n;
      const ex = rx * Math.cos(t), ey = ry * Math.sin(t);
      cur.push([cs * ex - sn * ey + cx, sn * ex + cs * ey + cy]);
    }
    x = px; y = py; lc = null;
  };
  while (i < toks.length) {
    if (!isNum()) cmd = toks[i++]!;
    const rel = cmd === cmd.toLowerCase();
    const ox = rel ? x : 0, oy = rel ? y : 0;
    switch (cmd.toUpperCase()) {
      case "M": {
        if (cur.length) out.push(cur);
        x = num() + ox; y = num() + oy; sx = x; sy = y;
        cur = [[x, y]];
        cmd = rel ? "l" : "L";
        lc = null;
        break;
      }
      case "L": x = num() + ox; y = num() + oy; cur.push([x, y]); lc = null; break;
      case "H": x = num() + ox; cur.push([x, y]); lc = null; break;
      case "V": y = num() + oy; cur.push([x, y]); lc = null; break;
      case "C": { const c1: Pt = [num() + ox, num() + oy], c2: Pt = [num() + ox, num() + oy], p: Pt = [num() + ox, num() + oy]; cubic(c1, c2, p); break; }
      case "S": {
        const c1: Pt = lc ? [2 * x - lc[0], 2 * y - lc[1]] : [x, y];
        const c2: Pt = [num() + ox, num() + oy], p: Pt = [num() + ox, num() + oy];
        cubic(c1, c2, p);
        break;
      }
      case "Q": {
        const c: Pt = [num() + ox, num() + oy], p: Pt = [num() + ox, num() + oy];
        cubic([x + (2 / 3) * (c[0] - x), y + (2 / 3) * (c[1] - y)], [p[0] + (2 / 3) * (c[0] - p[0]), p[1] + (2 / 3) * (c[1] - p[1])], p);
        break;
      }
      case "A": { const rx = num(), ry = num(), rot = num(), la = num(), sw = num(); arc(rx, ry, rot, la, sw, num() + ox, num() + oy); break; }
      case "Z": x = sx; y = sy; if (cur.length) out.push(cur); cur = []; lc = null; break;
      default: i++; break;
    }
  }
  if (cur.length) out.push(cur);
  return out;
}

const fill = (d: string): Pt[][] => parsePath(d).filter((p) => p.length >= 3);
const stroke = (d: string, alpha = 1): Shape["strokes"] => parsePath(d).map((pts) => ({ pts, alpha }));
const SHAPES: Shape[] = [
  { fills: fill("M12 3C12 3 5 12 5 16a7 7 0 0 0 14 0C19 12 12 3 12 3Z"), strokes: [], dots: [] }, // drop
  { fills: fill("M12 2c2 5 6 7 6 12a6 6 0 0 1-12 0C6 9 10 7 12 2Z"), strokes: [], dots: [] }, // flame
  { fills: fill("M4 20C4 10 10 4 20 4c0 10-6 16-16 16Z"), strokes: stroke("M4 20C9 15 13 11 18 6"), dots: [] }, // leaf
  { fills: fill("M12 2l2.5 7H22l-6 4.5L18 21l-6-4.5L6 21l2-7.5L2 9h7.5Z"), strokes: [], dots: [] }, // star
  { fills: fill("M20 14A8 8 0 1 1 10 4a6.5 6.5 0 0 0 10 10Z"), strokes: [], dots: [] }, // moon
  { fills: [], strokes: stroke("M2 12c3-4 5 4 8 0s5 4 8 0"), dots: [] }, // wave
  { fills: fill("M12 2l8 7-8 13L4 9Z"), strokes: stroke("M4 9h16M12 2v20", 0.5), dots: [] }, // gem
  { fills: [], strokes: stroke("M12 4a8 8 0 1 0 8 8 6 6 0 1 1-6-6 4 4 0 1 0 4 4"), dots: [] }, // spiral
  { fills: fill("M2 12c4-7 16-7 20 0-4 7-16 7-20 0Z"), strokes: [], dots: [{ x: 12, y: 12, r: 3, pupil: true }] }, // eye
  { fills: [], strokes: stroke("M12 2v20M6 6l6 4 6-4M6 18l6-4 6 4"), dots: [] }, // rune
];
const DISC: Pt[] = Array.from({ length: 12 }, (_, k) => [Math.cos((k / 12) * Math.PI * 2), Math.sin((k / 12) * Math.PI * 2)] as Pt);

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
  const tf = (p: Pt): Pt => { const px = (p[0] - 12) * k, py = (p[1] - 12) * k; return [cx + px * c - py * sn, cy + px * sn + py * c]; };
  for (const f of s.fills) draw.polygon(f.map(tf), color);
  const w = Math.max(1, 2 * k);
  for (const st of s.strokes) {
    const col = alpha(color, st.alpha);
    for (let i = 1; i < st.pts.length; i++) {
      const a = tf(st.pts[i - 1]!), b = tf(st.pts[i]!);
      draw.line(a[0], a[1], b[0], b[1], col, w);
    }
    if (size >= 12) {
      for (const p of [st.pts[0]!, st.pts[st.pts.length - 1]!]) {
        const [x, y] = tf(p);
        draw.polygon(DISC.map((q) => [x + q[0] * w / 2, y + q[1] * w / 2] as Pt), col);
      }
    }
  }
  for (const d of s.dots) {
    const [x, y] = tf([d.x, d.y]);
    draw.polygon(DISC.map((q) => [x + q[0] * d.r * k, y + q[1] * d.r * k] as Pt), d.pupil ? pupil : color);
  }
}
