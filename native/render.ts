// The alchemist's shelf on starhermit:scene, as the browser build's
// js/render.js drew it in its "ambient" mode (the DOM board was the playable
// surface; the 3D scene behind it drew the environment): the plaster wall
// (laid stone with relief at detailed quality), the main and lower shelves
// with their wood grain, the brass trim and corbels, the seeded decor
// (stacked books, the candle with its flickering flame, halo and point
// light, scroll tubes, the potted sprig, two stoppered specimen flasks with
// glowing draughts, six hanging orbs bobbing in the theme's accent), dust
// motes drifting in the candle light, the lights per shelf theme (a warm or
// cool hemisphere fill, the shadow-casting key, the rim light), fog, the
// room-environment reflections and the post effects per graphics level. A
// completed shelf sends bursts of the palette's colours across the shelf
// with a slight camera ease in; a failed one dims the lights.
//
// The camera frames the shelf as the old one did (35°, 18° pitch, fitted to
// a seven-vessel row in the playfield's aspect, wider with the Wide camera
// setting) into the playfield rectangle the HUD leaves (setViewOffset); a
// drag on the playfield outside the vessels pans it a little, clamped and
// sprung back by Recenter (C). The browser build's vessel meshes, markers
// and picking were disabled in its ambient mode and are not built: the
// vessels are board.ts's widgets.
import {
  ACESFilmicToneMapping, AdditiveBlending, BoxGeometry, BufferAttribute, BufferGeometry, CanvasTexture, Color,
  ConeGeometry, CylinderGeometry, DirectionalLight, DoubleSide, Fog, Group, HemisphereLight, InstancedMesh, Material,
  Matrix4, Mesh, MeshLambertMaterial, MeshPhysicalMaterial, MeshStandardMaterial, PMREMGenerator,
  PerspectiveCamera, PlaneGeometry, PointLight, Points, PointsMaterial, RepeatWrapping, RoomEnvironment, SRGBColorSpace,
  SphereGeometry, Sprite, SpriteMaterial, Vector2, renderer, scene, type Texture,
} from "starhermit:scene";
import { OffscreenCanvas } from "starhermit:canvas";
import { decorStream } from "../js/rng.js";
import type { Look } from "./quality.ts";
import { MOTE_CAP, PARTICLE_CAP } from "./quality.ts";
import { themeById, type Theme } from "./style.ts";

const PI = Math.PI;
const CAM = { FOV: 35, PITCH_DEG: 18, LOOK_Y: 0.78, BASE_DIST: 4.4, MARGIN_X: 1.15, MIN_DIST: 4.6, MAX_DIST: 16, WIDE_MULT: 1.18, PAN_CLAMP_X: 1.2, PAN_CLAMP_Y: 0.5, PAN_SCALE: 0.0035 };
const SPACING_X = 1.06;
const ANIM = { CELEB_STAGGER: 0.13, CELEB_PULSE: 0.65, CELEB_ZOOM: 1.2, FAIL_DIM: 0.95, BURST_COUNT: 26 };

const camera = new PerspectiveCamera(CAM.FOV, 16 / 9, 0.1, 60);
renderer.camera = camera;
renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;

let theme: Theme = themeById("ember");
let palette: string[] = [];
let look: Look | null = null;
let reducedMotion = false;
let wide = false;
const rng = decorStream("chromatic-pour-ember");
const fxRng = rng.fork("fx");

// --- lights and shadow box: the browser build's own values (three.js r160 parity at engine minor 28) ---
const hemi = new HemisphereLight(0xffe6c8, 0x2a1a10, 0.9);
const keyLight = new DirectionalLight(0xffd9a8, 2.6);
keyLight.position.set(4, 6.5, 5);
keyLight.target.position.set(0, -0.6, -1.2);
keyLight.shadow.bias = -0.0015;
keyLight.shadow.normalBias = 0.02;
keyLight.shadow.radius = 3;
Object.assign(keyLight.shadow.camera, { left: -7.2, right: 7.2, top: 4.2, bottom: -4.4, near: 3, far: 19 });
keyLight.shadow.camera.updateProjectionMatrix();
const rimLight = new DirectionalLight(0x9fb8ff, 0.9);
rimLight.position.set(-5, 3.5, -4);
scene.add(hemi, keyLight, keyLight.target, rimLight, rimLight.target);
scene.fog = new Fog(0x3a1d12, 12, 30);
const base = { hemi: 0.9, key: 2.6, rim: 0.9 };
let dim = 1;

// --- procedural textures (seeded) ---
function shade(hex: string, amt: number): string {
  const c = new Color(hex);
  if (amt >= 0) c.lerp(new Color(0xffffff), amt); else c.lerp(new Color(0x000000), -amt);
  return "#" + c.getHex().toString(16).padStart(6, "0");
}
function wallTexture(bg: string): Texture {
  const cv = new OffscreenCanvas(64, 256);
  const g = cv.getContext("2d");
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, shade(bg, 0.1));
  grad.addColorStop(0.55, bg);
  grad.addColorStop(1, shade(bg, -0.28));
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 256);
  const tex = new CanvasTexture(cv);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}
