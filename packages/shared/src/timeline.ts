export type TimelineCategory = "monetary" | "fiscal" | "geopolitical" | "policy" | "market" | "delivery";

export interface TimelineEvent {
  id: string;
  date: string;
  title: string;
  summary: string;
  category: TimelineCategory;
  sourceLabel: string;
  sourceUrl?: string;
  /** Optional score delta attributable to this event. */
  scoreDelta?: number;
}
