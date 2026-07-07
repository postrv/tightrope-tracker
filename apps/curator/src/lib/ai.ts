import type { Env } from "../env";

/**
 * Minimal structural view of the Workers AI binding — just the two call shapes
 * this worker uses. The real `Ai` type carries pedantic overloads (and its own
 * `Blob` declaration that fights the DOM `Blob` the base tsconfig lib surfaces),
 * so we bind through this subset: `env.AI` is structurally compatible, and a
 * test double implements exactly these two methods. Documented deviation from
 * the raw binding type, deliberate.
 */
interface CuratorAiBinding {
  run(model: string, inputs: Record<string, unknown>, options?: unknown): Promise<Record<string, unknown>>;
  toMarkdown(file: { name: string; blob: Blob }): Promise<
    { format: "markdown"; data: string } | { format: "error"; error: string }
  >;
}

function ai(env: Env): CuratorAiBinding {
  return env.AI as unknown as CuratorAiBinding;
}

/**
 * Thin, test-stubbable wrappers over the Workers AI binding.
 *
 * Type discipline (verified against the local @cloudflare/workers-types,
 * 4.2026xxxx): `env.AI.run(model, inputs, options?)` resolves to the
 * "unknown model" overload when `model` is a plain `string` (a CaptureSpec's
 * `modelId` is `string`, not a literal model key), which returns
 * `Promise<Record<string, unknown>>` and accepts `inputs: Record<string,
 * unknown>`. The llama-3.3 JSON mode is passed inside `inputs.response_format`
 * as `{ type: "json_schema", json_schema }` — the exact shape the typed model
 * input declares. Workers AI documents schema compliance as best-effort, so
 * callers (extract.ts) still validate + retry.
 *
 * `env.AI.toMarkdown({ name, blob })` returns a `ConversionResponse` with
 * either `{ format: "markdown", data }` or `{ format: "error", error }` — we
 * narrow on `format`.
 */

/** JSON-mode text-generation call. Returns the model's raw `response` string. */
export async function runModelJson(
  env: Env,
  modelId: string,
  messages: Array<{ role: string; content: string }>,
  jsonSchema: Record<string, unknown>,
): Promise<string> {
  const out = await ai(env).run(modelId, {
    messages,
    response_format: { type: "json_schema", json_schema: jsonSchema },
    // Deterministic decoding: extraction must be reproducible run-to-run so a
    // re-verify of the same artefact can't drift. temperature 0 + a fixed seed.
    temperature: 0,
    seed: 1,
  });
  const response = out.response;
  if (typeof response !== "string") {
    // Some model shapes return the JSON object directly rather than a string.
    if (response && typeof response === "object") return JSON.stringify(response);
    throw new Error("AI.run returned no string `response` field");
  }
  return response;
}

/**
 * Convert a binary document (PDF or XLSX) to markdown via the Workers AI
 * document-conversion utility. Same mechanism the plan sanctions for PDFs; XLSX
 * is handled identically (toMarkdown renders spreadsheet sheets to markdown
 * tables) so the curator never hand-parses ODS/XLSX in the Worker (AUTOMATION_
 * PLAN Phase 3). `name` must carry the right extension so the converter picks
 * the format. Throws on a conversion error so the capture stage records an
 * honest failure.
 */
export async function docToMarkdown(env: Env, name: string, bytes: ArrayBuffer, mime: string): Promise<string> {
  const blob = new Blob([bytes], { type: mime });
  const res = await ai(env).toMarkdown({ name, blob });
  if (res.format === "error") {
    throw new Error(`AI.toMarkdown failed for ${name}: ${res.error}`);
  }
  return res.data;
}
