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

/**
 * Hard ceiling on any single Workers AI call. A hung call (observed during
 * the 2026-07-14 Workers AI degradation: gfk_confidence and mhclg_housing
 * extractions never returned) otherwise pins a sweep pool-worker until the
 * platform kills the whole isolate at the cron cap — dangling the in-flight
 * spec's audit row at 'started' and budget-starving every spec queued behind
 * it. With the ceiling, a hang becomes an ordinary retryable model-call
 * failure: the extraction retry loop re-rolls it and the audit row closes
 * honestly. 150s is ~3× the p95 for a 20k-char extraction on llama-3.3.
 */
const AI_CALL_TIMEOUT_MS = 150_000;

async function withTimeout<T>(p: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`AI_TIMEOUT: ${label} exceeded ${AI_CALL_TIMEOUT_MS / 1000}s`)),
      AI_CALL_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** JSON-mode text-generation call. Returns the model's raw `response` string. */
export async function runModelJson(
  env: Env,
  modelId: string,
  messages: Array<{ role: string; content: string }>,
  jsonSchema: Record<string, unknown>,
): Promise<string> {
  const out = await withTimeout(
    ai(env).run(modelId, {
      messages,
      response_format: { type: "json_schema", json_schema: jsonSchema },
      // Deterministic decoding: extraction must be reproducible run-to-run so a
      // re-verify of the same artefact can't drift. temperature 0 + a fixed seed.
      temperature: 0,
      seed: 1,
    }),
    "json-mode model call",
  );
  return narrowResponse(out);
}

/**
 * Schema-FREE text-generation call — the persistent-5024 rescue path
 * (extract.ts). The constrained decoder behind `response_format` can give up
 * ("5024: JSON Model couldn't be met") on dense numeric artefacts at any window
 * size, while the same model complies happily when the shape is merely stated
 * in the prompt. Callers hand-validate the output either way (parseAndValidate
 * is the real gate), so dropping the decoder constraint loosens generation, not
 * acceptance. Same deterministic decoding as runModelJson.
 */
export async function runModelText(
  env: Env,
  modelId: string,
  messages: Array<{ role: string; content: string }>,
): Promise<string> {
  const out = await withTimeout(
    ai(env).run(modelId, { messages, temperature: 0, seed: 1 }),
    "schema-free model call",
  );
  return narrowResponse(out);
}

function narrowResponse(out: Record<string, unknown>): string {
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
  const res = await withTimeout(ai(env).toMarkdown({ name, blob }), `toMarkdown(${name})`);
  if (res.format === "error") {
    throw new Error(`AI.toMarkdown failed for ${name}: ${res.error}`);
  }
  return res.data;
}
