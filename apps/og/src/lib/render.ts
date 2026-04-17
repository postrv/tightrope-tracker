/**
 * Satori -> resvg-wasm -> PNG pipeline.
 *
 * We lazy-init the wasm module on first use and keep the promise on module
 * scope so subsequent renders skip initialisation. The wasm bytes are bundled
 * into the worker via the `wasm` import (wrangler handles the module import).
 */
import satori from "satori";
// @cf-wasm/resvg is a drop-in replacement for @resvg/resvg-wasm specifically
// built for Cloudflare Workers: the wasm module is pre-compiled and wired up
// at import time, which avoids the runtime WebAssembly.compile() that Workers
// forbids. No explicit initWasm() call is needed.
import { Resvg } from "@cf-wasm/resvg";
import type { SatoriFont } from "./fonts.js";
import type { JsxNode } from "../jsx/jsx-runtime.js";

export interface RenderOptions {
  width: number;
  height: number;
  fonts: SatoriFont[];
}

/** Satori output longer than this is almost certainly pathological -- refuse to rasterise. */
export const MAX_SVG_BYTES = 2_000_000;
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
  const svg = await satori(tree as unknown as Parameters<typeof satori>[0], {
    width: opts.width,
    height: opts.height,
    fonts: opts.fonts,
  });
  if (svg.length > MAX_SVG_BYTES) {
    throw new Error(`SVG too large (${svg.length} bytes; limit ${MAX_SVG_BYTES})`);
  }

  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: opts.width },
    // Satori already resolves font glyphs; we only need resvg to rasterise the
    // resulting SVG so a loaded fontsdb isn't necessary.
    font: { loadSystemFonts: false, fontFiles: [] },
  });
  const rendered = resvg.render();
  const png = rendered.asPng();
  rendered.free();
  resvg.free();
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