function woodTexture(size: number): Texture {
  const r = rng.fork("wood");
  const cv = new OffscreenCanvas(size, size);
  const g = cv.getContext("2d");
  g.scale(size / 256, size / 256);
  g.fillStyle = "#9a7a56";
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 90; i++) {
    const y = r.next() * 256, w = 30 + r.next() * 226, x = r.next() * 256 - 20;
    const dark = r.next() < 0.6;
    g.strokeStyle = dark ? "rgba(70,48,28,0.18)" : "rgba(230,205,170,0.12)";
    g.lineWidth = 0.6 + r.next() * 2.2;
    g.beginPath();
    g.moveTo(x, y);
    g.bezierCurveTo(x + w * 0.3, y + (r.next() - 0.5) * 6, x + w * 0.7, y + (r.next() - 0.5) * 6, x + w, y + (r.next() - 0.5) * 4);
    g.stroke();
  }
  for (let i = 0; i < 4; i++) {
    const y = 32 + i * 64;
    g.strokeStyle = "rgba(50,32,18,0.35)";
    g.lineWidth = 2;
    g.beginPath(); g.moveTo(0, y); g.lineTo(256, y); g.stroke();
  }
  const tex = new CanvasTexture(cv);
  tex.colorSpace = SRGBColorSpace;
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.repeat.set(3, 1);
  return tex;
}
/** The detailed wall: laid stone blocks with mortar, plaster wash and speckle, and the
 * relief as its bump map. */
function stoneTextures(bg: string, size: number): { map: Texture; bump: Texture } {
  const r = rng.fork("stone");
  const W = 512, H = 256, k = size / W;
  const cv = new OffscreenCanvas(size, Math.round(H * k));
  const g = cv.getContext("2d");
  g.scale(k, k);
  const bump = new OffscreenCanvas(cv.width, cv.height);
  const b = bump.getContext("2d");
  b.scale(k, k);
  g.fillStyle = shade(bg, -0.55);
  g.fillRect(0, 0, W, H);
  b.fillStyle = "#202020";
  b.fillRect(0, 0, W, H);
  const rowH = 32;
  for (let row = 0; row < H / rowH; row++) {
    let x = row % 2 ? -r.next() * 40 : -r.next() * 20;
    while (x < W) {
      const w = 56 + r.next() * 60;
      const tone = (r.next() - 0.5) * 0.14 - 0.04;
      g.fillStyle = shade(bg, tone);
      g.fillRect(x + 2, row * rowH + 2, w - 4, rowH - 4);
      const v = 150 + Math.floor(r.next() * 60);
      b.fillStyle = `rgb(${v},${v},${v})`;
      b.fillRect(x + 2, row * rowH + 2, w - 4, rowH - 4);
      g.fillStyle = "rgba(255,230,200,0.035)";
      g.fillRect(x + 2, row * rowH + 2, w - 4, 3);
      x += w;
    }
  }
  for (let i = 0; i < 2200; i++) {
    const x = r.next() * W, y = r.next() * H;
    const a = r.next() * 0.12;
    g.fillStyle = r.next() < 0.5 ? `rgba(0,0,0,${a})` : `rgba(255,235,210,${a * 0.6})`;
    g.fillRect(x, y, 1.5, 1.5);
    b.fillStyle = `rgba(0,0,0,${a * 2})`;
    b.fillRect(x, y, 2, 2);
  }
  const wash = g.createLinearGradient(0, 0, 0, H);
  wash.addColorStop(0, "rgba(0,0,0,0.25)");
  wash.addColorStop(0.45, "rgba(255,220,180,0.04)");
  wash.addColorStop(1, "rgba(0,0,0,0.4)");
  g.fillStyle = wash;
  g.fillRect(0, 0, W, H);
  const map = new CanvasTexture(cv);
  map.colorSpace = SRGBColorSpace;
  const bumpTex = new CanvasTexture(bump);
  for (const t of [map, bumpTex]) { t.wrapS = t.wrapT = RepeatWrapping; t.repeat.set(6, 3); t.anisotropy = size > 512 ? 8 : 4; }
  return { map, bump: bumpTex };
}
function spriteTexture(stops: [number, string][], inner = 0, cy = 16): Texture {
  const c = new OffscreenCanvas(64, 64);
  const g = c.getContext("2d");
  const grd = g.createRadialGradient(32, cy * 2, inner, 32, 32, 30);
  for (const [at, col] of stops) grd.addColorStop(at, col);
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}
const flameTex = spriteTexture([[0, "rgba(255,250,220,1)"], [0.35, "rgba(255,190,90,0.9)"], [0.7, "rgba(255,120,40,0.35)"], [1, "rgba(255,90,20,0)"]], 2, 18);
const dotTex = spriteTexture([[0, "rgba(255,255,255,1)"], [0.35, "rgba(255,255,255,0.75)"], [1, "rgba(255,255,255,0)"]]);

