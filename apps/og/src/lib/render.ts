/**
 * workers-og render pipeline (JSX element -> PNG).
 *
 * Cloudflare Workers forbid runtime `WebAssembly.compile()` /
 * `WebAssembly.instantiate(bytes, …)`. Satori's Yoga layout step and resvg
 * both need wasm, and the previous `satori/standalone` + `@cf-wasm/resvg`
 * pipeline tripped `CompileError: Wasm code generation disallowed by embedder`
 * on workerd because Yoga instantiated its module from raw bytes at runtime.
 *
 * `workers-og` bundles pre-compiled satori/yoga/resvg and imports each `.wasm`
 * as a module (`import mod from "./x.wasm"`), which wrangler resolves to a
 * `WebAssembly.Module` via the `CompiledWasm` rule in `wrangler.toml`. Workers
 * accept `WebAssembly.instantiate(module, imports)` — only the bytes form is
 * banned — so the whole pipeline runs on the edge.
 *
 * We drive it through `ImageResponse` (format `"png"`) and lift the raw PNG
 * bytes back out, so this module keeps ownership of the response headers
 * (`pngResponse`) and the render-timeout contract (`OgRenderTimeoutError`).
 * The card templates are unchanged: they still emit satori's `{ type, props }`
 * element shape, which `ImageResponse` forwards straight to satori whenever
 * the element is not an HTML string.
 */
import { ImageResponse } from "workers-og";
import type { SatoriFont } from "./fonts.js";
import type { JsxNode } from "../jsx/jsx-runtime.js";

export interface RenderOptions {
  width: number;
  height: number;
  fonts: SatoriFont[];
}

/** Hard cap on the full render pipeline. */
export const RENDER_TIMEOUT_MS = 8_000;

/** Sentinel thrown when the render pipeline exceeds RENDER_TIMEOUT_MS. Callers should map to 503. */
export class OgRenderTimeoutError extends Error {
  override readonly name = "OG_RENDER_TIMEOUT";
  constructor(message = "og render timed out") {
    super(message);
  }
}

export async function renderPng(tree: JsxNode, opts: RenderOptions): Promise<Uint8Array> {
  return raceWithTimeout(runPipeline(tree, opts), RENDER_TIMEOUT_MS);
}

async function runPipeline(tree: JsxNode, opts: RenderOptions): Promise<Uint8Array> {
  // workers-og forwards a non-string `element` straight to satori, so our
  // existing JsxNode templates render unchanged. `format: "png"` runs the
  // full satori -> resvg pipeline; the ImageResponse body is the PNG.
  const response = new ImageResponse(tree as unknown as ConstructorParameters<typeof ImageResponse>[0], {
    width: opts.width,
    height: opts.height,
    fonts: opts.fonts,
    format: "png",
  });
  // A render failure inside workers-og rejects the response stream, so this
  // await surfaces it as a thrown error (mapped to 500 by the router in
  // index.ts). A timeout is handled by raceWithTimeout above.
  const buf = await response.arrayBuffer();
  const png = new Uint8Array(buf);
  if (png.byteLength === 0) throw new Error("og render produced an empty PNG");
  return png;
}

function raceWithTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new OgRenderTimeoutError()), ms);
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export function pngResponse(png: Uint8Array): Response {
  // Guarantee a tight ArrayBuffer view so Response gets a BodyInit it likes.
  const buf = png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer;
  return new Response(buf, {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=600, s-maxage=1800",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/** 503 + Retry-After returned by the router when the render pipeline times out. */
export function renderTimeoutResponse(): Response {
  return new Response("og render timed out", {
    status: 503,
    headers: {
      "Content-Type": "text/plain",
      "Retry-After": "30",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
