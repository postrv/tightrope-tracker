/**
 * Time helpers. Everything in UTC -- UK market hours are 07:00-16:30 local,
 * which because the UK observes DST means 07:00-16:30 Europe/London.
 */

function londonClock(now: Date): { minutes: number; weekday: boolean } {
  // `Intl.DateTimeFormat` with the London timezone is available on Workers
  // via the `nodejs_compat` flag and in modern runtimes. Parse out HH:MM.
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const hh = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const mm = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  const day = parts.find((p) => p.type === "weekday")?.value;
  return { minutes: hh * 60 + mm, weekday: day !== "Sat" && day !== "Sun" };
}

/** Returns true on weekdays between 07:00 and 16:30 Europe/London. */
export function isUkMarketHours(now: Date = new Date()): boolean {
  const clock = londonClock(now);
  return clock.weekday && clock.minutes >= 7 * 60 && clock.minutes <= 16 * 60 + 30;
}

/** Two bounded post-auction checks, after adapters accept completed bars. */
export function isUkCloseCatchup(now: Date = new Date()): boolean {
  const clock = londonClock(now);
  return clock.weekday && (clock.minutes === 16 * 60 + 35 || clock.minutes === 18 * 60 + 5);
}

/** Recover the previous session once before opening, preserving EOD quota. */
export function isUkOpenRecovery(now: Date = new Date()): boolean {
  const clock = londonClock(now);
  return clock.weekday && clock.minutes === 7 * 60;
}

export function isoNow(): string {
  return new Date().toISOString();
}

export function daysAgoIso(days: number, now: Date = new Date()): string {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}