/** A LatheGeometry (the engine has none): the profile turned about y. */
function lathe(points: [number, number][], segments: number): BufferGeometry {
  const n = points.length;
  const pn: [number, number][] = [];
  for (let j = 0; j < n; j++) {
    const prev = points[Math.max(0, j - 1)]!, next = points[Math.min(n - 1, j + 1)]!;
    const dx = next[0] - prev[0], dy = next[1] - prev[1];
    const l = Math.hypot(dx, dy) || 1;
    pn.push([dy / l, -dx / l]);
  }
  const pos: number[] = [], nrm: number[] = [], uv: number[] = [], idx: number[] = [];
  for (let i = 0; i <= segments; i++) {
    const phi = (i / segments) * PI * 2, s = Math.sin(phi), c = Math.cos(phi);
    for (let j = 0; j < n; j++) {
      const [r, y] = points[j]!;
      pos.push(r * s, y, r * c);
      nrm.push(pn[j]![0] * s, pn[j]![1], pn[j]![0] * c);
      uv.push(i / segments, j / (n - 1));
    }
  }
  for (let i = 0; i < segments; i++) {
    for (let j = 0; j < n - 1; j++) {
      const a = i * n + j, b = a + n, c2 = b + 1, d = a + 1;
      idx.push(a, b, d, c2, d, b);
    }
  }
  const geo = new BufferGeometry();
  geo.setAttribute("position", new BufferAttribute(new Float32Array(pos), 3));
  geo.setAttribute("normal", new BufferAttribute(new Float32Array(nrm), 3));
  geo.setAttribute("uv", new BufferAttribute(new Float32Array(uv), 2));
  geo.setIndex(idx);
  return geo;
}

interface LitParams { color?: string | number | Color; map?: Texture | null; roughness?: number; metalness?: number; emissive?: string | number | Color; emissiveIntensity?: number; bumpMap?: Texture | null; bumpScale?: number; clearcoat?: number }
/** Lit material for the level's budget: Lambert on Low, Standard on Balanced, Physical (clearcoat) above where asked. */
function lit(p: LitParams, physical = false): Material {
  const kind = look?.budget.material ?? "standard";
  const baseP = { color: p.color ?? 0xffffff, map: p.map ?? null, ...(p.bumpMap ? { bumpMap: p.bumpMap, bumpScale: p.bumpScale ?? 1 } : {}), ...(p.emissive !== undefined ? { emissive: p.emissive, emissiveIntensity: p.emissiveIntensity ?? 1 } : {}) };
  if (kind === "lambert") return new MeshLambertMaterial(baseP);
  const std = { ...baseP, roughness: p.roughness ?? 1, metalness: p.metalness ?? 0 };
  if (physical && kind === "physical") return new MeshPhysicalMaterial({ ...std, clearcoat: p.clearcoat ?? 0.5, clearcoatRoughness: 0.2 });
  return new MeshStandardMaterial(std);
}

// --- the built shelf ---
let world: Group | null = null;
let builtKey = "";
let woodTex: Texture | null = null;
let woodSize = 0;
let stone: { map: Texture; bump: Texture; size: number; bg: string } | null = null;
let wallTex: Texture | null = null;
let wallBg = "";
let flame: Sprite | null = null;
let halo: Sprite | null = null;
let candleLight: PointLight | null = null;
let flamePhase = 0;
let orbs: InstancedMesh | null = null;
const orbBase: { x: number; y: number; z: number; phase: number; amp: number }[] = [];
const flaskLiquids: MeshStandardMaterial[] = [];
const tmpM = new Matrix4();

