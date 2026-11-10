/**
 * A water buffalo's head in 3D, in the vector-display look of the human heads: wire cross-sections
 * lofted along the skull, the jaw, the neck and the horns, with the airway inside lit by the
 * pressure the engine recorded. The jaw hangs on a hinge and swings with the `mouth` parameter; the
 * nostrils open with `nasal`; the whole figure brightens and the throat swells with the sound.
 *
 * Units are centimetres, the face looks along +x, y is up and z is across. `update` takes one
 * recorded frame (or none, for a head at rest) and `render` is left to the caller's WebGLRenderer.
 */
import * as THREE from "three";
import { V, heat } from "../colors.ts";
import type { CreatureFrame } from "../../show/ctele.ts";

const N = 18; // points round each cross-section

interface Ring {
  x: number;
  /** centre height, and half-height and half-width */
  cy: number;
  ry: number;
  rz: number;
}

const ring = (x: number, top: number, bottom: number, half: number): Ring => ({ x, cy: (top + bottom) / 2, ry: (top - bottom) / 2, rz: half });

// the skull and muzzle, from the back of the poll to the nose (x, top, bottom of the cross-section, half-width)
const SKULL: Ring[] = [
  ring(-30, 30, -8, 22), ring(-20, 36, -6, 24), ring(-10, 38, -4, 23), ring(0, 34, -3, 20), ring(10, 26, -3, 16),
  ring(20, 18, -3, 12), ring(30, 12, -3, 10), ring(40, 8, -3, 9), ring(48, 6, -4, 9.5), ring(54, 3, -5, 8),
];
// the lower jaw, hung on a hinge at (−6, −6): its rings are cut at the closed position
const JAW: Ring[] = [ring(-4, -3, -20, 14), ring(4, -3, -24, 13), ring(12, -3, -24, 11), ring(20, -3, -20, 10), ring(28, -3, -14, 9), ring(36, -3, -10, 8.5), ring(44, -3, -8, 8), ring(50, -3, -7, 7)];
const HINGE: [number, number] = [-6, -6];
// the neck, swelling back from the poll to the shoulders
const NECK: Ring[] = [ring(-30, 30, -8, 22), ring(-42, 26, -22, 25), ring(-54, 18, -40, 28), ring(-66, 6, -58, 30), ring(-78, -8, -72, 32)];
// the airway, as polylines of points (a tube's nodes are spread along its path)
const TRACHEA: [number, number, number][] = [[-76, -50, 0], [-58, -40, 0], [-40, -26, 0], [-22, -14, 0], [-8, -8, 0]];
const PHARYNX: [number, number, number][] = [[-8, -8, 0], [-2, -5, 0], [4, -4, 0]];
const ORAL: [number, number, number][] = [[4, -4, 0], [28, -4, 0], [52, -4, 0]];
const NASAL: [number, number, number][] = [[4, 0, 0], [24, 2, 0], [40, 2, 0], [54, 1.5, 0]];

function lerpPath(path: [number, number, number][], u: number): [number, number, number] {
  const f = Math.min(1, Math.max(0, u)) * (path.length - 1);
  const i = Math.min(path.length - 2, Math.floor(f));
  const t = f - i;
  return [0, 1, 2].map((k) => path[i][k] + (path[i + 1][k] - path[i][k]) * t) as [number, number, number];
}

/** the points of each ring, round the loft's axis */
function loft(rings: Ring[]): [number, number, number][][] {
  return rings.map((r) => Array.from({ length: N }, (_, k) => [r.x, r.cy + r.ry * Math.cos((2 * Math.PI * k) / N), r.rz * Math.sin((2 * Math.PI * k) / N)] as [number, number, number]));
}

/** segment index pairs for a loft: each ring closed, and every other point joined along its length */
function loftEdges(rings: number): [number, number][] {
  const e: [number, number][] = [];
  for (let i = 0; i < rings; i++) for (let k = 0; k < N; k++) e.push([i * N + k, i * N + ((k + 1) % N)]);
  for (let i = 0; i + 1 < rings; i++) for (let k = 0; k < N; k += 2) e.push([i * N + k, (i + 1) * N + k]);
  return e;
}

/** a line object whose points can be moved; `edges` pair them up */
class Wire {
  readonly obj: THREE.LineSegments;
  private readonly pos: Float32Array;
  constructor(private readonly edges: [number, number][], npts: number, mat: THREE.LineBasicMaterial) {
    this.pos = new Float32Array(edges.length * 6);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(this.pos, 3));
    this.obj = new THREE.LineSegments(g, mat);
    this.obj.frustumCulled = false;
    void npts;
  }
  set(points: [number, number, number][]): void {
    this.edges.forEach(([a, b], i) => {
      this.pos.set(points[a], i * 6);
      this.pos.set(points[b], i * 6 + 3);
    });
    (this.obj.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
  }
}

const flat = (loops: [number, number, number][][]) => loops.flat();

