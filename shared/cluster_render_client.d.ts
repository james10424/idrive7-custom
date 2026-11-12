// Types for cluster_render_client.js (cluster-render's Node client, kept as upstream wrote it apart from the marked
// idrive7-custom changes, so its types live here instead of in JSDoc there). From its comments and PROTOCOL.md.
// Editor types only: the build leaves .d.ts files out.
import { EventEmitter } from "events";

/** A rectangle in a layer's px. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** What every layer takes (PROTOCOL.md), plus each kind's own fields. */
export interface LayerOpts {
  /** "panel" (the instrument cluster) or "hud" (the windshield) */
  target: "panel" | "hud" | string;
  klass?: string;
  z?: number;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  visible?: boolean;
  exclusive?: boolean;
  prewarm?: boolean;
  contend?: boolean;
  guide_hold?: boolean;
  yield?: boolean;
  opacity?: number;
  rotate?: number;
  sx?: number;
  sy?: number;
  px?: number;
  py?: number;
  /** an image's size, default its w and h */
  iw?: number;
  ih?: number;
  /** an effect's fragment shader (GLSL ES 1.00) */
  fs?: string;
  /** an effect: u_time from the renderer's own clock */
  time?: boolean;
  time_fps?: number;
  [field: string]: unknown;
}

/** An asset (a texture a layer samples). */
export interface AssetOpts {
  target: "panel" | "hud" | string;
  /** etc2rgba: ETC2 RGBA, w and h multiples of 4, (w/4)*(h/4)*16 bytes sent whole (cluster-render 0.5.9) */
  format: "rgba8" | "r8" | "etc2rgba";
  /** up to 2048 */
  w: number;
  h: number;
  sampling?: "nearest" | "bilinear";
  wrap?: "clamp" | "repeat";
}

/** A scene file as the target's scene (PROTOCOL.md "Scene files"). */
export interface SceneOpts {
  target: "panel" | "hud" | string;
  /** an absolute path */
  file: string;
  /** its resource files' paths */
  res?: string[];
  /** hex SHA-256s: the file's, then each resource file's */
  sha256?: string | string[];
  contend?: boolean;
}

export interface UniformOpts {
  type?: "float" | "vec2" | "vec3" | "vec4" | "mat4";
  /** a mesh layer's part */
  part?: number;
}

/** An image layer's pixels as the client last set them (imageOf). */
export interface LayerImage {
  image: Buffer;
  iw: number;
  ih: number;
  bpp: number;
}

export class ClusterRender extends EventEmitter {
  /** app: the app's id (its layers' owner); socketPath: default DEFAULT_PATH */
  constructor(app: string, socketPath?: string);
  app: string;
  path: string;
  /** connected and every layer sent */
  ready: boolean;
  closed: boolean;
  /** what the service reported it renders with, and its targets */
  backend: string;
  targets: string;

  connect(): void;
  close(): void;

  /** Layers: each returns its ref, 0 when refused. */
  video(opts: LayerOpts): number;
  image(opts: LayerOpts): number;
  effect(opts: LayerOpts): number;
  mesh(opts: LayerOpts): number;
  asset(opts: AssetOpts): number;
  scene(opts: SceneOpts): number;
  /** Another file for a scene, in place: false when it isn't one. */
  replace(ref: number, opts: SceneOpts): boolean;
  /** A scene's edit lines, kept by their key and sent again after a reconnect. */
  edit(ref: number, lines: string | string[]): boolean;
  /** Changes a layer's fields (visible, x, rotate, ...). */
  set(ref: number, opts: Partial<LayerOpts>): void;
  /** A uniform's value: a number, or up to 1024 numbers (whole elements of opts.type). */
  uniform(ref: number, name: string, values: number | number[], opts?: UniformOpts): void;
  /** A sampler's asset. */
  bind(ref: number, sampler: string, asset: number, part?: number): void;
  /** A mesh part's shaders and state: vs, fs, cull ("back", "front", "none"), blend ("alpha", "add", "none"). */
  part(ref: number, part: number, opts: Record<string, unknown>): void;
  /** A mesh part's geometry: positions, normals, uvs, colors per vertex, indices (triangles); at most once a second. */
  geometry(ref: number, part: number, g: Record<string, number[]>): void;
  /** A mesh part's transform; false, and nothing sent, when a value is out of range. */
  transform(ref: number, part: number, t: Record<string, number | number[]>): boolean;
  /** An animation (part, property or name, keys, loop, interp): its number, 0 when refused. */
  animate(ref: number, opts: Record<string, unknown>): number;
  stop(ref: number, anim: number): void;
  /** A layer or an asset (an asset a layer samples stays). */
  drop(ref: number): void;
  frameBytes(ref: number): number;
  /** A video frame: the whole 4:2:0 atlas; false while not connected. */
  frame(ref: number, atlas: Buffer, id: number): boolean;
  /** An image layer's pixels as last set, for diffing; null for another kind of layer. Read only. */
  imageOf(ref: number): LayerImage | null;
  /** An image or asset update: rects with their rows packed one after another in px, or null and the whole image. */
  pixels(ref: number, rects: Rect[] | null, px: Buffer): void;
  /** Asks the service for its status line (the "status" event). */
  status(): void;

  on(event: "ready" | "disconnected", fn: () => void): this;
  /** shown, waiting, suspended, stalled, hidden, error */
  on(event: "layer", fn: (ref: number, state: string, reason?: string) => void): this;
  on(
    event: "target",
    fn: (name: string, state: string, holder?: string, reason?: string, guideDisabled?: boolean, disabled?: boolean) => void,
  ): this;
  on(event: "budget", fn: (capKb: number, maxKb: number, reason?: string) => void): this;
  on(event: "refused", fn: (op: string, ref: number, reason?: string, line?: string) => void): this;
  on(event: "status", fn: (text: string) => void): this;
  on(event: string, fn: (...args: any[]) => void): this;
}

export const DEFAULT_PATH: string;
