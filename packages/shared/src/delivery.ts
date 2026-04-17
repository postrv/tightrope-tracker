export type DeliveryStatus = "on_track" | "slipping" | "missed" | "shipped";

export interface DeliveryCommitment {
  id: string;
  name: string;
  department: string;
  latest: string;
  target: string;
  status: DeliveryStatus;
  sourceUrl: string;
  sourceLabel: string;
  updatedAt: string;
  notes?: string;
}

export const DELIVERY_STATUS_LABEL: Record<DeliveryStatus, string> = {
  on_track: "On track",
  slipping: "Slipping",
  missed: "Missed",
  shipped: "Shipped",
};

export const DELIVERY_STATUS_COLOUR_TOKEN: Record<DeliveryStatus, string> = {
  on_track: "--band-slack",
  slipping: "--band-strain",
  missed: "--band-critical",
  shipped: "--band-steady",
};