export class Buffalo3D {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(28, 1, 10, 2400);
  /** 1: the face looks to the right of the screen, −1: to the left */
  facing: 1 | -1 = 1;
  private readonly root = new THREE.Group();
  private readonly jaw: Wire;
  private readonly jawBase: [number, number, number][];
  private readonly neck: Wire;
  private readonly neckBase: [number, number, number][];
  private readonly nostrils: THREE.LineSegments[] = [];
  private readonly mats: THREE.LineBasicMaterial[] = [];
  private readonly air: THREE.Points;
  private readonly airPts: { path: [number, number, number][]; name: string; n: number }[];
  private readonly airColor: THREE.BufferAttribute;
  private readonly airPos: THREE.BufferAttribute;
  /** the loudest pressure seen lately, so the colours keep their range whatever the level */
  private peak = 1e-9;
  private level = 0;
  private time = 0;
  private yaw = 0;
  private tubes: Record<string, { areas: Float32Array; rms: Float32Array }> | null = null;

  constructor() {
    const mat = (color: string, opacity: number) => {
      const m = new THREE.LineBasicMaterial({ color: new THREE.Color(color), transparent: true, opacity, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending });
      this.mats.push(m);
      return m;
    };
    const skullPts = flat(loft(SKULL));
    const skull = new Wire(loftEdges(SKULL.length), skullPts.length, mat(V.blue, 0.55));
    skull.set(skullPts);
    this.root.add(skull.obj);
    this.jawBase = flat(loft(JAW));
    this.jaw = new Wire(loftEdges(JAW.length), this.jawBase.length, mat(V.blueMid, 0.8));
    this.jaw.set(this.jawBase);
    this.root.add(this.jaw.obj);
    this.neckBase = flat(loft(NECK));
    this.neck = new Wire(loftEdges(NECK.length), this.neckBase.length, mat(V.blueDim, 0.7));
    this.neck.set(this.neckBase);
    this.root.add(this.neck.obj);

    // horns: rings along a swept curve, thinning to the tip, one each side
    const hornMat = mat(V.blue, 0.75);
    for (const s of [1, -1]) {
      const curve = new THREE.CatmullRomCurve3([[-8, 34, 22], [-12, 38, 38], [-22, 44, 52], [-32, 56, 46], [-34, 70, 32], [-28, 78, 22]].map(([x, y, z]) => new THREE.Vector3(x, y, z * s)));
      const steps = 14;
      const fr = curve.computeFrenetFrames(steps, false);
      const pts: [number, number, number][] = [];
      for (let i = 0; i <= steps; i++) {
        const c = curve.getPoint(i / steps);
        const r = 6.5 * (1 - i / steps) + 0.8;
        for (let k = 0; k < 10; k++) {
          const a = (2 * Math.PI * k) / 10;
          const p = c.clone().addScaledVector(fr.normals[i], r * Math.cos(a)).addScaledVector(fr.binormals[i], r * Math.sin(a));
          pts.push([p.x, p.y, p.z]);
        }
      }
      const edges: [number, number][] = [];
      for (let i = 0; i <= steps; i++) for (let k = 0; k < 10; k++) edges.push([i * 10 + k, i * 10 + ((k + 1) % 10)]);
      for (let i = 0; i < steps; i++) for (let k = 0; k < 10; k += 3) edges.push([i * 10 + k, (i + 1) * 10 + k]);
      const w = new Wire(edges, pts.length, hornMat);
      w.set(pts);
      this.root.add(w.obj);
      // an ear below each horn, drooping outward
      const ear: [number, number, number][] = Array.from({ length: 14 }, (_, k) => {
        const a = (2 * Math.PI * k) / 14;
        return [-14 + 6 * Math.cos(a) * 0.4 - 5 * Math.sin(a) * 0, 24 - 7 + 9 * Math.cos(a) - 2, s * (30 + 10 * (1 + Math.sin(a)) * 0.9)] as [number, number, number];
      });
      const earW = new Wire(ear.map((_, k) => [k, (k + 1) % 14] as [number, number]), ear.length, hornMat);
      earW.set(ear);
      this.root.add(earW.obj);
      // an eye, and a nostril
      const circle = (cx: number, cy: number, cz: number, r: number, nx: boolean): [number, number, number][] =>
        Array.from({ length: 12 }, (_, k) => {
          const a = (2 * Math.PI * k) / 12;
          return nx ? [cx, cy + r * Math.cos(a), cz + r * Math.sin(a)] : [cx + r * Math.cos(a), cy + r * Math.sin(a), cz];
        });
      const eye = circle(26, 17, s * 15.5, 2.4, false);
      const eyeW = new Wire(eye.map((_, k) => [k, (k + 1) % 12] as [number, number]), 12, mat(V.white, 0.9));
      eyeW.set(eye);
      this.root.add(eyeW.obj);
      const nos = circle(53.5, 3, s * 4.2, 2.2, true);
      const nW = new Wire(nos.map((_, k) => [k, (k + 1) % 12] as [number, number]), 12, mat(V.pink, 0.9));
      nW.set(nos);
      nW.obj.position.set(0, 0, 0);
      this.nostrils.push(nW.obj);
      this.root.add(nW.obj);
    }

    // the airway: a dot at each node of each tube, coloured by the sound pressure there
    this.airPts = [
      { path: TRACHEA, name: "trachea", n: 43 },
      { path: PHARYNX, name: "pharynx", n: 14 },
      { path: ORAL, name: "oral", n: 25 },
      { path: NASAL, name: "nasal", n: 27 },
    ];
    const total = this.airPts.reduce((s, t) => s + t.n, 0);
    const g = new THREE.BufferGeometry();
    this.airPos = new THREE.BufferAttribute(new Float32Array(total * 3), 3);
    this.airColor = new THREE.BufferAttribute(new Float32Array(total * 3), 3);
    g.setAttribute("position", this.airPos);
    g.setAttribute("color", this.airColor);
    this.air = new THREE.Points(g, new THREE.PointsMaterial({ size: 3, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0.95, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending }));
    this.air.frustumCulled = false;
    this.root.add(this.air);
    this.scene.add(this.root);
    this.layoutAir(0);
    this.root.position.set(-10, -8, 0);
    this.place(0);
  }