function build(): void {
  if (!look) return;
  const warm = theme.ambience !== "cool";
  const key = `${theme.id}|${look.budget.material}|${look.budget.segments}|${look.budget.woodTexture}|${look.budget.stoneTexture}|${look.detailed}|${look.reflections}`;
  if (key === builtKey && world) return;
  builtKey = key;
  if (world) scene.remove(world);
  const g = new Group();
  world = g;
  scene.add(g);
  const seg = (n: number): number => Math.max(6, Math.round(n * look!.budget.segments));
  const detailed = look.detailed;

  // wall
  let wallMat: Material;
  if (detailed) {
    if (!stone || stone.size !== look.budget.stoneTexture || stone.bg !== theme.bg) {
      const t = stoneTextures(theme.bg, look.budget.stoneTexture);
      stone = { ...t, size: look.budget.stoneTexture, bg: theme.bg };
    }
    wallMat = lit({ map: stone.map, bumpMap: stone.bump, bumpScale: 2.2, roughness: 0.9 });
  } else {
    if (!wallTex || wallBg !== theme.bg) { wallTex = wallTexture(theme.bg); wallBg = theme.bg; }
    wallMat = lit({ map: wallTex, roughness: 0.95 });
  }
  envI.set(wallMat, 0.04);
  const wall = new Mesh(new PlaneGeometry(34, 18), wallMat);
  wall.position.set(0, 4.5, -4.5);
  wall.receiveShadow = true;
  g.add(wall);

  // shelves
  if (!woodTex || woodSize !== look.budget.woodTexture) { woodTex = woodTexture(look.budget.woodTexture); woodSize = look.budget.woodTexture; }
  const shelfMat = lit({ map: woodTex, color: theme.shelf, roughness: detailed ? 0.62 : 0.8, metalness: 0.05, bumpMap: detailed ? woodTex : null, bumpScale: 1.4 });
  envI.set(shelfMat, 0.3);
  const shelfGeo = new BoxGeometry(13, 0.28, 2.8);
  const shelfMain = new Mesh(shelfGeo, shelfMat);
  shelfMain.position.set(0, -0.14, 0);
  shelfMain.receiveShadow = true;
  shelfMain.castShadow = true;
  g.add(shelfMain);
  const shelfLow = new Mesh(shelfGeo, shelfMat);
  shelfLow.position.set(0, -2.4, -0.2);
  shelfLow.receiveShadow = true;
  g.add(shelfLow);

  // brass (reflections on: polished metal; off: duller)
  const brass = lit({ color: 0xb08038, metalness: look.reflections ? 1 : 0.35, roughness: look.reflections ? 0.32 : 0.5 });
  envI.set(brass, 0.6);
  if (detailed) {
    const trimGeo = new BoxGeometry(13.02, 0.035, 0.03);
    for (const [y, z] of [[-0.03, 1.4], [-2.29, 1.2]] as const) {
      const trim = new Mesh(trimGeo, brass);
      trim.position.set(0, y, z);
      g.add(trim);
    }
    const corbelGeo = new BoxGeometry(0.12, 0.7, 1.6);
    for (const [x, y, z] of [[-5.6, -0.63, -0.5], [5.6, -0.63, -0.5], [-5.6, -2.89, -0.7], [5.6, -2.89, -0.7]] as const) {
      const c = new Mesh(corbelGeo, shelfMat);
      c.position.set(x, y, z);
      c.castShadow = true;
      c.receiveShadow = true;
      g.add(c);
    }
  }

  // stacked books (instanced)
  const bookRng = rng.fork("books");
  const books = new InstancedMesh(new BoxGeometry(0.55, 0.12, 0.4), lit({ roughness: 0.85 }), 9);
  const col = new Color();
  let bi = 0;
  for (const st of [{ x: -4.6, z: -0.35, n: 5, y: -2.26 }, { x: 4.7, z: -0.3, n: 4, y: -2.26 }]) {
    let y = st.y + 0.06;
    for (let i = 0; i < st.n; i++) {
      tmpM.makeRotationY((bookRng.next() - 0.5) * 0.5);
      tmpM.setPosition(st.x + (bookRng.next() - 0.5) * 0.15, y, st.z + (bookRng.next() - 0.5) * 0.1);
      books.setMatrixAt(bi, tmpM);
      col.setHSL(bookRng.next(), 0.35 + bookRng.next() * 0.25, 0.3 + bookRng.next() * 0.2);
      books.setColorAt(bi, col);
      y += 0.125;
      bi++;
    }
  }
  books.instanceMatrix.needsUpdate = true;
  books.receiveShadow = true;
  books.castShadow = true;
  g.add(books);

  // candle with its flame, halo and light (main shelf, right end)
  const candleRng = rng.fork("candle");
  flamePhase = candleRng.next() * 100;
  const candle = new Mesh(new CylinderGeometry(0.09, 0.115, 0.5, seg(14)),
    lit({ color: 0xf2e6c8, roughness: 0.55, emissive: 0xff9a40, emissiveIntensity: 0.05 }));
  candle.position.set(4.5, 0.25, -0.75);
  candle.castShadow = true;
  g.add(candle);
  const dish = new Mesh(new CylinderGeometry(0.2, 0.15, 0.04, seg(20)), brass);
  dish.position.set(4.5, 0.02, -0.75);
  dish.castShadow = true;
  dish.receiveShadow = true;
  g.add(dish);
  halo = new Sprite(new SpriteMaterial({ map: dotTex, color: warm ? 0xffa050 : 0xffc890, transparent: true, opacity: 0.35, depthWrite: false, blending: AdditiveBlending }));
  halo.position.set(4.5, 0.64, -0.74);
  halo.scale.set(0.9, 0.9, 1);
  g.add(halo);
  flame = new Sprite(new SpriteMaterial({ map: flameTex, transparent: true, depthWrite: false, blending: AdditiveBlending }));
  flame.position.set(4.5, 0.62, -0.75);
  flame.scale.set(0.16, 0.24, 1);
  g.add(flame);
  candleLight = new PointLight(warm ? 0xffb060 : 0xffc890, 5, 5, 2);
  candleLight.position.set(4.5, 0.75, -0.6);
  g.add(candleLight);

  // scroll tubes on the lower shelf
  const scrollRng = rng.fork("scrolls");
  const scrollMat = lit({ color: 0xd9c49a, roughness: 0.9 });
  const scrollGeo = new CylinderGeometry(0.07, 0.07, 0.9, seg(12));
  for (let i = 0; i < 3; i++) {
    const sc = new Mesh(scrollGeo, scrollMat);
    sc.castShadow = true;
    sc.receiveShadow = true;
    sc.rotation.z = PI / 2;
    sc.rotation.y = (scrollRng.next() - 0.5) * 0.4;
    sc.position.set(1.4 + i * 0.5, -2.26 + 0.07 + (i === 2 ? 0.13 : 0), -0.45 + scrollRng.next() * 0.2);
    g.add(sc);
  }

  // potted sprig (lower shelf, left)
  const pot = new Mesh(new CylinderGeometry(0.16, 0.12, 0.22, seg(12)), lit({ color: 0xa85f3c, roughness: 0.85 }));
  pot.position.set(-2.2, -2.26 + 0.11, -0.35);
  pot.castShadow = true;
  g.add(pot);
  const leafMat = lit({ color: 0x4d7a3a, roughness: 0.7 });
  const leafGeo = new ConeGeometry(0.05, 0.42, 6);
  for (let i = 0; i < 3; i++) {
    const leaf = new Mesh(leafGeo, leafMat);
    leaf.position.set(-2.2 + (i - 1) * 0.06, -2.26 + 0.4, -0.35 + (i % 2) * 0.05);
    leaf.rotation.z = (i - 1) * 0.45;
    g.add(leaf);
  }

  // two stoppered specimen flasks (detailed): clear glass over a glowing draught
  flaskLiquids.length = 0;
  if (detailed) {
    const flaskRng = rng.fork("flasks");
    const glass = look.budget.material === "lambert"
      ? new MeshLambertMaterial({ color: 0xffffff, transparent: true, opacity: 0.3, side: DoubleSide, depthWrite: false })
      : new MeshStandardMaterial({ color: 0xffffff, roughness: 0.05, metalness: 0, transparent: true, opacity: 0.3, side: DoubleSide, depthWrite: false });
    envI.set(glass, 0.9);
    const pts: [number, number][] = [];
    for (let i = 0; i <= 10; i++) {
      const a = -PI / 2 + (i / 10) * PI * 0.85;
      pts.push([Math.max(0.001, 0.26 * Math.cos(a)), 0.26 + 0.26 * Math.sin(a)]);
    }
    pts.push([0.07, 0.62], [0.07, 0.78], [0.085, 0.8]);
    const flaskGeo = lathe(pts, seg(24));
    const draughtGeo = new SphereGeometry(0.23, seg(20), seg(12), 0, PI * 2, PI * 0.42, PI * 0.58);
    const corkMat = lit({ color: 0x8a6440, roughness: 0.95 });
    for (const [x, z] of [[-3.7, -0.2], [3.2, -0.45]] as const) {
      const hue = flaskRng.next();
      const liquid = new MeshStandardMaterial({ color: new Color().setHSL(hue, 0.7, 0.45), emissive: new Color().setHSL(hue, 0.8, 0.4), emissiveIntensity: 0.6, roughness: 0.2 });
      const flask = new Group();
      const draught = new Mesh(draughtGeo, liquid);
      draught.position.y = 0.26;
      const glassM = new Mesh(flaskGeo, glass);
      glassM.castShadow = true;
      const cork = new Mesh(new CylinderGeometry(0.075, 0.06, 0.1, seg(12)), corkMat);
      cork.position.y = 0.82;
      flask.add(draught, glassM, cork);
      flask.position.set(x, -2.26, z);
      flask.scale.setScalar(0.9 + flaskRng.next() * 0.3);
      g.add(flask);
      flaskLiquids.push(liquid);
    }
  }

  // hanging orbs in the accent (instanced, gentle seeded bob)
  const orbRng = rng.fork("orbs");
  orbBase.length = 0;
  orbs = new InstancedMesh(new SphereGeometry(0.09, seg(12), seg(10)),
    lit({ color: 0x2a2438, emissive: theme.accent, emissiveIntensity: 2.4, roughness: 0.4 }), 6);
  for (let i = 0; i < 6; i++) {
    orbBase.push({ x: -3 + i * 1.2 + (orbRng.next() - 0.5) * 0.4, y: 2.9 + orbRng.next() * 0.5, z: -2.2 - orbRng.next() * 0.5, phase: orbRng.next() * PI * 2, amp: 0.05 + orbRng.next() * 0.05 });
  }
  orbs.castShadow = true;
  g.add(orbs);
  placeOrbs(0);

  applyThemeLights();
  applyEnv();
}

