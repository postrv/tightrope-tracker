/** 16:30 Europe/London cash close as a UTC ISO timestamp for a date. */
export function londonCloseIso(dateYmd: string): string {
  const noonUtc = new Date(`${dateYmd}T12:00:00Z`);
  const londonHourAtNoon = Number(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    hour: "2-digit",
    hourCycle: "h23",
  }).format(noonUtc));
  // London is UTC+1 during BST and UTC+0 in winter. At noon, any DST
  // transition for that date has already happened.
  const utcOffsetHours = londonHourAtNoon - 12;
  return new Date(Date.parse(`${dateYmd}T16:30:00Z`) - utcOffsetHours * 60 * 60 * 1000)
    .toISOString().replace(".000Z", "Z");
}
