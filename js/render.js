// render.js — Three.js presentation layer for Chromatic Pour (browser only).
//
// An alchemist's glass shelf with glowing liquids. Consumes immutable rules
// snapshots plus event lists; owns scene graph, camera, lighting, VFX,
// picking, quality tiers and all gameplay-adjacent animation. No external
// assets: every texture/geometry is procedural and decor is seeded.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { decorStream } from './rng.js';
import {
  resolve as resolveGraphics, describe as describeGraphics, pixelRatio as gfxPixelRatio,
  SHADOW_MAP, PARTICLE_BUDGET, MOTE_COUNT,
} from './gfx.js';

// ---------------------------------------------------------------------------
// Framing / layout constants (authored; no magic inline offsets elsewhere)
// ---------------------------------------------------------------------------

const CAM = {
  FOV: 35,               // low-distortion perspective
  PITCH_DEG: 18,         // slight top-down angle
  LOOK_Y: 0.78,          // look-at height on the shelf
  BASE_DIST: 4.4,        // minimum authored distance
  MARGIN_X: 1.15,        // horizontal breathing room beside outer vessels
  MIN_DIST: 4.6,
  MAX_DIST: 16,
  TWO_ROW_EXTRA: 0.9,    // extra margin when a back row exists
  WIDE_MULT: 1.18,       // settings.cameraWide multiplier
  TRANSITION_MS: 600,    // authored camera move duration (easeInOutCubic)
  PAN_CLAMP_X: 1.2,      // subtle one-finger drag pan bounds
  PAN_CLAMP_Y: 0.5,
  PAN_SCALE: 0.0035,
};

const LAYOUT = {
  SPACING_X: 1.06,       // vessel spacing within a row
  ROW_GAP_Z: 1.25,       // front/back row separation
  MAX_PER_ROW: 7,
};

// Vessel proportions (capacity is read from state; layer height derived).
const VESSEL = {
  GLASS_R: 0.34,
  GLASS_H: 1.55,
  LIP_FLARE: 0.05,
  INNER_R: 0.27,
  INNER_BOTTOM: 0.18,
  INNER_TOP: 1.37,
  LIFT: 0.35,            // selection lift height
  HOVER_Y: 2.15,         // pour hover height above the shelf
  TILT_DEG: 100,         // pour tilt
  PROXY_R: 0.56,         // invisible hit-proxy radius
  PROXY_H: 2.0,
};

// Animation timings (ms). Event-tiered hierarchy: ack < pour < pulse < win.
const ANIM = {
  LIFT: 240,
  TILT: 200,
  PER_LAYER: 230,
  UNTILT: 170,
  RETURN: 280,
  INVALID_MS: 420,
  INVALID_AMP: 0.05,     // ~3px at typical framing; never moves hit proxies
  CELEB_STAGGER: 130,
  CELEB_PULSE: 650,
  CELEB_ZOOM_MS: 1200,
  FAIL_DIM_MS: 950,
  GLINT_COUNT: 4,
  BURST_COUNT: 26,
};

const PARTICLE_MAX = 500;      // hard pool cap (desktop); tier budget may be lower
const MOTE_MAX = 60;           // drifting dust motes in the candle light
const ADAPT = { FRAMES: 90, SLOW_MS: 26, FAST_MS: 14, DOWN: 0.1, UP: 0.05, MIN: 0.6 };

// Colour grade + vignette, applied after OutputPass (display-space in and out).
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, uAmount: { value: 1.0 }, uVignette: { value: 0.3 } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uAmount; uniform float uVignette;
    varying vec2 vUv;
    void main() {
      vec4 src = texture2D(tDiffuse, vUv);
      vec3 c = clamp(src.rgb, 0.0, 1.0);
      // Gentle S-curve, a touch more saturation, warm highlights / cool shadows.
      vec3 s = mix(c, c * c * (3.0 - 2.0 * c), 0.22);
      float l = dot(s, vec3(0.299, 0.587, 0.114));
      s = mix(vec3(l), s, 1.1);
      s *= mix(vec3(0.95, 0.98, 1.06), vec3(1.05, 1.0, 0.94), smoothstep(0.15, 0.75, l));
      c = mix(c, s, uAmount);
      float d = length((vUv - 0.5) * vec2(1.15, 1.0));
      c *= 1.0 - uVignette * smoothstep(0.3, 0.85, d);
      gl_FragColor = vec4(c, src.a);
    }`,
};
const TAP_DIST_PX = 8;
const TAP_TIME_MS = 300;
const MAX_DT_MS = 100;

// ---------------------------------------------------------------------------
// Small math / tween / spring helpers
// ---------------------------------------------------------------------------

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function easeInOutCubic(k) { return k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2; }
function easeOutCubic(k) { return 1 - Math.pow(1 - k, 3); }

// Authored-duration tween; interruptible via handle.cancel(jumpToEnd).
function makeTween(dur, update, done, ease = easeInOutCubic) {
  return { t: 0, dur: Math.max(1, dur), update, done, ease, dead: false,
    cancel(jump = true) { if (this.dead) return; this.dead = true;
      if (jump) { try { this.update(this.ease(1)); } catch (_) { /* settle best-effort */ } }
      if (this.done) this.done(); } };
}

// Critically damped spring state {x, v, target}; stepped with clamped dt.
function springStep(s, omega, dtS) {
  const a = omega * omega * (s.target - s.x) - 2 * omega * s.v;
  s.v += a * dtS;
  s.x += s.v * dtS;
}

// ---------------------------------------------------------------------------
// Procedural canvas textures (original, seeded — no disk assets)
// ---------------------------------------------------------------------------

function shade(hex, amt) { // amt -1..1, returns css rgb string
  const c = new THREE.Color(hex);
  if (amt >= 0) c.lerp(new THREE.Color(0xffffff), amt);
  else c.lerp(new THREE.Color(0x000000), -amt);
  return `#${c.getHexString()}`;
}

function makeWallTexture(bgHex) {
  const cv = document.createElement('canvas');
  cv.width = 64; cv.height = 256;
  const g = cv.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, shade(bgHex, 0.10));
  grad.addColorStop(0.55, bgHex);
  grad.addColorStop(1, shade(bgHex, -0.28));
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 256);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeWoodTexture(rng) {
  const cv = document.createElement('canvas');
  cv.width = 256; cv.height = 256;
  const g = cv.getContext('2d');
  g.fillStyle = '#9a7a56';
  g.fillRect(0, 0, 256, 256);
  // horizontal grain streaks, seeded
  for (let i = 0; i < 90; i++) {
    const y = rng.next() * 256;
    const w = 30 + rng.next() * 226;
    const x = rng.next() * 256 - 20;
    const dark = rng.next() < 0.6;
    g.strokeStyle = dark ? 'rgba(70,48,28,0.18)' : 'rgba(230,205,170,0.12)';
    g.lineWidth = 0.6 + rng.next() * 2.2;
    g.beginPath();
    g.moveTo(x, y);
    g.bezierCurveTo(x + w * 0.3, y + (rng.next() - 0.5) * 6,
      x + w * 0.7, y + (rng.next() - 0.5) * 6, x + w, y + (rng.next() - 0.5) * 4);
    g.stroke();
  }
  // plank seams
  for (let i = 0; i < 4; i++) {
    const y = 32 + i * 64;
    g.strokeStyle = 'rgba(50,32,18,0.35)';
    g.lineWidth = 2;
    g.beginPath(); g.moveTo(0, y); g.lineTo(256, y); g.stroke();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(3, 1);
  return tex;
}

function makeFlameTexture() {
  const cv = document.createElement('canvas');
  cv.width = 64; cv.height = 64;
  const g = cv.getContext('2d');
  const grad = g.createRadialGradient(32, 36, 2, 32, 32, 30);
  grad.addColorStop(0, 'rgba(255,250,220,1)');
  grad.addColorStop(0.35, 'rgba(255,190,90,0.9)');
  grad.addColorStop(0.7, 'rgba(255,120,40,0.35)');
  grad.addColorStop(1, 'rgba(255,90,20,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Soft round sprite for particles and motes (replaces square GL points).
function makeDotTexture() {
  const cv = document.createElement('canvas');
  cv.width = 32; cv.height = 32;
  const g = cv.getContext('2d');
  const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.75)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 32, 32);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Detailed wall: laid stone blocks with mortar, plaster wash and speckle,
// plus a matching greyscale bump map (both seeded).
function makeStoneTextures(bgHex, rng) {
  const W = 512, H = 256;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  const bump = document.createElement('canvas');
  bump.width = W; bump.height = H;
  const b = bump.getContext('2d');
  g.fillStyle = shade(bgHex, -0.55);
  g.fillRect(0, 0, W, H);
  b.fillStyle = '#202020';
  b.fillRect(0, 0, W, H);
  const rowH = 32;
  for (let row = 0; row < H / rowH; row++) {
    let x = row % 2 ? -rng.next() * 40 : -rng.next() * 20;
    while (x < W) {
      const w = 56 + rng.next() * 60;
      const tone = (rng.next() - 0.5) * 0.14 - 0.04;
      g.fillStyle = shade(bgHex, tone);
      g.fillRect(x + 2, row * rowH + 2, w - 4, rowH - 4);
      const v = 150 + Math.floor(rng.next() * 60);
      b.fillStyle = `rgb(${v},${v},${v})`;
      b.fillRect(x + 2, row * rowH + 2, w - 4, rowH - 4);
      // bevelled top edge catches the key light
      g.fillStyle = 'rgba(255,230,200,0.035)';
      g.fillRect(x + 2, row * rowH + 2, w - 4, 3);
      x += w;
    }
  }
  for (let i = 0; i < 2200; i++) { // speckle + pitting
    const x = rng.next() * W, y = rng.next() * H;
    const a = rng.next() * 0.12;
    g.fillStyle = rng.next() < 0.5 ? `rgba(0,0,0,${a})` : `rgba(255,235,210,${a * 0.6})`;
    g.fillRect(x, y, 1.5, 1.5);
    b.fillStyle = `rgba(0,0,0,${a * 2})`;
    b.fillRect(x, y, 2, 2);
  }
  // vertical plaster wash: brighter mid-band, darker floor
  const wash = g.createLinearGradient(0, 0, 0, H);
  wash.addColorStop(0, 'rgba(0,0,0,0.25)');
  wash.addColorStop(0.45, 'rgba(255,220,180,0.04)');
  wash.addColorStop(1, 'rgba(0,0,0,0.4)');
  g.fillStyle = wash;
  g.fillRect(0, 0, W, H);
  const map = new THREE.CanvasTexture(cv);
  map.colorSpace = THREE.SRGBColorSpace;
  const bumpTex = new THREE.CanvasTexture(bump);
  for (const t of [map, bumpTex]) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(6, 3);
    t.anisotropy = 4;
  }
  return { map, bump: bumpTex };
}

// ---------------------------------------------------------------------------
// Accessibility shape badges: cached extruded geometry per shape token
// ---------------------------------------------------------------------------

const badgeGeoCache = new Map();

function badgeShapePath(name) {
  const s = new THREE.Shape();
  switch (name) {
    case 'triangle':
      s.moveTo(0, 0.5); s.lineTo(0.45, -0.38); s.lineTo(-0.45, -0.38); s.closePath(); break;
    case 'square':
      s.moveTo(-0.38, -0.38); s.lineTo(0.38, -0.38); s.lineTo(0.38, 0.38); s.lineTo(-0.38, 0.38); s.closePath(); break;
    case 'diamond':
      s.moveTo(0, 0.55); s.lineTo(0.4, 0); s.lineTo(0, -0.55); s.lineTo(-0.4, 0); s.closePath(); break;
    case 'star': {
      for (let i = 0; i < 10; i++) {
        const r = i % 2 === 0 ? 0.5 : 0.21;
        const a = Math.PI / 2 + (i / 10) * Math.PI * 2;
        const x = Math.cos(a) * r, y = Math.sin(a) * r;
        if (i === 0) s.moveTo(x, y); else s.lineTo(x, y);
      }
      s.closePath(); break;
    }
    case 'drop':
      s.moveTo(0, 0.6);
      s.quadraticCurveTo(0.42, 0.05, 0.34, -0.22);
      s.quadraticCurveTo(0.2, -0.5, 0, -0.5);
      s.quadraticCurveTo(-0.2, -0.5, -0.34, -0.22);
      s.quadraticCurveTo(-0.42, 0.05, 0, 0.6);
      break;
    case 'hexagon': {
      for (let i = 0; i < 6; i++) {
        const a = Math.PI / 6 + (i / 6) * Math.PI * 2;
        const x = Math.cos(a) * 0.5, y = Math.sin(a) * 0.5;
        if (i === 0) s.moveTo(x, y); else s.lineTo(x, y);
      }
      s.closePath(); break;
    }
    case 'moon': {
      s.absarc(0, 0, 0.5, 0, Math.PI * 2, false);
      const hole = new THREE.Path();
      hole.absarc(0.2, 0.08, 0.42, 0, Math.PI * 2, true);
      s.holes.push(hole);
      break;
    }
    case 'wave':
      s.moveTo(-0.5, 0.05);
      s.quadraticCurveTo(-0.25, 0.35, 0, 0.05);
      s.quadraticCurveTo(0.25, -0.25, 0.5, 0.05);
      s.lineTo(0.5, -0.15);
      s.quadraticCurveTo(0.25, -0.45, 0, -0.15);
      s.quadraticCurveTo(-0.25, 0.15, -0.5, -0.15);
      s.closePath();
      break;
    case 'bolt':
      s.moveTo(0.12, 0.52); s.lineTo(-0.26, 0.04); s.lineTo(-0.02, 0.04);
      s.lineTo(-0.12, -0.52); s.lineTo(0.26, -0.04); s.lineTo(0.02, -0.04);
      s.closePath();
      break;
    case 'circle':
    default:
      s.absarc(0, 0, 0.45, 0, Math.PI * 2, false);
      break;
  }
  return s;
}

function badgeGeometry(name) {
  const key = badgeGeoCache.has(name) ? name : 'circle';
  if (!badgeGeoCache.has(key)) {
    const geo = new THREE.ExtrudeGeometry(badgeShapePath(key), {
      depth: 0.35, bevelEnabled: true, bevelThickness: 0.05, bevelSize: 0.05,
      bevelSegments: 1, curveSegments: 10,
    });
    badgeGeoCache.set(key, geo);
  }
  return badgeGeoCache.get(key);
}

// ---------------------------------------------------------------------------
// Capability probe
// ---------------------------------------------------------------------------

// One-shot probe: WebGL support plus the unmasked GPU name (for Auto quality).
// Firefox exposes the real renderer via RENDERER and warns on the debug
// extension, so the extension is only queried elsewhere.
export function probeGpu() {
  try {
    const cv = document.createElement('canvas');
    const gl = cv.getContext('webgl2') || cv.getContext('webgl');
    if (!gl) return { available: false, gpu: '' };
    let gpu = '';
    const firefox = /firefox/i.test(navigator.userAgent || '');
    const ext = firefox ? null : gl.getExtension('WEBGL_debug_renderer_info');
    gpu = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) || '');
    const lose = gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
    return { available: true, gpu };
  } catch (_) {
    return { available: false, gpu: '' };
  }
}