/** The browser build (three.js r160) scaled scene.environment per material by envMapIntensity
 * (wall 0.04, shelves 0.3, brass 0.6, glass 0.9, other props 0.15); from engine minor 20 the
 * scene's environment ignores that, so each standard material takes the room as its own envMap. */
const envI = new WeakMap<Material, number>();
function applyEnv(): void {
  scene.environment = null;
  const on = !!look?.reflections && !!envTex;
  world?.traverse((o) => {
    const m = (o as Mesh).material as Material | Material[] | undefined;
    if (!m) return;
    for (const mat of Array.isArray(m) ? m : [m]) {
      if (!(mat instanceof MeshStandardMaterial)) continue;
      mat.envMap = on ? envTex : null;
      mat.envMapIntensity = envI.get(mat) ?? 0.15;
    }
  });
}

function applyThemeLights(): void {
  const w = theme.ambience !== "cool";
  scene.background = new Color(theme.bg);
  (scene.fog as Fog).color.set(theme.fog);
  keyLight.color.set(w ? 0xffd9a8 : 0xdceaff);
  rimLight.color.set(w ? 0x9fb8ff : 0xffe9c8);
  hemi.color.set(w ? 0xffe6c8 : 0xdde8ff);
  hemi.groundColor.set(w ? 0x2a1a10 : 0x101820);
  moteMat.color.set(w ? 0xffc890 : 0xcfe4ff);
}

