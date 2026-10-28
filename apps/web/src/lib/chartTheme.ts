import type { PillarId, TimelineCategory } from "@tightrope/shared";

/** Shared by the plot and its key, so labels cannot drift from the marks. */
export const EVENT_STYLES: Record<TimelineCategory, { label: string; colour: string; dash?: string }> = {
  fiscal: { label: "Fiscal", colour: "var(--band-acute)" },
  monetary: { label: "Monetary", colour: "var(--band-strain)" },
  market: { label: "Market", colour: "var(--band-strain)" },
  geopolitical: { label: "Geopolitical", colour: "var(--ink-0)" },
  political: { label: "Political", colour: "var(--cat-political)" },
  policy: { label: "Policy", colour: "var(--ink-2)" },
  delivery: { label: "Delivery", colour: "var(--ink-2)" },
  methodology: { label: "Methodology", colour: "var(--ink-2)", dash: "2 2" },
};

export const PILLAR_STYLES: Record<PillarId, { colour: string; dash: string }> = {
  market: { colour: "var(--band-strain)", dash: "none" },
  fiscal: { colour: "var(--band-acute)", dash: "4 3" },
  labour: { colour: "var(--cat-political)", dash: "7 3" },
  delivery: { colour: "var(--ink-2)", dash: "2 4" },
};
