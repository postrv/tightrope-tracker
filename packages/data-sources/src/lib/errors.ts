/**
 * Structured adapter error. Carries the sourceId, URL, and a one-line reason
 * so the ingest Worker can persist an informative audit row.
 */
export class AdapterError extends Error {
  public readonly sourceId: string;
  public readonly sourceUrl: string;
  public readonly status: number | null;

  constructor(opts: { sourceId: string; sourceUrl: string; status?: number | null; message: string; cause?: unknown }) {
    super(opts.message);
    this.name = "AdapterError";
    this.sourceId = opts.sourceId;
    this.sourceUrl = opts.sourceUrl;
    this.status = opts.status ?? null;
    if (opts.cause !== undefined) {
      (this as { cause?: unknown }).cause = opts.cause;
    }
  }
}

/** Helper used by every adapter so failures look the same in the audit log. */
export async function fetchOrThrow(
  fetchImpl: typeof globalThis.fetch,
  sourceId: string,
  url: string,
  init?: RequestInit,
): Promise<Response> {
  let res: Response;
  try {
    res = await fetchImpl(url, init);
  } catch (cause) {
    throw new AdapterError({
      sourceId,
      sourceUrl: url,
      message: `network error fetching ${sourceId}: ${(cause as Error)?.message ?? "unknown"}`,
      cause,
    });
  }
  if (!res.ok) {
    throw new AdapterError({
      sourceId,
      sourceUrl: url,
      status: res.status,
      message: `${sourceId} returned HTTP ${res.status} ${res.statusText}`,
    });
  }
  return res;
}