export function isWebGLAvailable() {
  try {
    const cv = document.createElement('canvas');
    return !!(window.WebGLRenderingContext &&
      (cv.getContext('webgl2') || cv.getContext('webgl') || cv.getContext('experimental-webgl')));
  } catch (_) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Renderer factory
// ---------------------------------------------------------------------------

export async function createRenderer({ canvas, container, theme, paletteColors, decorSeed, settings = {}, graphics = {}, detectedPreset = 'balanced', gpu = '', onVesselPick }) {
  // Initial graphics tiers; canvas MSAA is a context attribute, so it is chosen
  // here (post-processing chains carry their own MSAA/FXAA/SMAA and apply live).
  let gfx = resolveGraphics(graphics, detectedPreset);
  const renderer = new THREE.WebGLRenderer({
    canvas, antialias: gfx.antialias === 'msaa' && !gfx.post, alpha: false, powerPreference: 'high-performance',
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;   // conservative; liquid hues stay separable
  renderer.shadowMap.enabled = SHADOW_MAP[gfx.shadows] > 0;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(CAM.FOV, 1, 0.1, 60);
  camera.layers.enable(1); // layer 1: cosmetic particles (never raycast)

  // ---- mutable module state ------------------------------------------------
  let themeObj = theme;
  let palette = paletteColors || [];
  let reducedMotion = !!settings.reducedMotion;
  // Ambient mode: the semantic DOM board is the playable surface, so this
  // renderer draws only the environment (shelf, props, lights, particles) and
  // scene-level celebrations — no 3D vessels, markers, or canvas picking.
  const ambientOnly = !!settings.ambientOnly;
  let cssW = 1, cssH = 1, dprRaw = window.devicePixelRatio || 1;
  let pixelRatioNow = 1;
  let adaptiveScale = 1;
  const frameTimes = [];
  let fpsNow = 0;
  let composer = null;
  let gradePass = null;
  let postKey = null;
  let postFailed = false;
  let pmrem = null;
  let envTex = null;
  let paused = false;
  let disposed = false;
  let timeMs = 0;                 // accumulated clock; gameplay-adjacent motion derives from this
  let ambMs = 0;                  // ambient decor clock (candle, orbs, motes)
  let lastState = null;
  let currentCapacity = 4;
  let selectedIndex = null;
  let focusIndex = null;
  const previewSet = new Set();
  let vesselCount = 0;
  const vesselViews = [];
  const pick = typeof onVesselPick === 'function' ? onVesselPick : () => {};

  const rng = decorStream(decorSeed == null ? 'default' : decorSeed);
  const fxRng = rng.fork('fx');

  // Reused scratch objects (no per-frame allocations).
  const tmpV1 = new THREE.Vector3();
  const tmpV2 = new THREE.Vector3();
  const tmpV3 = new THREE.Vector3();
  const tmpQuat = new THREE.Quaternion();
  const tmpMat4 = new THREE.Matrix4();
  const UP_AXIS = new THREE.Vector3(0, 1, 0);
  const raycaster = new THREE.Raycaster();
  const pointerNdc = new THREE.Vector2();

  // ---- lighting -------------------------------------------------------------
  // Hemisphere fill (warm sky / dark wood bounce), a shadow-casting key light
  // whose frustum is fitted to the two shelves and the wall behind them, and a
  // cool rim light from behind-left.
  const warm = themeObj.ambience !== 'cool';
  const ambient = new THREE.HemisphereLight(warm ? 0xffe6c8 : 0xdde8ff, warm ? 0x2a1a10 : 0x101820, 0.9);
  scene.add(ambient);
  const keyLight = new THREE.DirectionalLight(warm ? 0xffd9a8 : 0xdceaff, 2.6);
  keyLight.position.set(4, 6.5, 5);
  keyLight.castShadow = SHADOW_MAP[gfx.shadows] > 0;
  keyLight.shadow.mapSize.set(1024, 1024);
  keyLight.shadow.camera.left = -7.2; keyLight.shadow.camera.right = 7.2;
  keyLight.shadow.camera.top = 4.2; keyLight.shadow.camera.bottom = -4.4;
  keyLight.shadow.camera.near = 3; keyLight.shadow.camera.far = 19;
  keyLight.shadow.bias = -0.0015;
  keyLight.shadow.normalBias = 0.02;
  keyLight.shadow.radius = 3;
  scene.add(keyLight);
  scene.add(keyLight.target);
  keyLight.target.position.set(0, -0.6, -1.2);
  const rimLight = new THREE.DirectionalLight(warm ? 0x9fb8ff : 0xffe9c8, 0.9);
  rimLight.position.set(-5, 3.5, -4);
  scene.add(rimLight);
  const baseIntensity = { ambient: ambient.intensity, key: keyLight.intensity, rim: rimLight.intensity };
  const mood = { dim: 1 }; // subdued dim for 'failed'; tweened

  // ---- environment: wall + shelves ------------------------------------------
  const envGroup = new THREE.Group();
  scene.add(envGroup);

  let wallTex = makeWallTexture(themeObj.bg);
  let stoneTex = null; // built lazily for the 'detailed' tier
  const wallMat = new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.95, metalness: 0 });
  wallMat.userData.envI = 0.04;
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(34, 18), wallMat);
  wall.position.set(0, 4.5, -4.5);
  wall.receiveShadow = true;
  envGroup.add(wall);

  const woodTex = makeWoodTexture(rng.fork('wood'));
  const shelfMat = new THREE.MeshStandardMaterial({
    map: woodTex, color: themeObj.shelf, roughness: 0.8, metalness: 0.05,
  });
  shelfMat.userData.envI = 0.3;
  const shelfGeo = new THREE.BoxGeometry(13, 0.28, 2.8);
  const shelfMain = new THREE.Mesh(shelfGeo, shelfMat);
  shelfMain.position.set(0, -0.14, 0); // top surface at y = 0
  shelfMain.receiveShadow = true;
  shelfMain.castShadow = true;
  envGroup.add(shelfMain);
  const shelfLow = new THREE.Mesh(shelfGeo, shelfMat);
  shelfLow.position.set(0, -2.4, -0.2);
  shelfLow.receiveShadow = true;
  envGroup.add(shelfLow);

  // 'detailed' tier: brass edge trim and corbels under both shelves.
  const brassMat = new THREE.MeshStandardMaterial({ color: 0xb08038, metalness: 1, roughness: 0.38 });
  brassMat.userData.envI = 0.6;
  const detailGroup = new THREE.Group();
  envGroup.add(detailGroup);
  {
    const trimGeo = new THREE.BoxGeometry(13.02, 0.035, 0.03);
    for (const [y, z] of [[-0.03, 1.4], [-2.29, 1.2]]) {
      const trim = new THREE.Mesh(trimGeo, brassMat);
      trim.position.set(0, y, z);
      detailGroup.add(trim);
    }
    const corbelGeo = new THREE.BoxGeometry(0.12, 0.7, 1.6);
    for (const [x, y, z] of [[-5.6, -0.63, -0.5], [5.6, -0.63, -0.5], [-5.6, -2.89, -0.7], [5.6, -2.89, -0.7]]) {
      const c = new THREE.Mesh(corbelGeo, shelfMat);
      c.position.set(x, y, z);
      c.castShadow = true;
      c.receiveShadow = true;
      detailGroup.add(c);
    }
  }

  function applyDetail(on) {
    detailGroup.visible = on;
    if (on) {
      if (!stoneTex) stoneTex = makeStoneTextures(themeObj.bg, rng.fork('stone'));
      wallMat.map = stoneTex.map;
      wallMat.bumpMap = stoneTex.bump;
      wallMat.bumpScale = 2.2;
      wallMat.roughness = 0.9;
      shelfMat.bumpMap = woodTex;
      shelfMat.bumpScale = 1.4;
      shelfMat.roughness = 0.62;
    } else {
      wallMat.map = wallTex;
      wallMat.bumpMap = null;
      wallMat.roughness = 0.95;
      shelfMat.bumpMap = null;
      shelfMat.roughness = 0.8;
    }
    wallMat.needsUpdate = true;
    shelfMat.needsUpdate = true;
  }

  scene.background = new THREE.Color(themeObj.bg);
  scene.fog = new THREE.Fog(themeObj.fog, 12, 30); // gentle; vessels stay clear at max reframe distance

  // ---- deterministic decor (seeded, ≤ ~40 meshes, instanced where repeated)
  const decorGroup = new THREE.Group();
  scene.add(decorGroup);

  const flameTex = makeFlameTexture();
  const orbBase = [];
  let orbMesh = null;
  let flameSprite = null;
  let candleLight = null;
  let flameHalo = null;
  let flamePhase = 0;
  let orbsPlaced = false;
  const flaskLiquids = [];
  const dotTex = makeDotTexture();

  function buildDecor() {
    // stacked books (instanced)
    const bookRng = rng.fork('books');
    const bookGeo = new THREE.BoxGeometry(0.55, 0.12, 0.4);
    const bookMat = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0 });
    const books = new THREE.InstancedMesh(bookGeo, bookMat, 9);
    const col = new THREE.Color();
    let bi = 0;
    const stacks = [{ x: -4.6, z: -0.35, n: 5, y: -2.26 }, { x: 4.7, z: -0.3, n: 4, y: -2.26 }];
    for (const st of stacks) {
      let y = st.y + 0.06;
      for (let i = 0; i < st.n; i++) {
        tmpMat4.makeRotationY((bookRng.next() - 0.5) * 0.5);
        tmpMat4.setPosition(st.x + (bookRng.next() - 0.5) * 0.15, y, st.z + (bookRng.next() - 0.5) * 0.1);
        books.setMatrixAt(bi, tmpMat4);
        col.setHSL(bookRng.next(), 0.35 + bookRng.next() * 0.25, 0.3 + bookRng.next() * 0.2);
        books.setColorAt(bi, col);
        y += 0.125;
        bi++;
      }
    }
    books.instanceMatrix.needsUpdate = true;
    if (books.instanceColor) books.instanceColor.needsUpdate = true;
    books.receiveShadow = true;
    books.castShadow = true;
    decorGroup.add(books);

    // candle with flickering flame sprite (main shelf, right end)
    const candleRng = rng.fork('candle');
    flamePhase = candleRng.next() * 100;
    const candle = new THREE.Mesh(
      new THREE.CylinderGeometry(0.09, 0.115, 0.5, 14),
      new THREE.MeshPhysicalMaterial({
        color: 0xf2e6c8, roughness: 0.55, sheen: 0.6, sheenColor: new THREE.Color(0xffd8a0),
        emissive: 0xff9a40, emissiveIntensity: 0.05,
      }));
    candle.position.set(4.5, 0.25, -0.75);
    candle.castShadow = true;
    decorGroup.add(candle);
    const dish = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.15, 0.04, 20), brassMat);
    dish.position.set(4.5, 0.02, -0.75);
    dish.castShadow = true;
    dish.receiveShadow = true;
    decorGroup.add(dish);
    // soft halo around the flame (blooms under post-processing)
    flameHalo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: dotTex, color: warm ? 0xffa050 : 0xffc890, transparent: true, opacity: 0.35,
      depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    flameHalo.position.set(4.5, 0.64, -0.74);
    flameHalo.scale.set(0.9, 0.9, 1);
    decorGroup.add(flameHalo);
    flameSprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: flameTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    flameSprite.position.set(4.5, 0.62, -0.75);
    flameSprite.scale.set(0.16, 0.24, 1);
    decorGroup.add(flameSprite);
    candleLight = new THREE.PointLight(warm ? 0xffb060 : 0xffc890, 5, 5, 2);
    candleLight.position.set(4.5, 0.75, -0.6);
    decorGroup.add(candleLight);

    // scroll tubes on the lower shelf
    const scrollRng = rng.fork('scrolls');
    const scrollMat = new THREE.MeshStandardMaterial({ color: 0xd9c49a, roughness: 0.9 });
    const scrollGeo = new THREE.CylinderGeometry(0.07, 0.07, 0.9, 12);
    for (let i = 0; i < 3; i++) {
      const sc = new THREE.Mesh(scrollGeo, scrollMat);
      sc.castShadow = true;
      sc.receiveShadow = true;
      sc.rotation.z = Math.PI / 2;
      sc.rotation.y = (scrollRng.next() - 0.5) * 0.4;
      sc.position.set(1.4 + i * 0.5, -2.26 + 0.07 + (i === 2 ? 0.13 : 0), -0.45 + scrollRng.next() * 0.2);
      decorGroup.add(sc);
    }

    // potted sprig (lower shelf, left)
    const pot = new THREE.Mesh(
      new THREE.CylinderGeometry(0.16, 0.12, 0.22, 12),
      new THREE.MeshStandardMaterial({ color: 0xa85f3c, roughness: 0.85 }));
    pot.position.set(-2.2, -2.26 + 0.11, -0.35);
    pot.castShadow = true;
    decorGroup.add(pot);

    // two stoppered specimen flasks on the lower shelf: clear glass that
    // catches the room reflections, with a faintly glowing draught inside
    const flaskRng = rng.fork('flasks');
    const flaskGlass = new THREE.MeshPhysicalMaterial({
      color: 0xffffff, roughness: 0.05, metalness: 0, transmission: 0.9, thickness: 0.2, ior: 1.45,
      transparent: true, opacity: 0.55, clearcoat: 1, clearcoatRoughness: 0.05,
      side: THREE.DoubleSide, depthWrite: false,
    });
    flaskGlass.userData.envI = 0.9;
    const flaskPts = [];
    for (let i = 0; i <= 10; i++) {
      const a = -Math.PI / 2 + (i / 10) * Math.PI * 0.85;
      flaskPts.push(new THREE.Vector2(Math.max(0.001, 0.26 * Math.cos(a)), 0.26 + 0.26 * Math.sin(a)));
    }
    flaskPts.push(new THREE.Vector2(0.07, 0.62), new THREE.Vector2(0.07, 0.78), new THREE.Vector2(0.085, 0.8));
    const flaskGeo = new THREE.LatheGeometry(flaskPts, 24);
    const draughtGeo = new THREE.SphereGeometry(0.23, 20, 12, 0, Math.PI * 2, Math.PI * 0.42, Math.PI * 0.58);
    const corkMat = new THREE.MeshStandardMaterial({ color: 0x8a6440, roughness: 0.95 });
    for (const [x, z] of [[-3.7, -0.2], [3.2, -0.45]]) {
      const hue = flaskRng.next();
      const liquid = new THREE.MeshStandardMaterial({
        color: new THREE.Color().setHSL(hue, 0.7, 0.45), emissive: new THREE.Color().setHSL(hue, 0.8, 0.4),
        emissiveIntensity: 0.6, roughness: 0.2,
      });
      const flask = new THREE.Group();
      const draught = new THREE.Mesh(draughtGeo, liquid);
      draught.position.y = 0.26;
      const glassM = new THREE.Mesh(flaskGeo, flaskGlass);
      glassM.castShadow = true;
      const cork = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.06, 0.1, 12), corkMat);
      cork.position.y = 0.82;
      flask.add(draught, glassM, cork);
      flask.position.set(x, -2.26, z);
      flask.scale.setScalar(0.9 + flaskRng.next() * 0.3);
      detailGroup.add(flask);
      flaskLiquids.push(liquid);
    }
    const leafMat = new THREE.MeshStandardMaterial({ color: 0x4d7a3a, roughness: 0.7 });
    const leafGeo = new THREE.ConeGeometry(0.05, 0.42, 6);
    for (let i = 0; i < 3; i++) {
      const leaf = new THREE.Mesh(leafGeo, leafMat);
      leaf.position.set(-2.2 + (i - 1) * 0.06, -2.26 + 0.4, -0.35 + (i % 2) * 0.05);
      leaf.rotation.z = (i - 1) * 0.45;
      decorGroup.add(leaf);
    }

    // hanging orbs (instanced, gentle seeded bob)
    const orbRng = rng.fork('orbs');
    orbMesh = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.09, 12, 10),
      new THREE.MeshStandardMaterial({ color: 0x2a2438, emissive: themeObj.accent, emissiveIntensity: 2.4, roughness: 0.4 }),
      6);
    for (let i = 0; i < 6; i++) {
      orbBase.push({
        x: -3 + i * 1.2 + (orbRng.next() - 0.5) * 0.4,
        y: 2.9 + orbRng.next() * 0.5,
        z: -2.2 - orbRng.next() * 0.5,
        phase: orbRng.next() * Math.PI * 2,
        amp: 0.05 + orbRng.next() * 0.05,
      });
    }
    orbMesh.castShadow = true;
    decorGroup.add(orbMesh);
  }
  buildDecor();

  // ---- drifting motes in the candle light (count from the particles tier) ----
  const motePos = new Float32Array(MOTE_MAX * 3);
  const moteSeed = new Float32Array(MOTE_MAX * 4);
  {
    const mr = rng.fork('motes');
    for (let i = 0; i < MOTE_MAX; i++) {
      moteSeed[i * 4] = (mr.next() * 2 - 1) * 5.5;     // base x
      moteSeed[i * 4 + 1] = -2.2 + mr.next() * 5.2;    // base y
      moteSeed[i * 4 + 2] = -3.6 + mr.next() * 4.4;   // base z
      moteSeed[i * 4 + 3] = mr.next() * 1000;          // phase
    }
  }
  const moteGeo = new THREE.BufferGeometry();
  moteGeo.setAttribute('position', new THREE.BufferAttribute(motePos, 3));
  const motes = new THREE.Points(moteGeo, new THREE.PointsMaterial({
    size: 0.05, map: dotTex, color: warm ? 0xffc890 : 0xcfe4ff, transparent: true, opacity: 0.55,
    depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true,
  }));
  motes.frustumCulled = false;
  motes.layers.set(1);
  scene.add(motes);
  function updateMotes(tS) {
    const n = moteGeo.drawRange.count;
    for (let i = 0; i < n; i++) {
      const ph = moteSeed[i * 4 + 3];
      const rise = ((tS * 0.06 + ph * 0.37) % 5.2);
      motePos[i * 3] = moteSeed[i * 4] + Math.sin(tS * 0.3 + ph) * 0.35;
      motePos[i * 3 + 1] = -2.2 + ((moteSeed[i * 4 + 1] + 2.2 + rise) % 5.2);
      motePos[i * 3 + 2] = moteSeed[i * 4 + 2] + Math.cos(tS * 0.23 + ph) * 0.25;
    }
    moteGeo.attributes.position.needsUpdate = true;
  }

  // ---- bounded pooled particles (THREE.Points, layer 1) ---------------------
  const pPos = new Float32Array(PARTICLE_MAX * 3);
  const pCol = new Float32Array(PARTICLE_MAX * 3);
  const pVel = new Float32Array(PARTICLE_MAX * 3);
  const pLife = new Float32Array(PARTICLE_MAX);
  const pMaxLife = new Float32Array(PARTICLE_MAX);
  const pGrav = new Float32Array(PARTICLE_MAX);
  for (let i = 0; i < PARTICLE_MAX; i++) pPos[i * 3 + 1] = -999;
  const pGeo = new THREE.BufferGeometry();
  pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
  pGeo.setAttribute('color', new THREE.BufferAttribute(pCol, 3));
  const points = new THREE.Points(pGeo, new THREE.PointsMaterial({
    size: 0.09, map: dotTex, vertexColors: true, transparent: true, opacity: 0.95,
    depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true,
  }));
  points.frustumCulled = false;
  points.layers.set(1);
  scene.add(points);
  let pCursor = 0;
  let pAlive = 0;
  let pBudget = PARTICLE_BUDGET[gfx.particles];
  const tmpColor = new THREE.Color();

  function spawnParticle(x, y, z, vx, vy, vz, lifeMs, colorHex, grav) {
    if (pAlive >= pBudget) return;
    const i = pCursor;
    pCursor = (pCursor + 1) % PARTICLE_MAX;
    pPos[i * 3] = x; pPos[i * 3 + 1] = y; pPos[i * 3 + 2] = z;
    pVel[i * 3] = vx; pVel[i * 3 + 1] = vy; pVel[i * 3 + 2] = vz;
    pLife[i] = lifeMs; pMaxLife[i] = lifeMs; pGrav[i] = grav;
    tmpColor.set(colorHex);
    pCol[i * 3] = tmpColor.r; pCol[i * 3 + 1] = tmpColor.g; pCol[i * 3 + 2] = tmpColor.b;
    pAlive++;
  }

  function spawnBurst(x, y, z, colorHex, count, speed, upBias, grav) {
    for (let n = 0; n < count; n++) {
      const a = fxRng.next() * Math.PI * 2;
      const r = fxRng.next() * speed;
      spawnParticle(x, y, z,
        Math.cos(a) * r, upBias + fxRng.next() * speed, Math.sin(a) * r * 0.6,
        500 + fxRng.next() * 600, colorHex, grav);
    }
  }

  function updateParticles(dtS) {
    if (pAlive === 0) return;
    let alive = 0;
    for (let i = 0; i < PARTICLE_MAX; i++) {
      if (pLife[i] <= 0) continue;
      pLife[i] -= dtS * 1000;
      if (pLife[i] <= 0) { pPos[i * 3 + 1] = -999; continue; }
      pVel[i * 3 + 1] -= pGrav[i] * dtS;
      pPos[i * 3] += pVel[i * 3] * dtS;
      pPos[i * 3 + 1] += pVel[i * 3 + 1] * dtS;
      pPos[i * 3 + 2] += pVel[i * 3 + 2] * dtS;
      alive++;
    }
    pAlive = alive;
    pGeo.attributes.position.needsUpdate = true;
    pGeo.attributes.color.needsUpdate = true;
  }

  // ---- shared gameplay materials / geometries --------------------------------
  const glassPhysMat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, metalness: 0, roughness: 0.08, transmission: 0.92,
    thickness: 0.35, ior: 1.5, side: THREE.DoubleSide, clearcoat: 1, clearcoatRoughness: 0.06,
  });
  const glassPhongMat = new THREE.MeshPhongMaterial({
    color: 0xcfd8e6, transparent: true, opacity: 0.22, shininess: 90,
    specular: 0x88aacc, side: THREE.DoubleSide, depthWrite: false,
  });
  const liquidMats = []; // per color index, updated in place on theme/palette change

  function ensureLiquidMats() {
    for (let i = 0; i < palette.length; i++) {
      if (!liquidMats[i]) {
        liquidMats[i] = new THREE.MeshStandardMaterial({ roughness: 0.3, metalness: 0 });
      }
      const m = liquidMats[i];
      m.color.set(palette[i].hex);
      m.emissive.set(palette[i].hex);
      m.emissiveIntensity = 0.55; // conservative: hues survive ACES tone mapping
    }
  }
  ensureLiquidMats();

  const badgeMat = new THREE.MeshStandardMaterial({ color: 0x1a1620, roughness: 0.6, metalness: 0.1 });
  const gapMat = new THREE.MeshStandardMaterial({ color: 0x0d0b14, roughness: 1, metalness: 0 });
  const rimMat = new THREE.MeshStandardMaterial({
    color: themeObj.accent, emissive: themeObj.accent, emissiveIntensity: 1.4, roughness: 0.4,
  });
  const focusMat = new THREE.MeshBasicMaterial({ color: 0xf4f7ff, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false });
  const proxyMat = new THREE.MeshBasicMaterial({ visible: false });
  const streamMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.8,
    roughness: 0.25, transparent: true, opacity: 0.85,
  });

  // open-top glass flask: rounded bottom, straight wall, slight lip flare
  function buildGlassGeometry() {
    const pts = [];
    const R = VESSEL.GLASS_R;
    for (let i = 0; i <= 8; i++) {
      const a = -Math.PI / 2 + (i / 8) * (Math.PI / 2);
      pts.push(new THREE.Vector2(Math.max(0.001, R * Math.cos(a)), R + R * Math.sin(a)));
    }
    pts.push(new THREE.Vector2(R, VESSEL.GLASS_H - 0.1));
    pts.push(new THREE.Vector2(R + VESSEL.LIP_FLARE, VESSEL.GLASS_H));
    return new THREE.LatheGeometry(pts, 28);
  }
  const glassGeo = buildGlassGeometry();
  const layerGeo = new THREE.CylinderGeometry(1, 1, 1, 24);          // unit; scaled per slot
  const meniscusGeo = new THREE.CylinderGeometry(VESSEL.INNER_R * 0.98, VESSEL.INNER_R * 0.98, 0.012, 24);
  const gapGeo = new THREE.CylinderGeometry(VESSEL.INNER_R + 0.012, VESSEL.INNER_R + 0.012, 0.018, 24);
  const ringGeo = new THREE.RingGeometry(0.44, 0.55, 32);
  const focusRingGeo = new THREE.RingGeometry(0.6, 0.66, 32);
  const rimGeo = new THREE.TorusGeometry(VESSEL.GLASS_R + VESSEL.LIP_FLARE + 0.015, 0.02, 8, 32);
  const proxyGeo = new THREE.CylinderGeometry(VESSEL.PROXY_R, VESSEL.PROXY_R, VESSEL.PROXY_H, 12);
  const streamGeo = new THREE.CylinderGeometry(1, 1, 1, 10);

  const stream = new THREE.Mesh(streamGeo, streamMat);
  stream.visible = false;
  scene.add(stream);

  // ---- vessel views -----------------------------------------------------------
  const boardGroup = new THREE.Group();
  if (ambientOnly) boardGroup.visible = false;
  scene.add(boardGroup);
  const hitProxies = []; // explicit raycast whitelist — never particles/props/liquids

  function makeVesselView(index) {
    const root = new THREE.Group();
    const body = new THREE.Group();
    root.add(body);

    const glass = new THREE.Mesh(glassGeo, gfx.detail === 'detailed' ? glassPhysMat : glassPhongMat);
    body.add(glass);

    const rim = new THREE.Mesh(rimGeo, rimMat);
    rim.rotation.x = Math.PI / 2;
    rim.position.y = VESSEL.GLASS_H;
    rim.visible = false;
    body.add(rim);

    const glow = new THREE.Mesh(glassGeo, new THREE.MeshBasicMaterial({
      color: themeObj.accent, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    }));
    glow.scale.set(1.06, 1.02, 1.06);
    body.add(glow);

    const liquidGroup = new THREE.Group(); // counter-rotated during pours: liquid stays level
    body.add(liquidGroup);

    const layerMeshes = [];
    const badges = [];
    const gapRings = [];
    for (let i = 0; i < 8; i++) { // pool for any reasonable capacity; visibility gated
      const lm = new THREE.Mesh(layerGeo, liquidMats[0] || new THREE.MeshStandardMaterial());
      lm.visible = false;
      lm.castShadow = gfx.shadows !== 'off';
      liquidGroup.add(lm);
      layerMeshes.push(lm);
      const b = new THREE.Mesh(badgeGeometry('circle'), badgeMat);
      b.visible = false;
      b.scale.set(0.16, 0.16, 0.16);
      liquidGroup.add(b);
      badges.push(b);
      if (i > 0) {
        const g = new THREE.Mesh(gapGeo, gapMat);
        g.visible = false;
        liquidGroup.add(g);
        gapRings.push(g);
      }
    }
    const meniscus = new THREE.Mesh(meniscusGeo, liquidMats[0] || layerMeshes[0].material);
    meniscus.visible = false;
    liquidGroup.add(meniscus);

    const proxy = new THREE.Mesh(proxyGeo, proxyMat);
    proxy.position.y = VESSEL.PROXY_H / 2;
    proxy.userData.vesselIndex = index;
    root.add(proxy);
    hitProxies.push(proxy);

    const markerRing = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
      color: themeObj.accent, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false,
    }));
    markerRing.rotation.x = -Math.PI / 2;
    markerRing.position.y = 0.015;
    markerRing.visible = false;
    root.add(markerRing);

    const focusRing = new THREE.Mesh(focusRingGeo, focusMat.clone());
    focusRing.rotation.x = -Math.PI / 2;
    focusRing.position.y = 0.012;
    focusRing.visible = false;
    root.add(focusRing);

    boardGroup.add(root);
    return {
      index, root, body, glass, rim, glow, liquidGroup,
      layerMeshes, badges, gapRings, meniscus, proxy, markerRing, focusRing,
      layers: [],                 // currently displayed color indices, bottom-first
      basePos: { x: 0, z: 0 },
      lift: { x: 0, v: 0, target: 0 },
      shakeT: -1,                 // >=0 while an invalid-shake is running
      flashT: -1,                 // >=0 while an invalid red flash is running
      markerMode: 'none',         // 'none' | 'selected' | 'preview'
      animLocked: false,          // body transform owned by an animation job
    };
  }

  function layerHeight() { return (VESSEL.INNER_TOP - VESSEL.INNER_BOTTOM) / currentCapacity; }

  // Position/visibility of pooled liquid slots from view.layers (deterministic).
  // `count` limits how many leading layers are shown; `topScale` scales the top
  // visible one (pour in/out progress). Defaults show the full stack.
  function syncLiquids(view, topScale = 1, count = view.layers.length) {
    const n = Math.min(count, currentCapacity);
    const lh = layerHeight();
    const labelsOn = !!settings.labelsOnLiquids;
    for (let i = 0; i < view.layerMeshes.length; i++) {
      const on = i < n;
      const lm = view.layerMeshes[i];
      lm.visible = on;
      if (on) {
        const ci = view.layers[i];
        lm.material = liquidMats[ci] || liquidMats[0];
        const s = i === n - 1 ? topScale : 1;
        const h = Math.max(0.001, lh * s);
        lm.scale.set(VESSEL.INNER_R, h, VESSEL.INNER_R);
        lm.position.set(0, VESSEL.INNER_BOTTOM + i * lh + h / 2, 0);
      }
      const b = view.badges[i];
      b.visible = on && labelsOn;
      if (b.visible) {
        const ci = view.layers[i];
        const shape = palette[ci] && palette[ci].shape;
        b.geometry = badgeGeometry(shape || 'circle');
        b.position.set(0, VESSEL.INNER_BOTTOM + (i + 0.5) * lh, VESSEL.GLASS_R - 0.02);
      }
      if (i > 0) {
        const g = view.gapRings[i - 1];
        g.visible = i < n;
        if (g.visible) g.position.set(0, VESSEL.INNER_BOTTOM + i * lh, 0);
      }
    }
    view.meniscus.visible = n > 0;
    if (n > 0) {
      view.meniscus.material = liquidMats[view.layers[n - 1]] || liquidMats[0];
      view.meniscus.position.set(0, VESSEL.INNER_BOTTOM + (n - 1 + topScale) * lh + 0.006, 0);
    }
  }

  // ---- layout + camera framing --------------------------------------------------
  function computeLayout(count) {
    const rows = count > LAYOUT.MAX_PER_ROW ? 2 : 1;
    const front = rows === 1 ? count : Math.ceil(count / 2);
    const back = count - front;
    const pos = new Array(count);
    let idx = 0;
    const rowCounts = rows === 1 ? [count] : [front, back];
    for (let r = 0; r < rows; r++) {
      const n = rowCounts[r];
      const z = rows === 1 ? 0 : (r === 0 ? LAYOUT.ROW_GAP_Z / 2 : -LAYOUT.ROW_GAP_Z / 2);
      for (let i = 0; i < n; i++) {
        pos[idx++] = { x: (i - (n - 1) / 2) * LAYOUT.SPACING_X, z };
      }
    }
    return { pos, maxRow: Math.max(front, back, 1), rows };
  }

  const camBase = { dist: CAM.MIN_DIST };  // authored; tweened on reframe
  const camFx = { zoom: 1 };               // celebration ease; tweened
  const pan = { x: 0, y: 0, tx: 0, ty: 0 };// user drag pan; sprung toward target

  function targetDistance(count, layoutInfo) {
    const aspect = Math.max(0.3, cssW / Math.max(1, cssH));
    const halfW = (layoutInfo.maxRow * LAYOUT.SPACING_X) / 2 + CAM.MARGIN_X +
      (layoutInfo.rows > 1 ? CAM.TWO_ROW_EXTRA * 0.5 : 0);
    const vFit = 2.0 / Math.tan(THREE.MathUtils.degToRad(CAM.FOV / 2));
    const hFit = halfW / (Math.tan(THREE.MathUtils.degToRad(CAM.FOV / 2)) * aspect);
    let d = Math.max(CAM.BASE_DIST, vFit, hFit);
    d = clamp(d, CAM.MIN_DIST, CAM.MAX_DIST);
    if (settings.cameraWide) d *= CAM.WIDE_MULT;
    return d;
  }

  const tweens = [];
  let camTween = null;

  function frameCamera(animate) {
    // Ambient mode frames the whole shelf environment, not a vessel row.
    const frameCount = ambientOnly ? 7 : Math.max(1, vesselCount);
    const layoutInfo = computeLayout(frameCount);
    let dist = targetDistance(frameCount, layoutInfo);
    if (ambientOnly) dist = clamp(dist * 1.12, CAM.MIN_DIST, CAM.MAX_DIST);
    if (camTween) { camTween.cancel(false); camTween = null; }
    if (animate && !reducedMotion) {
      const from = camBase.dist;
      camTween = makeTween(CAM.TRANSITION_MS, (k) => { camBase.dist = from + (dist - from) * k; });
      tweens.push(camTween);
    } else {
      camBase.dist = dist;
    }
  }

  function ensureVessels(count) {
    while (vesselViews.length < count) vesselViews.push(makeVesselView(vesselViews.length));
    const layoutInfo = computeLayout(count);
    for (let i = 0; i < vesselViews.length; i++) {
      const v = vesselViews[i];
      const on = i < count;
      v.root.visible = on;
      if (on) {
        v.basePos = layoutInfo.pos[i];
        v.root.position.set(v.basePos.x, 0, v.basePos.z);
      }
    }
    if (count !== vesselCount) {
      vesselCount = count;
      frameCamera(true);
    }
  }

  // Snap every vessel view to the exact logical snapshot.
  function applySnapshot(state) {
    currentCapacity = state.capacity || 4;
    ensureVessels(state.vessels.length);
    for (let i = 0; i < state.vessels.length; i++) {
      const v = vesselViews[i];
      v.layers = state.vessels[i].slice();
      if (!v.animLocked) {
        v.body.position.set(0, 0, 0);
        v.body.rotation.set(0, 0, 0);
        v.liquidGroup.rotation.set(0, 0, 0);
      }
      syncLiquids(v, 1);
    }
  }

  // ---- animation job queue (pours, celebration, fail) ---------------------------
  let activeJob = null;
  const jobQueue = [];
  let queueResolve = null;

  function paletteHex(ci) { return (palette[ci] && palette[ci].hex) || '#ffffff'; }

  function finishJob(j) {
    if (j.started === false && j.start) j.start();
    j.finish();
  }

  // Fast-forward in-flight work WITHOUT re-applying the snapshot (visuals land
  // exactly on each job's own post-state, so a follow-up pour animates from
  // the correct pre-state). skip() = settleInFlight() + applySnapshot.
  function settleInFlight() {
    for (const tw of tweens.splice(0)) tw.cancel(true);
    camTween = null;
    if (activeJob) { finishJob(activeJob); activeJob = null; }
    while (jobQueue.length) finishJob(jobQueue.shift());
    if (queueResolve) { const r = queueResolve; queueResolve = null; r(); }
    for (const v of vesselViews) {
      v.animLocked = false;
      v.shakeT = -1;
      v.flashT = -1;
      v.lift.x = v.lift.target; v.lift.v = 0;
      v.glow.material.opacity = 0;
    }
    stream.visible = false;
    mood.dim = 1;
    camFx.zoom = 1;
  }

  function makePourJob(ev) {
    const src = vesselViews[ev.from];
    const dst = vesselViews[ev.to];
    const L = ev.layers;
    const dur = ANIM.LIFT + ANIM.TILT + L * ANIM.PER_LAYER + ANIM.UNTILT + ANIM.RETURN;
    let t = 0, started = false, done = false;
    let srcPre = null, srcPost = null, dstPre = null, dstPost = null;
    let hoverX = 0, hoverY = VESSEL.HOVER_Y, hoverZ = 0, dir = 1;

    const job = {
      started: false,
      start() {
        if (started) return;
        started = true; job.started = true;
        src.animLocked = true; dst.animLocked = true;
        src.lift.target = 0; src.lift.x = 0; src.lift.v = 0;
        srcPre = src.layers.slice();
        dstPre = dst.layers.slice();
        srcPost = srcPre.slice(0, Math.max(0, srcPre.length - L));
        dstPost = dstPre.concat(new Array(L).fill(ev.color));
        // Pre-set display arrays once; transfer progress is expressed purely via
        // syncLiquids(count, topScale) so the per-frame path allocates nothing.
        src.layers = srcPre;
        dst.layers = dstPost;
        hoverX = dst.root.position.x - src.root.position.x;
        hoverZ = dst.root.position.z - src.root.position.z;
        dir = hoverX !== 0 ? Math.sign(hoverX) : 1;
        streamMat.color.set(paletteHex(ev.color));
        streamMat.emissive.set(paletteHex(ev.color));
      },
      update(dt) {
        if (!started) job.start();
        t += dt;
        const t1 = ANIM.LIFT, t2 = t1 + ANIM.TILT, t3 = t2 + L * ANIM.PER_LAYER, t4 = t3 + ANIM.UNTILT;
        let moveK = 0, tiltK = 0;
        if (t < t1) {
          moveK = easeInOutCubic(t / t1);
        } else if (t < t2) {
          moveK = 1; tiltK = easeInOutCubic((t - t1) / ANIM.TILT);
        } else if (t < t3) {
          moveK = 1; tiltK = 1;
          const tt = t - t2;
          const n = Math.min(L - 1, Math.floor(tt / ANIM.PER_LAYER));
          const k = easeInOutCubic(clamp((tt - n * ANIM.PER_LAYER) / ANIM.PER_LAYER, 0, 1));
          syncLiquids(src, 1 - k, srcPre.length - n);
          syncLiquids(dst, k, dstPre.length + n + 1);
          // stream from tilted source mouth into the destination mouth
          const rz = src.body.rotation.z;
          tmpV1.set(
            src.root.position.x + src.body.position.x - VESSEL.GLASS_H * Math.sin(rz),
            src.root.position.y + src.body.position.y + VESSEL.GLASS_H * Math.cos(rz),
            src.root.position.z + src.body.position.z);
          tmpV2.set(dst.root.position.x, VESSEL.GLASS_H, dst.root.position.z);
          tmpV3.subVectors(tmpV2, tmpV1);
          const len = Math.max(0.001, tmpV3.length());
          stream.position.copy(tmpV1).addScaledVector(tmpV3, 0.5);
          stream.scale.set(0.045, len, 0.045);
          tmpQuat.setFromUnitVectors(UP_AXIS, tmpV3.normalize());
          stream.quaternion.copy(tmpQuat);
          stream.visible = true;
          spawnBurst(tmpV2.x, tmpV2.y, tmpV2.z, paletteHex(ev.color), 2, 0.25, -0.4, 2.2);
        } else if (t < t4) {
          moveK = 1; tiltK = 1 - easeInOutCubic((t - t3) / ANIM.UNTILT);
          if (stream.visible) stream.visible = false;
          if (src.layers !== srcPost) src.layers = srcPost;
          syncLiquids(src, 1);
          syncLiquids(dst, 1); // dst.layers already === dstPost; force full count
        } else {
          moveK = 1 - easeInOutCubic(clamp((t - t4) / ANIM.RETURN, 0, 1));
          tiltK = 0;
        }
        src.body.position.set(hoverX * moveK, hoverY * moveK, hoverZ * moveK);
        const tilt = -THREE.MathUtils.degToRad(VESSEL.TILT_DEG) * dir * tiltK;
        src.body.rotation.z = tilt;
        src.liquidGroup.rotation.z = -tilt; // liquid columns stay level (gravity)
        if (t >= dur) {
          job.finish();
          // mid event tier: vessel completion pulse (below round-completion)
          if (lastState && lastState.vessels[ev.to] && isUniformFull(lastState.vessels[ev.to])) {
            pulseVessel(ev.to);
          }
          return true;
        }
        return false;
      },
      finish() {
        if (done) return;
        done = true;
        if (!started) job.start();
        src.layers = srcPost; dst.layers = dstPost;
        syncLiquids(src, 1); syncLiquids(dst, 1);
        src.body.position.set(0, 0, 0);
        src.body.rotation.set(0, 0, 0);
        src.liquidGroup.rotation.set(0, 0, 0);
        src.animLocked = false; dst.animLocked = false;
        stream.visible = false;
      },
    };
    return job;
  }

  function isUniformFull(vesselArr) {
    if (vesselArr.length !== currentCapacity || vesselArr.length === 0) return false;
    return vesselArr.every((c) => c === vesselArr[0]);
  }

  function pulseVessel(i) {
    const v = vesselViews[i];
    if (!v) return;
    const m = v.glow.material;
    const tw = makeTween(ANIM.CELEB_PULSE, (k) => {
      m.opacity = k < 0.5 ? k * 2 * 0.85 : (1 - k) * 2 * 0.85;
    }, () => { m.opacity = 0; }, easeOutCubic);
    tweens.push(tw);
  }

  function makeCelebrationJob() {
    const n = vesselCount;
    const dur = n * ANIM.CELEB_STAGGER + ANIM.CELEB_PULSE + 250;
    let t = 0, started = false, done = false;
    const fired = new Set();
    const job = {
      started: false,
      start() {
        if (started) return;
        started = true; job.started = true;
        if (!reducedMotion) {
          const tw = makeTween(ANIM.CELEB_ZOOM_MS, (k) => {
            camFx.zoom = k < 0.5 ? 1 - 0.06 * (k * 2) : 0.94 + 0.06 * ((k - 0.5) * 2);
          }, () => { camFx.zoom = 1; });
          tweens.push(tw);
        }
      },
      update(dt) {
        if (!started) job.start();
        t += dt;
        for (let i = 0; i < n; i++) {
          if (!fired.has(i) && t >= i * ANIM.CELEB_STAGGER) {
            fired.add(i);
            pulseVessel(i);
            const v = vesselViews[i];
            const top = v.layers.length ? v.layers[v.layers.length - 1] : null;
            spawnBurst(v.root.position.x, VESSEL.GLASS_H * 0.8, v.root.position.z,
              top == null ? themeObj.accent : paletteHex(top), ANIM.BURST_COUNT, 0.5, 1.3, 0.9);
          }
        }
        if (t >= dur) { job.finish(); return true; }
        return false;
      },
      finish() {
        if (done) return;
        done = true;
        for (const v of vesselViews) v.glow.material.opacity = 0;
        camFx.zoom = 1;
      },
    };
    return job;
  }

  function makeAmbientCelebrationJob() {
    // Vessel-free celebration: camera ease + bursts scattered across the shelf.
    const bursts = 6;
    const dur = bursts * ANIM.CELEB_STAGGER + ANIM.CELEB_PULSE + 250;
    let t = 0, started = false, done = false;
    const fired = new Set();
    const spots = [];
    const job = {
      started: false,
      start() {
        if (started) return;
        started = true; job.started = true;
        for (let i = 0; i < bursts; i++) {
          spots.push({ x: (fxRng.next() * 2 - 1) * 3.2, y: 1.2 + fxRng.next() * 1.6, z: -0.5 + fxRng.next() });
        }
        if (!reducedMotion) {
          const tw = makeTween(ANIM.CELEB_ZOOM_MS, (k) => {
            camFx.zoom = k < 0.5 ? 1 - 0.06 * (k * 2) : 0.94 + 0.06 * ((k - 0.5) * 2);
          }, () => { camFx.zoom = 1; });
          tweens.push(tw);
        }
      },
      update(dt) {
        if (!started) job.start();
        t += dt;
        for (let i = 0; i < bursts; i++) {
          if (!fired.has(i) && t >= i * ANIM.CELEB_STAGGER) {
            fired.add(i);
            const s = spots[i];
            spawnBurst(s.x, s.y, s.z, palette.length ? paletteHex(i % palette.length) : themeObj.accent,
              ANIM.BURST_COUNT, 0.5, 1.3, 0.9);
          }
        }
        if (t >= dur) { job.finish(); return true; }
        return false;
      },
      finish() {
        if (done) return;
        done = true;
        camFx.zoom = 1;
      },
    };
    return job;
  }

  function makeFailJob() {
    let t = 0, started = false, done = false;
    const job = {
      started: false,
      start() {
        if (started) return;
        started = true; job.started = true;
        const tw = makeTween(ANIM.FAIL_DIM_MS, (k) => {
          mood.dim = k < 0.4 ? 1 - 0.45 * (k / 0.4) : 0.55 + 0.45 * ((k - 0.4) / 0.6);
        }, () => { mood.dim = 1; });
        tweens.push(tw);
      },
      update(dt) {
        if (!started) job.start();
        t += dt;
        if (t >= ANIM.FAIL_DIM_MS) { job.finish(); return true; }
        return false;
      },
      finish() {
        if (done) return;
        done = true;
        mood.dim = 1;
      },
    };
    return job;
  }

  // ---- markers: selection / preview / focus / invalid ---------------------------
  function refreshMarkers() {
    for (let i = 0; i < vesselViews.length; i++) {
      const v = vesselViews[i];
      if (i === selectedIndex) v.markerMode = 'selected';
      else if (previewSet.has(i)) v.markerMode = 'preview';
      else v.markerMode = 'none';
      v.rim.visible = i === selectedIndex;
      v.focusRing.visible = i === focusIndex;
    }
  }

  // ---- pointer input: tap-to-pick + subtle clamped camera drag ------------------
  const pointer = { id: null, downX: 0, downY: 0, downT: 0, dragging: false, lastX: 0, lastY: 0 };

  function eventNdc(e) {
    const rect = canvas.getBoundingClientRect();
    pointerNdc.set(
      ((e.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1,
      -((e.clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1);
    return pointerNdc;
  }

  function onPointerDown(e) {
    if (disposed || (e.pointerType === 'mouse' && e.button !== 0)) return;
    pointer.id = e.pointerId;
    pointer.downX = pointer.lastX = e.clientX;
    pointer.downY = pointer.lastY = e.clientY;
    pointer.downT = timeMs;
    pointer.dragging = false;
    try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* capture best-effort */ }
  }

  function onPointerMove(e) {
    if (pointer.id !== e.pointerId) return;
    const dx = e.clientX - pointer.lastX;
    const dy = e.clientY - pointer.lastY;
    pointer.lastX = e.clientX; pointer.lastY = e.clientY;
    if (!pointer.dragging) {
      const dist = Math.hypot(e.clientX - pointer.downX, e.clientY - pointer.downY);
      if (dist > TAP_DIST_PX) pointer.dragging = true;
    }
    if (pointer.dragging) {
      pan.tx = clamp(pan.tx - dx * CAM.PAN_SCALE, -CAM.PAN_CLAMP_X, CAM.PAN_CLAMP_X);
      pan.ty = clamp(pan.ty + dy * CAM.PAN_SCALE * 0.6, -CAM.PAN_CLAMP_Y, CAM.PAN_CLAMP_Y);
    }
  }

  function onPointerUp(e) {
    if (pointer.id !== e.pointerId) return;
    const wasDrag = pointer.dragging;
    const dt = timeMs - pointer.downT;
    const dist = Math.hypot(e.clientX - pointer.downX, e.clientY - pointer.downY);
    pointer.id = null;
    pointer.dragging = false;
    try { canvas.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    if (wasDrag || dist > TAP_DIST_PX || dt > TAP_TIME_MS) return;
    if (ambientOnly) return; // DOM board owns picking; no vessel hit proxies exist
    raycaster.setFromCamera(eventNdc(e), camera);
    const hits = raycaster.intersectObjects(hitProxies, false);
    // first hit belonging to a live vessel (pooled proxies of hidden vessels linger)
    let idx = -1;
    for (const h of hits) {
      const vi = h.object.userData.vesselIndex;
      if (vi < vesselCount) { idx = vi; break; }
    }
    if (idx >= 0) {
      pick(idx);
      // input acknowledgment: tiny glint (lowest event tier)
      if (!reducedMotion) {
        const v = vesselViews[idx];
        spawnBurst(v.root.position.x, VESSEL.GLASS_H, v.root.position.z,
          themeObj.accent, ANIM.GLINT_COUNT, 0.3, 0.5, 1.5);
      }
    } else {
      pick(null); // tap on empty space: report a miss (allows deselect)
    }
  }

  function onPointerCancel(e) {
    if (pointer.id !== e.pointerId) return;
    pointer.id = null;
    pointer.dragging = false; // cancel safely; no pick, no camera jump
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerCancel);
  canvas.addEventListener('lostpointercapture', onPointerCancel);

  // ---- graphics settings (live) ---------------------------------------------
  let motionOn = !reducedMotion;
  function applyMotion() {
    motionOn = !reducedMotion && gfx.background === 'animated';
  }

  function applyReflections(on) {
    if (on) {
      if (!envTex) {
        pmrem = pmrem || new THREE.PMREMGenerator(renderer);
        const room = new RoomEnvironment(renderer);
        envTex = pmrem.fromScene(room, 0.04).texture;
        room.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
      }
      scene.environment = envTex;
      // The room environment is far brighter than a candlelit shelf: diffuse
      // props take only a hint of it; glass and brass keep more.
      scene.traverse((o) => {
        if (!o.material) return;
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
          if ('envMapIntensity' in m) m.envMapIntensity = m.userData.envI ?? 0.15;
        }
      });
    } else {
      scene.environment = null;
    }
    brassMat.metalness = on ? 1 : 0.35;
    brassMat.roughness = on ? 0.32 : 0.5;
  }

  function markMaterialsDirty() {
    scene.traverse((o) => {
      if (!o.material) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.needsUpdate = true;
    });
  }

  function setGraphics(saved, detected = detectedPreset) {
    detectedPreset = detected || detectedPreset;
    gfx = resolveGraphics(saved, detectedPreset);
    const size = SHADOW_MAP[gfx.shadows];
    renderer.shadowMap.enabled = size > 0;
    keyLight.castShadow = size > 0;
    if (size > 0 && keyLight.shadow.mapSize.x !== size) {
      keyLight.shadow.mapSize.set(size, size);
      if (keyLight.shadow.map) { keyLight.shadow.map.dispose(); keyLight.shadow.map = null; }
    }
    pBudget = PARTICLE_BUDGET[gfx.particles];
    moteGeo.setDrawRange(0, MOTE_COUNT[gfx.particles]);
    motes.visible = MOTE_COUNT[gfx.particles] > 0;
    for (const v of vesselViews) {
      v.glass.material = gfx.detail === 'detailed' ? glassPhysMat : glassPhongMat;
      for (const lm of v.layerMeshes) lm.castShadow = size > 0;
    }
    applyDetail(gfx.detail === 'detailed');
    applyReflections(gfx.reflections === 'on');
    applyMotion();
    adaptiveScale = 1;
    frameTimes.length = 0;
    postKey = null; // rebuild the post chain on the next frame
    showFpsMeter(gfx.showFps);
    markMaterialsDirty(); // shadow-map and environment changes need recompiles
    updateSize(true);
  }

  // Legacy quality names still work ('high'|'medium'|'low').
  function setQuality(name) {
    const map = { high: 'high', medium: 'balanced', low: 'low', auto: 'auto' };
    if (map[name]) setGraphics({ preset: map[name] });
  }

  function showFpsMeter(on) {
    let meter = document.getElementById('cp-fps');
    if (on && !meter) {
      meter = document.createElement('div');
      meter.id = 'cp-fps';
      meter.className = 'cp-fps';
      meter.setAttribute('aria-hidden', 'true');
      meter.textContent = '— fps';
      document.body.append(meter);
    }
    if (meter) meter.hidden = !on;
  }

  function buildPost(w, h) {
    if (composer) { composer.dispose(); composer = null; }
    gradePass = null;
    if (!gfx.post || postFailed) return;
    const pr = pixelRatioNow;
    try {
      const target = new THREE.WebGLRenderTarget(Math.max(1, w * pr), Math.max(1, h * pr), {
        type: THREE.HalfFloatType, samples: gfx.antialias === 'msaa' ? 4 : 0,
      });
      const c = new EffectComposer(renderer, target);
      c.setPixelRatio(pr);
      c.setSize(w, h);
      c.addPass(new RenderPass(scene, camera));
      if (gfx.ao !== 'off') {
        const ao = new GTAOPass(scene, camera, w * pr, h * pr);
        ao.output = GTAOPass.OUTPUT.Default;
        ao.blendIntensity = 0.75;
        const hi = gfx.ao === 'high';
        ao.updateGtaoMaterial({ radius: 0.45, distanceExponent: 1.4, thickness: 1.2, scale: 1.0, samples: hi ? 16 : 8 });
        ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: hi ? 6 : 4, rings: 2, samples: hi ? 16 : 8 });
        c.addPass(ao);
      }
      if (gfx.bloom === 'on') {
        // High threshold: only the flame, orbs and glowing draughts bloom.
        c.addPass(new UnrealBloomPass(new THREE.Vector2(w, h), 0.6, 0.45, 0.9));
      }
      c.addPass(new OutputPass());
      if (gfx.grade === 'on') {
        gradePass = new ShaderPass(GradeShader);
        c.addPass(gradePass);
      }
      if (gfx.antialias === 'smaa') c.addPass(new SMAAPass(w * pr, h * pr));
      if (gfx.antialias === 'fxaa') {
        const fxaa = new ShaderPass(FXAAShader);
        fxaa.material.uniforms.resolution.value.set(1 / (w * pr), 1 / (h * pr));
        c.addPass(fxaa);
      }
      composer = c;
    } catch (_) {
      // Post-processing is an enhancement: render directly and let the panel say so.
      postFailed = true;
      composer = null;
    }
  }

  // Adaptive resolution: average ~90 frames; step down when slow, back up when fast.
  function adapt(dt) {
    frameTimes.push(dt);
    if (frameTimes.length < ADAPT.FRAMES) return false;
    let sum = 0;
    for (const f of frameTimes) sum += f;
    const avg = sum / frameTimes.length;
    frameTimes.length = 0;
    fpsNow = 1000 / Math.max(1, avg);
    const meter = document.getElementById('cp-fps');
    if (meter && !meter.hidden) meter.textContent = `${Math.round(fpsNow)} fps · ${Math.round(pixelRatioNow * 100) / 100}×`;
    if (!gfx.adaptive) return false;
    const before = adaptiveScale;
    if (avg > ADAPT.SLOW_MS) adaptiveScale = Math.max(ADAPT.MIN, adaptiveScale - ADAPT.DOWN);
    else if (avg < ADAPT.FAST_MS && adaptiveScale < 1) adaptiveScale = Math.min(1, adaptiveScale + ADAPT.UP);
    return before !== adaptiveScale;
  }

  // Size from the canvas' own box (the playfield), never the window, so the
  // scene is not stretched; pixel ratio = min(dpr, preset cap) × scale × adaptive.
  function updateSize(force) {
    const w = Math.max(1, Math.round(canvas.clientWidth || (container && container.clientWidth) || cssW));
    const h = Math.max(1, Math.round(canvas.clientHeight || (container && container.clientHeight) || cssH));
    const ratio = gfxPixelRatio(gfx, dprRaw, adaptiveScale);
    if (!force && w === cssW && h === cssH && ratio === pixelRatioNow) return;
    const sizeChanged = w !== cssW || h !== cssH;
    cssW = w; cssH = h;
    pixelRatioNow = ratio;
    renderer.setPixelRatio(ratio);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (sizeChanged) frameCamera(false);
  }

  function graphicsInfo() {
    return {
      gpu,
      detected: detectedPreset,
      resolved: { ...gfx },
      summary: describeGraphics(gfx, [Math.round(cssW * pixelRatioNow), Math.round(cssH * pixelRatioNow)]),
      pixels: [Math.round(cssW * pixelRatioNow), Math.round(cssH * pixelRatioNow)],
      fps: Math.round(fpsNow),
      adaptiveScale: Math.round(adaptiveScale * 100) / 100,
      postFailed,
      postActive: !!composer,
    };
  }

  // ---- public API -----------------------------------------------------------------

  function setState(state, events) {
    if (disposed || !state) return;
    lastState = state;
    currentCapacity = state.capacity || 4;
    if (ambientOnly) {
      // No vessel views to reconcile; scene-level events still play.
      if (events && events.length && !reducedMotion) api.playEvents(events).catch(() => {});
      return;
    }
    ensureVessels(state.vessels.length);
    if (events && events.length && !reducedMotion) {
      // playEvents fast-forwards any in-flight work to its own end state first,
      // so new pours animate from the correct visual pre-state.
      api.playEvents(events).catch(() => {});
    } else {
      settleInFlight();
      applySnapshot(state);
    }
  }

  function setSelected(i) {
    selectedIndex = typeof i === 'number' ? i : null;
    for (let vi = 0; vi < vesselViews.length; vi++) {
      vesselViews[vi].lift.target = vi === selectedIndex ? VESSEL.LIFT : 0;
    }
    refreshMarkers();
  }

  function previewTargets(from) {
    previewSet.clear();
    if (from == null || !lastState || !lastState.vessels[from]) {
      refreshMarkers();
      return [];
    }
    const src = lastState.vessels[from];
    const out = [];
    if (src.length) {
      const color = src[src.length - 1];
      for (let to = 0; to < lastState.vessels.length; to++) {
        if (to === from) continue;
        const d = lastState.vessels[to];
        if (d.length >= (lastState.capacity || 4)) continue;
        if (d.length === 0 || d[d.length - 1] === color) {
          previewSet.add(to);
          out.push(to);
        }
      }
    }
    refreshMarkers();
    return out;
  }

  function showInvalid(i, reason) {
    if (reducedMotion) return; // marker/shake suppressed; UI still explains
    const v = vesselViews[i];
    if (!v || i >= vesselCount) return;
    v.shakeT = 0;
    v.flashT = 0;
  }

  function playEvents(events, opts = {}) {
    if (disposed) return Promise.resolve();
    const instant = !!(opts && opts.instant) || reducedMotion;
    settleInFlight();
    if (ambientOnly) {
      if (!events || !events.length || instant) return Promise.resolve();
      const jobs = [];
      for (const e of events) {
        if (e && e.type === 'complete') jobs.push(makeAmbientCelebrationJob());
        else if (e && e.type === 'failed') jobs.push(makeFailJob());
      }
      if (!jobs.length) return Promise.resolve();
      return new Promise((resolve) => {
        queueResolve = resolve;
        jobQueue.push(...jobs);
      });
    }
    if (!lastState || !events || !events.length || instant) {
      if (lastState) applySnapshot(lastState);
      return Promise.resolve();
    }
    const jobs = [];
    for (const e of events) {
      if (e && e.type === 'pour') jobs.push(makePourJob(e));
    }
    for (const e of events) {
      if (e && e.type === 'complete') jobs.push(makeCelebrationJob());
      else if (e && e.type === 'failed') jobs.push(makeFailJob());
    }
    if (!jobs.length) {
      applySnapshot(lastState);
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      queueResolve = resolve;
      jobQueue.push(...jobs);
    });
  }

  function skip() {
    settleInFlight();
    if (lastState && !ambientOnly) applySnapshot(lastState);
  }

  function setReducedMotion(flag) {
    reducedMotion = !!flag;
    applyMotion();
    if (reducedMotion) { // cancel swoops/shakes immediately; timing logic preserved
      for (const v of vesselViews) { v.shakeT = -1; v.flashT = -1; }
      camFx.zoom = 1;
    }
  }

  function setTheme(newTheme, newPalette) {
    themeObj = newTheme || themeObj;
    if (newPalette) palette = newPalette;
    const w = themeObj.ambience !== 'cool';
    scene.background.set(themeObj.bg);
    scene.fog.color.set(themeObj.fog);
    keyLight.color.set(w ? 0xffd9a8 : 0xdceaff);
    rimLight.color.set(w ? 0x9fb8ff : 0xffe9c8);
    ambient.color.set(w ? 0xffe6c8 : 0xdde8ff);
    ambient.groundColor.set(w ? 0x2a1a10 : 0x101820);
    motes.material.color.set(w ? 0xffc890 : 0xcfe4ff);
    if (flameHalo) flameHalo.material.color.set(w ? 0xffa050 : 0xffc890);
    if (candleLight) candleLight.color.set(w ? 0xffb060 : 0xffc890);
    shelfMat.color.set(themeObj.shelf);
    rimMat.color.set(themeObj.accent);
    rimMat.emissive.set(themeObj.accent);
    if (orbMesh) orbMesh.material.emissive.set(themeObj.accent);
    for (const v of vesselViews) {
      v.markerRing.material.color.set(themeObj.accent);
      v.glow.material.color.set(themeObj.accent);
    }
    const oldTex = wallTex;
    wallTex = makeWallTexture(themeObj.bg);
    if (oldTex) oldTex.dispose();
    if (stoneTex) { stoneTex.map.dispose(); stoneTex.bump.dispose(); stoneTex = null; }
    applyDetail(gfx.detail === 'detailed');
    ensureLiquidMats();
    if (lastState) applySnapshot(lastState);
  }

  function projectVessel(i) {
    if (disposed || !lastState || i == null || i < 0 || i >= vesselCount) return null;
    const v = vesselViews[i];
    if (!v) return null;
    tmpV1.set(v.root.position.x, VESSEL.GLASS_H + v.lift.x, v.root.position.z);
    tmpV1.project(camera);
    return { x: (tmpV1.x * 0.5 + 0.5) * cssW, y: (-tmpV1.y * 0.5 + 0.5) * cssH };
  }

  function focusVessel(i) {
    focusIndex = typeof i === 'number' ? i : null;
    refreshMarkers();
  }

  // The canvas is measured from its own box; w/h are only a fallback before layout.
  function resize(w, h, dpr) {
    dprRaw = dpr || window.devicePixelRatio || 1;
    if (!canvas.clientWidth) { cssW = Math.max(1, w || cssW); cssH = Math.max(1, h || cssH); }
    updateSize(true);
    frameCamera(false); // instant re-fit; never a cumulative lerp
  }

  function setPaused(flag) { paused = !!flag; }

  // ---- frame pump ------------------------------------------------------------
  function renderFrame(dtMs) {
    if (disposed || paused) return; // paused/hidden: near-no-op, clocks frozen
    const dt = clamp(dtMs || 0, 0, MAX_DT_MS);
    if (dt <= 0) return;
    const dtS = dt / 1000;
    timeMs += dt;
    if (motionOn) ambMs += dt; // ambient decor clock; frozen under reduced motion / static
    if (adapt(dt)) updateSize(true);
    else updateSize(false);

    // tweens (authored duration + easing, interruptible)
    for (let i = tweens.length - 1; i >= 0; i--) {
      const tw = tweens[i];
      if (tw.dead) { tweens.splice(i, 1); continue; }
      tw.t += dt;
      const k = tw.t >= tw.dur ? 1 : tw.ease(clamp(tw.t / tw.dur, 0, 1));
      tw.update(k);
      if (tw.t >= tw.dur) {
        tweens.splice(i, 1);
        if (!tw.dead) { tw.dead = true; if (tw.done) tw.done(); }
      }
    }

    // animation jobs
    if (!activeJob && jobQueue.length) {
      activeJob = jobQueue.shift();
      if (activeJob.start) activeJob.start();
    }
    if (activeJob && activeJob.update(dt)) activeJob = null;
    if (!activeJob && !jobQueue.length && queueResolve) {
      const r = queueResolve; queueResolve = null; r();
    }

    // per-vessel springs, shakes, marker pulses
    for (let i = 0; i < vesselCount; i++) {
      const v = vesselViews[i];
      if (!v.animLocked) {
        springStep(v.lift, 12, dtS);
        let sx = 0;
        if (v.shakeT >= 0) {
          v.shakeT += dt;
          if (v.shakeT >= ANIM.INVALID_MS) v.shakeT = -1;
          else {
            const k = v.shakeT / ANIM.INVALID_MS;
            sx = ANIM.INVALID_AMP * (1 - k) * Math.sin(k * Math.PI * 8);
          }
        }
        v.body.position.set(sx, v.lift.x, 0);
      }
      if (v.flashT >= 0) {
        v.flashT += dt;
        if (v.flashT >= ANIM.INVALID_MS) v.flashT = -1;
      }
      // grounded marker ring: selection / preview / invalid flash
      const ring = v.markerRing;
      if (v.flashT >= 0) {
        ring.visible = true;
        ring.material.color.set(0xff4444);
        ring.material.opacity = 0.95 * (1 - v.flashT / ANIM.INVALID_MS);
      } else if (v.markerMode === 'selected') {
        ring.visible = true;
        ring.material.color.set(themeObj.accent);
        ring.material.opacity = 0.9;
      } else if (v.markerMode === 'preview') {
        ring.visible = true;
        ring.material.color.set(themeObj.accent);
        ring.material.opacity = 0.45 + 0.3 * Math.sin(timeMs * 0.006 + i * 1.7);
      } else {
        ring.visible = false;
        ring.material.opacity = 0;
      }
    }

    updateParticles(dtS);

    // decorative candle flicker, orb bob, motes (seeded phases; ambient clock)
    const a = ambMs;
    if (flameSprite) {
      const f = 1 + 0.13 * Math.sin(a * 0.013 + flamePhase) + 0.08 * Math.sin(a * 0.0073 + flamePhase * 2);
      flameSprite.scale.set(0.16 * f, 0.24 * (2 - f) * 0.5 + 0.12, 1);
      flameSprite.material.opacity = 0.75 + 0.2 * Math.sin(a * 0.011 + flamePhase);
      const flick = 0.9 + 0.15 * Math.sin(a * 0.012 + flamePhase);
      if (candleLight) candleLight.intensity = 5 * flick * mood.dim;
      if (flameHalo) flameHalo.material.opacity = 0.3 * flick * mood.dim;
    }
    if (motionOn || !orbsPlaced) {
      orbsPlaced = true;
      // hanging orb bob (instanced; matrices rewritten from base data, no allocation)
      if (orbMesh) {
        for (let i = 0; i < orbBase.length; i++) {
          const o = orbBase[i];
          tmpMat4.makeTranslation(o.x, o.y + Math.sin(a * 0.0009 + o.phase) * o.amp, o.z);
          orbMesh.setMatrixAt(i, tmpMat4);
        }
        orbMesh.instanceMatrix.needsUpdate = true;
      }
      if (motes.visible) updateMotes(a / 1000);
      for (let i = 0; i < flaskLiquids.length; i++) {
        flaskLiquids[i].emissiveIntensity = 0.55 + 0.15 * Math.sin(a * 0.0015 + i * 2.1);
      }
    }

    // light dim for 'failed'
    ambient.intensity = baseIntensity.ambient * mood.dim;
    keyLight.intensity = baseIntensity.key * mood.dim;
    rimLight.intensity = baseIntensity.rim * mood.dim;

    // camera: authored base + clamped user pan + celebration zoom
    springStepPan(dtS);
    const pitch = THREE.MathUtils.degToRad(CAM.PITCH_DEG);
    const d = camBase.dist * camFx.zoom;
    camera.position.set(pan.x, CAM.LOOK_Y + d * Math.sin(pitch) + pan.y, d * Math.cos(pitch));
    camera.lookAt(pan.x * 0.6, CAM.LOOK_Y + pan.y * 0.5, 0);

    drawScene(dtS);
  }

  function drawScene(dtS) {
    const key = gfx.post && !postFailed
      ? [gfx.ao, gfx.bloom, gfx.grade, gfx.antialias, cssW, cssH, pixelRatioNow].join('|') : 'none';
    if (key !== postKey) {
      postKey = key;
      buildPost(cssW, cssH);
    }
    if (composer) {
      try { composer.render(dtS); return; } catch (_) {
        postFailed = true;
        composer.dispose();
        composer = null;
      }
    }
    renderer.render(scene, camera);
  }

  const panSpring = { x: 0, v: 0, target: 0 };
  const panSpringY = { x: 0, v: 0, target: 0 };
  function springStepPan(dtS) {
    panSpring.target = pan.tx; panSpringY.target = pan.ty;
    springStep(panSpring, 8, dtS);
    springStep(panSpringY, 8, dtS);
    pan.x = panSpring.x; pan.y = panSpringY.x;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerup', onPointerUp);
    canvas.removeEventListener('pointercancel', onPointerCancel);
    canvas.removeEventListener('lostpointercapture', onPointerCancel);
    settleInFlight();
    scene.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          if (m.map) m.map.dispose();
          m.dispose();
        }
      }
    });
    for (const g of badgeGeoCache.values()) g.dispose();
    badgeGeoCache.clear();
    if (composer) { composer.dispose(); composer = null; }
    if (envTex) envTex.dispose();
    if (pmrem) pmrem.dispose();
    if (stoneTex) { stoneTex.map.dispose(); stoneTex.bump.dispose(); }
    wallTex.dispose();
    woodTex.dispose();
    dotTex.dispose();
    const meter = document.getElementById('cp-fps');
    if (meter) meter.hidden = true;
    renderer.dispose();
  }

  const api = {
    setState, setSelected, previewTargets, showInvalid, playEvents, skip,
    setQuality, setGraphics, graphicsInfo, setReducedMotion, setTheme, projectVessel, focusVessel,
    resize, renderFrame, setPaused, dispose,
  };

  // Prewarm: apply graphics, compile shaders and render one warm frame so play has no hitches.
  setGraphics(graphics, detectedPreset);
  frameCamera(false);
  camera.position.set(0, CAM.LOOK_Y + camBase.dist * Math.sin(THREE.MathUtils.degToRad(CAM.PITCH_DEG)),
    camBase.dist * Math.cos(THREE.MathUtils.degToRad(CAM.PITCH_DEG)));
  camera.lookAt(0, CAM.LOOK_Y, 0);
  renderer.compile(scene, camera);
  drawScene(0);

  return api;
}