// --- dust motes in the candle light ---
const motePos = new Float32Array(MOTE_CAP * 3);
const moteSeed = new Float32Array(MOTE_CAP * 4);
{
  const mr = rng.fork("motes");
  for (let i = 0; i < MOTE_CAP; i++) {
    moteSeed[i * 4] = (mr.next() * 2 - 1) * 5.5;
    moteSeed[i * 4 + 1] = -2.2 + mr.next() * 5.2;
    moteSeed[i * 4 + 2] = -3.6 + mr.next() * 4.4;
    moteSeed[i * 4 + 3] = mr.next() * 1000;
  }
}
const moteGeo = new BufferGeometry();
const moteAttr = new BufferAttribute(motePos, 3);
moteGeo.setAttribute("position", moteAttr);
const moteMat = new PointsMaterial({ size: 0.05, map: dotTex, color: 0xffc890, transparent: true, opacity: 0.55, depthWrite: false, blending: AdditiveBlending, sizeAttenuation: true });
const motes = new Points(moteGeo, moteMat);
motes.frustumCulled = false;
scene.add(motes);
function updateMotes(tS: number): void {
  const n = look?.budget.motes ?? 0;
  for (let i = 0; i < n; i++) {
    const ph = moteSeed[i * 4 + 3]!;
    const rise = (tS * 0.06 + ph * 0.37) % 5.2;
    motePos[i * 3] = moteSeed[i * 4]! + Math.sin(tS * 0.3 + ph) * 0.35;
    motePos[i * 3 + 1] = -2.2 + ((moteSeed[i * 4 + 1]! + 2.2 + rise) % 5.2);
    motePos[i * 3 + 2] = moteSeed[i * 4 + 2]! + Math.cos(tS * 0.23 + ph) * 0.25;
  }
  moteAttr.needsUpdate = true;
}

// --- pooled celebration particles ---
const pPos = new Float32Array(PARTICLE_CAP * 3);
const pCol = new Float32Array(PARTICLE_CAP * 3);
const pVel = new Float32Array(PARTICLE_CAP * 3);
const pLife = new Float32Array(PARTICLE_CAP);
const pGrav = new Float32Array(PARTICLE_CAP);
for (let i = 0; i < PARTICLE_CAP; i++) pPos[i * 3 + 1] = -999;
const pGeo = new BufferGeometry();
const pPosAttr = new BufferAttribute(pPos, 3);
const pColAttr = new BufferAttribute(pCol, 3);
pGeo.setAttribute("position", pPosAttr);
pGeo.setAttribute("color", pColAttr);
const sparks = new Points(pGeo, new PointsMaterial({ size: 0.09, map: dotTex, vertexColors: true, transparent: true, opacity: 0.95, depthWrite: false, blending: AdditiveBlending, sizeAttenuation: true }));
sparks.frustumCulled = false;
scene.add(sparks);
let pCursor = 0;
let pAlive = 0;
const tmpColor = new Color();
function spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, color: string, grav: number): void {
  if (pAlive >= (look?.budget.particles ?? 0)) return;
  const i = pCursor;
  pCursor = (pCursor + 1) % PARTICLE_CAP;
  pPos[i * 3] = x; pPos[i * 3 + 1] = y; pPos[i * 3 + 2] = z;
  pVel[i * 3] = vx; pVel[i * 3 + 1] = vy; pVel[i * 3 + 2] = vz;
  pLife[i] = life; pGrav[i] = grav;
  tmpColor.set(color);
  pCol[i * 3] = tmpColor.r; pCol[i * 3 + 1] = tmpColor.g; pCol[i * 3 + 2] = tmpColor.b;
  pAlive++;
  pColAttr.needsUpdate = true;
}
function burst(x: number, y: number, z: number, color: string, count: number, speed: number, upBias: number, grav: number): void {
  for (let n = 0; n < count; n++) {
    const a = fxRng.next() * PI * 2;
    const r = fxRng.next() * speed;
    spawn(x, y, z, Math.cos(a) * r, upBias + fxRng.next() * speed, Math.sin(a) * r * 0.6, 0.5 + fxRng.next() * 0.6, color, grav);
  }
}
function updateParticles(dt: number): void {
  if (pAlive === 0) return;
  let alive = 0;
  for (let i = 0; i < PARTICLE_CAP; i++) {
    if (pLife[i]! <= 0) continue;
    pLife[i]! -= dt;
    if (pLife[i]! <= 0) { pPos[i * 3 + 1] = -999; continue; }
    pVel[i * 3 + 1]! -= pGrav[i]! * dt;
    pPos[i * 3]! += pVel[i * 3]! * dt;
    pPos[i * 3 + 1]! += pVel[i * 3 + 1]! * dt;
    pPos[i * 3 + 2]! += pVel[i * 3 + 2]! * dt;
    alive++;
  }
  pAlive = alive;
  pPosAttr.needsUpdate = true;
}