  /** the tube dots along their paths; the oral tube's floor drops with the jaw */
  private layoutAir(jawAngle: number): void {
    let i = 0;
    for (const t of this.airPts) {
      for (let k = 0; k < t.n; k++) {
        const p = lerpPath(t.path, t.n === 1 ? 0 : k / (t.n - 1));
        // the mouth's dots sit midway between the palate and the swinging jaw
        const drop = t.name === "oral" ? Math.sin(jawAngle) * (p[0] - HINGE[0]) * 0.5 : 0;
        this.airPos.setXYZ(i++, p[0], p[1] - drop, p[2]);
      }
    }
    this.airPos.needsUpdate = true;
  }

  resize(w: number, h: number): void {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private place(t: number): void {
    // a slow turn about the head, toward the face and back, as the duet's other heads orbit
    const swing = 0.52 + 0.32 * Math.sin(t * 0.35);
    this.yaw += (swing - this.yaw) * 0.2;
    // far enough that the whole head, horns to nose, fits the panel's width as well as its height
    const d = Math.max(300, 86 / (Math.tan((this.camera.fov * Math.PI) / 360) * this.camera.aspect));
    this.camera.position.set(d * Math.sin(this.yaw), 28, d * Math.cos(this.yaw));
    this.camera.lookAt(0, 0, 0);
    this.root.scale.x = this.facing;
    this.camera.position.x *= this.facing;
    this.camera.lookAt(0, 0, 0);
  }

  /** a frame of recorded telemetry, or null: the head at rest */
  update(f: CreatureFrame | null, dt: number): void {
    this.time += dt;
    const mouth = f ? Math.min(1, Math.max(0, f.params.mouth ?? 0.5)) : 0.05;
    const nasal = f ? Math.min(1, Math.max(0, f.params.nasal ?? 0.3)) : 0.1;
    const angle = 0.52 * mouth;
    // the jaw turns on its hinge
    const c = Math.cos(angle), s = Math.sin(angle);
    this.jaw.set(this.jawBase.map(([x, y, z]) => [HINGE[0] + (x - HINGE[0]) * c + (y - HINGE[1]) * s, HINGE[1] - (x - HINGE[0]) * s + (y - HINGE[1]) * c, z] as [number, number, number]));
    this.layoutAir(angle);
    // the sound: how loud the output is, against the loudest lately
    const raw = f ? f.outRms : 0;
    this.peak = Math.max(this.peak * 0.9995, raw, 1e-9);
    const target = f ? Math.min(1, raw / this.peak) * Math.min(1, f.gate) : 0;
    this.level += (target - this.level) * 0.35;
    // the throat swells with the breath, and the whole figure brightens with the sound
    const swell = 1 + 0.05 * this.level;
    this.neck.set(this.neckBase.map(([x, y, z]) => [x, y, z * swell] as [number, number, number]));
    this.mats.forEach((m, i) => (m.opacity = Math.min(1, [0.55, 0.8, 0.7, 0.75, 0.9, 0.9][i % 6] * (0.7 + 0.5 * this.level))));
    for (const n of this.nostrils) n.scale.set(1, 1 + 0.9 * nasal, 1 + 0.9 * nasal);
    this.tubes = f ? f.tubes : null;
    // the airway's colours: a dim blue where it is quiet, heat colours as the pressure grows
    let i = 0;
    const col = new THREE.Color();
    let loud = 1e-9;
    if (this.tubes) for (const t of this.airPts) for (const v of this.tubes[t.name]?.rms ?? []) loud = Math.max(loud, v);
    this.peak = Math.max(this.peak, 0);
    for (const t of this.airPts) {
      const rms = this.tubes?.[t.name]?.rms;
      for (let k = 0; k < t.n; k++) {
        const u = rms ? Math.min(1, Math.sqrt((rms[k] ?? 0) / loud)) * this.level : 0;
        col.set(u < 0.04 ? V.blueDim : heat(u));
        this.airColor.setXYZ(i++, col.r, col.g, col.b);
      }
    }
    this.airColor.needsUpdate = true;
    this.place(this.time);
  }

  dispose(): void {
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose?.();
      (m.material as THREE.Material | undefined)?.dispose?.();
    });
  }
}
