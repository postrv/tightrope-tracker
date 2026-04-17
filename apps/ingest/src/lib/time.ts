/**
 * Time helpers. Everything in UTC -- UK market hours are 07:00-16:30 local,
 * which because the UK observes DST means 07:00-16:30 Europe/London.
 */

/** Returns true if `now` falls between 07:00 and 16:30 Europe/London time. */
export function isUkMarketHours(now: Date = new Date()): boolean {
  // `Intl.DateTimeFormat` with the London timezone is available on Workers
  // via the `nodejs_compat` flag and in modern runtimes. Parse out HH:MM.
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const hh = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const mm = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  const mins = hh * 60 + mm;
  return mins >= 7 * 60 && mins <= 16 * 60 + 30;
}

export function isoNow(): string {
  return new Date().toISOString();
}

export function daysAgoIso(days: number, now: Date = new Date()): string {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}