// --- events ---
interface Job { t: number; kind: "celebrate" | "fail"; spots: { x: number; y: number; z: number }[]; fired: number }
let job: Job | null = null;
let zoom = 1;
/** A completed shelf: bursts of the palette's colours across the shelf and the camera's ease in (js/render.js makeAmbientCelebrationJob). */
export function celebrate(): void {
  if (reducedMotion) return;
  const spots = [];
  for (let i = 0; i < 6; i++) spots.push({ x: (fxRng.next() * 2 - 1) * 3.2, y: 1.2 + fxRng.next() * 1.6, z: -0.5 + fxRng.next() });
  job = { t: 0, kind: "celebrate", spots, fired: 0 };
}
/** A failed shelf: the lights dim and come back (makeFailJob). */
export function fail(): void {
  if (reducedMotion) return;
  job = { t: 0, kind: "fail", spots: [], fired: 0 };
}
/** Skip: settle whatever plays. */
export function settle(): void { job = null; zoom = 1; dim = 1; }
function stepJob(dt: number): void {
  const j = job;
  if (!j) return;
  j.t += dt;
  if (j.kind === "celebrate") {
    while (j.fired < j.spots.length && j.t >= j.fired * ANIM.CELEB_STAGGER) {
      const s = j.spots[j.fired]!;
      const color = palette.length ? palette[j.fired % palette.length]! : theme.accent;
      burst(s.x, s.y, s.z, color, ANIM.BURST_COUNT, 0.5, 1.3, 0.9);
      j.fired++;
    }
    const k = Math.min(1, j.t / ANIM.CELEB_ZOOM);
    const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
    zoom = e < 0.5 ? 1 - 0.06 * (e * 2) : 0.94 + 0.06 * ((e - 0.5) * 2);
    if (j.t >= Math.max(ANIM.CELEB_ZOOM, j.spots.length * ANIM.CELEB_STAGGER + ANIM.CELEB_PULSE + 0.25)) { job = null; zoom = 1; }
  } else {
    const k = Math.min(1, j.t / ANIM.FAIL_DIM);
    const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
    dim = e < 0.4 ? 1 - 0.45 * (e / 0.4) : 0.55 + 0.45 * ((e - 0.4) / 0.6);
    if (k >= 1) { job = null; dim = 1; }
  }
}

// --- theme, look, settings ---
/** The shelf theme and the palette's colours (bursts). */
export function setTheme(themeId: string, colors: string[]): void {
  palette = colors.slice();
  const next = themeById(themeId);
  if (next.id === theme.id && world) return;
  theme = next;
  build();
}
let envTex: Texture | null = null;
/** The look for the frame's graphics level; cheap when nothing changed. */
export function applyLook(next: Look): void {
  if (look && JSON.stringify(look) === JSON.stringify(next)) return;
  look = next;
  const shadows = next.shadows > 0;
  renderer.shadowMap.enabled = shadows;
  keyLight.castShadow = shadows;
  if (shadows) keyLight.shadow.mapSize = next.shadows;
  if (next.reflections) {
    if (!envTex) {
      try { envTex = new PMREMGenerator(renderer).fromScene(new RoomEnvironment(renderer), 0.04).texture; }
      catch (e) { console.warn("environment:", e instanceof Error ? e.message : String(e)); }
    }
  }
  applyEnv();
  motes.visible = next.budget.motes > 0;
  moteGeo.setDrawRange(0, next.budget.motes);
  renderer.ao = next.ao === "off" ? null : {
    blendIntensity: 0.75, radius: 0.45, distanceExponent: 1.4, thickness: 1.2, scale: 1.0,
    samples: next.ao === "high" ? 16 : 8,
    denoise: { lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: next.ao === "high" ? 6 : 4, rings: 2, samples: next.ao === "high" ? 16 : 8, radiusExponent: 2 },
  };
  // High threshold: only the flame, orbs and glowing draughts bloom.
  renderer.bloom = next.bloom ? { strength: 0.6, radius: 0.45, threshold: 0.9, resolution: 0.5 } : null;
  // The browser build's grade pass: a gentle S-curve (0.22), saturation 1.1,
  // cool shadows / warm highlights, the 0.3 vignette.
  renderer.grade = next.grade ? {
    space: "display", contrast: 0.11, saturation: 1.1,
    shadows: [0.95, 0.98, 1.06], highlights: [1.05, 1.0, 0.94], split: [0.15, 0.75],
    vignette: { amount: 0.3, inner: 0.3, outer: 0.85 },
  } : null;
  renderer.antialias = next.antialias;
  build();
}
export function setReducedMotion(on: boolean): void {
  reducedMotion = on;
  if (on) { zoom = 1; job = job && job.kind === "celebrate" ? null : job; }
}
export function setWide(on: boolean): void { if (wide !== on) { wide = on; frameCamera(); } }

