/**
 * Minimal CSV parser. Assumes:
 *   - UTF-8 input
 *   - comma-separated
 *   - no embedded commas in values (Bank of England IADB + ONS /data CSVs satisfy this)
 *   - optional trailing blank lines
 *
 * Returns an array of objects keyed by the header row.
 */
export function parseCsv(input: string): Array<Record<string, string>> {
  const lines = input
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length < 2) return [];
  const header = lines[0]!.split(",").map((c) => c.trim());
  const rows: Array<Record<string, string>> = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i]!.split(",").map((c) => c.trim());
    const row: Record<string, string> = {};
    for (let j = 0; j < header.length; j++) {
      row[header[j]!] = cells[j] ?? "";
    }
    rows.push(row);
  }
  return rows;
}

/** Convert a BoE IADB date (DD Mmm YYYY) into an ISO 8601 UTC midnight. */
export function boeDateToIso(input: string): string {
  const months: Record<string, string> = {
    Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
    Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12",
  };
  const match = input.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/);
  if (!match) {
    throw new Error(`boeDateToIso: cannot parse '${input}'`);
  }
  const day = match[1]!.padStart(2, "0");
  const monAbbr = match[2]!.slice(0, 1).toUpperCase() + match[2]!.slice(1, 3).toLowerCase();
  const mm = months[monAbbr];
  if (!mm) throw new Error(`boeDateToIso: unknown month '${match[2]}'`);
  return `${match[3]}-${mm}-${day}T00:00:00Z`;
}
