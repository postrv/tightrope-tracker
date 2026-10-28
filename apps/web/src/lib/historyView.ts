import type { ScoreHistoryResolutionRequest } from "@tightrope/shared";

export type HistoryRange = 1 | 7 | 30 | 90 | 365 | "all";

export const HISTORY_RANGES = [
  { value: 1, label: "1d", hint: "Last 24 hours" },
  { value: 7, label: "7d", hint: "Last 7 days" },
  { value: 30, label: "30d", hint: "Last 30 days" },
  { value: 90, label: "90d", hint: "Last 90 days" },
  { value: 365, label: "1y", hint: "Last 365 days" },
  { value: "all", label: "All", hint: "All available history" },
] as const;

export const HISTORY_RESOLUTIONS = [
  { value: "auto", label: "Automatic" },
  { value: "raw", label: "Every recording" },
  { value: "hourly", label: "Hourly" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
] as const;

export function parseHistoryRange(raw: string | null): { option: HistoryRange; days: number } {
  const value = HISTORY_RANGES.find(range => String(range.value) === raw)?.value ?? 90;
  return { option: value, days: value === "all" ? 7305 : value };
}

export function parseHistoryResolution(raw: string | null): ScoreHistoryResolutionRequest {
  return HISTORY_RESOLUTIONS.find(resolution => resolution.value === raw)?.value ?? "auto";
}

export function historyHref(range: HistoryRange, resolution: ScoreHistoryResolutionRequest = "auto", embed = false, basePath = "/composite"): string {
  const query = new URLSearchParams({ range: String(range), resolution });
  if (embed) query.set("embed", "1");
  return `${basePath}?${query.toString()}`;
}

/** All labels describe actual bucket selection; they make no claim about source-release frequency. */
export const RESOLUTION_LABELS = {
  raw: "Every recorded snapshot",
  hourly: "Last recording per UTC hour",
  daily: "Last recording per UTC day",
  weekly: "Last recording per UTC week",
} as const;

export function chartTickLabel(timestamp: string, spanMs: number): string {
  const date = new Date(timestamp);
  if (spanMs <= 2 * 86_400_000) return date.toISOString().slice(11, 16);
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", ...(spanMs > 366 * 86_400_000 ? { year: "2-digit" as const } : {}), timeZone: "UTC" }).format(date);
}