// --- framing ---
let view = { x: 0, y: 0, w: 1, h: 1, W: 1, H: 1 };
let dist = CAM.MIN_DIST;
/** The playfield (window pixels) the shelf is framed into, within the W × H window. */
export function setPlayfield(x: number, y: number, w: number, h: number, W: number, H: number): void {
  const next = { x, y, w: Math.max(1, w), h: Math.max(1, h), W: Math.max(1, W), H: Math.max(1, H) };
  if (Object.entries(next).every(([k, v]) => Math.abs(v - (view as Record<string, number>)[k]!) < 0.5)) return;
  view = next;
  // The browser build's canvas was the playfield: its aspect is the camera's (from minor 20 the
  // engine keeps the camera's own aspect, so it is set here, not taken from the window).
  camera.aspect = view.w / view.h;
  camera.setViewOffset(view.w, view.h, -view.x, -view.y, view.W, view.H);
  camera.updateProjectionMatrix();
  frameCamera();
}
/** js/render.js frameCamera in its ambient mode: a seven-vessel row fitted to the playfield's aspect, 12 % farther. */
function frameCamera(): void {
  const aspect = Math.max(0.3, view.w / Math.max(1, view.h));
  const halfW = (7 * SPACING_X) / 2 + CAM.MARGIN_X;
  const t = Math.tan(((CAM.FOV / 2) * PI) / 180);
  let d = Math.max(CAM.BASE_DIST, 2.0 / t, halfW / (t * aspect));
  d = Math.min(CAM.MAX_DIST, Math.max(CAM.MIN_DIST, d));
  if (wide) d *= CAM.WIDE_MULT;
  dist = Math.min(CAM.MAX_DIST, Math.max(CAM.MIN_DIST, d * 1.12));
}

// --- the playfield drag: a subtle, clamped pan (js/render.js onPointerMove) ---
const pan = { x: 0, y: 0, tx: 0, ty: 0, vx: 0, vy: 0 };
/** A drag on the playfield by (dx, dy) logical pixels. */
export function dragPan(dx: number, dy: number): void {
  pan.tx = Math.max(-CAM.PAN_CLAMP_X, Math.min(CAM.PAN_CLAMP_X, pan.tx - dx * CAM.PAN_SCALE));
  pan.ty = Math.max(-CAM.PAN_CLAMP_Y, Math.min(CAM.PAN_CLAMP_Y, pan.ty + dy * CAM.PAN_SCALE * 0.6));
}
/** Recenter (C): the pan springs back. */
export function recenter(): void { pan.tx = 0; pan.ty = 0; }

function placeOrbs(a: number): void {
  if (!orbs) return;
  for (let i = 0; i < orbBase.length; i++) {
    const o = orbBase[i]!;
    tmpM.makeTranslation(o.x, o.y + Math.sin(a * 0.0009 + o.phase) * o.amp, o.z);
    orbs.setMatrixAt(i, tmpM);
  }
  orbs.instanceMatrix.needsUpdate = true;
}

let ambMs = 0;
const pitch = (CAM.PITCH_DEG * PI) / 180;
const look3 = new Vector2();
/** Each frame: the job, sparks, the candle's flicker, orbs, motes and draughts (frozen with reduced motion), the dim and the camera. */
export function update(dtIn: number): void {
  const dt = Math.min(0.1, Math.max(0, dtIn));
  if (!reducedMotion) ambMs += dt * 1000;
  stepJob(dt);
  updateParticles(dt);
  const a = ambMs;
  if (flame) {
    const f = 1 + 0.13 * Math.sin(a * 0.013 + flamePhase) + 0.08 * Math.sin(a * 0.0073 + flamePhase * 2);
    flame.scale.set(0.16 * f, 0.24 * (2 - f) * 0.5 + 0.12, 1);
    flame.material.opacity = 0.75 + 0.2 * Math.sin(a * 0.011 + flamePhase);
    const flick = 0.9 + 0.15 * Math.sin(a * 0.012 + flamePhase);
    if (candleLight) candleLight.intensity = 5 * flick * dim;
    if (halo) halo.material.opacity = 0.3 * flick * dim;
  }
  if (!reducedMotion) {
    placeOrbs(a);
    if (motes.visible) updateMotes(a / 1000);
    for (let i = 0; i < flaskLiquids.length; i++) flaskLiquids[i]!.emissiveIntensity = 0.55 + 0.15 * Math.sin(a * 0.0015 + i * 2.1);
  }
  hemi.intensity = base.hemi * dim;
  keyLight.intensity = base.key * dim;
  rimLight.intensity = base.rim * dim;
  // the pan's spring (ω 8, critically damped)
  const k = Math.min(dt, 0.05);
  for (let s = 0; s < 2; s++) {
    const h = k / 2;
    pan.vx += (64 * (pan.tx - pan.x) - 16 * pan.vx) * h; pan.x += pan.vx * h;
    pan.vy += (64 * (pan.ty - pan.y) - 16 * pan.vy) * h; pan.y += pan.vy * h;
  }
  const d = dist * zoom;
  camera.position.set(pan.x, CAM.LOOK_Y + d * Math.sin(pitch) + pan.y, d * Math.cos(pitch));
  look3.set(pan.x * 0.6, CAM.LOOK_Y + pan.y * 0.5);
  camera.lookAt(look3.x, look3.y, 0);
}
