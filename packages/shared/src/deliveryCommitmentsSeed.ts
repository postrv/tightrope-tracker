import type { DeliveryCommitment, DeliveryStatus } from "./delivery.js";

/**
 * Seed rows for `delivery_commitments`. These are the editorial rows shown
 * in the Delivery pillar scorecard. Each one must have:
 *
 *   - `sourceUrl` + `sourceLabel`: the primary landing page readers can open
 *     (a department page, a Bills register, a project site).
 *   - `notes`: a short prose pointer to the *specific* report / series / act
 *     that the commitment is measured against. This is rendered inline by
 *     `DeliverySection.astro` so a shallow departmental URL still leaves a
 *     navigable breadcrumb to the canonical document.
 *
 * The contract is enforced by `deliveryCommitmentsSeed.test.ts`. When an
 * upstream publishes a proper machine-readable dashboard, upgrade
 * `sourceUrl` to the deep URL and condense or drop the note.
 */
export interface DeliveryCommitmentSeed
  extends Omit<DeliveryCommitment, "updatedAt" | "notes"> {
  readonly status: DeliveryStatus;
  readonly notes: string;
  readonly sortOrder: number;
}

export const DELIVERY_COMMITMENTS_SEED: readonly DeliveryCommitmentSeed[] = [
  {
    id: "housing_305k",
    name: "Net housing additions toward 305k/year by 2030/31",
    department: "MHCLG",
    // Two measures, side by side. The live indicator uses (1); (2) is the
    // annual NAD print readers will see in news. Both are vs the same
    // 305k-by-2030/31 OBR path. Migration 0009 keeps prod in sync.
    latest: "Live indicator: Q4 2025 completions × 4 = 146,880 vs 300k OBR working assumption (49%). Annual NAD FY24/25: 221,400 vs 305k Labour target (73%).",
    target: "OBR path: 305k by 2030/31",
    status: "slipping",
    sourceUrl: "https://www.gov.uk/government/statistical-data-sets/live-tables-on-house-building",
    sourceLabel: "MHCLG live tables",
    notes: "Two complementary measures of housing delivery. (1) The live indicator uses 'Completions, seasonally adjusted' from the MHCLG Housing supply quarterly release — a quarterly cadence we annualise (×4) and compare against the 300,000-per-year OBR working assumption documented in the EFO supplementary tables. (2) The annual headline figure is 'Net additional dwellings' from MHCLG Live Tables 211, a broader measure that includes change-of-use and conversions, published once a year (FY24/25 was 221,400). The 305k-by-2030/31 path target is the Labour Government's headline pledge; OBR's 300k working assumption is what the live indicator benchmarks against to keep continuity with pre-Labour trajectory analysis. Showing both because they tell the same story at different sampling rates and at slightly different scope.",
    sortOrder: 10,
  },
  {
    id: "new_towns",
    name: "Seven new towns -- designation and first spade",
    department: "DLUHC",
    latest: "3 of 7 designated, 0 of 7 first-spade",
    target: "Target: all designated 2026",
    status: "on_track",
    sourceUrl: "https://www.gov.uk/government/groups/the-new-towns-taskforce",
    sourceLabel: "New Towns Taskforce",
    notes: "Taskforce interim report and designations list. First-spade status is tracked in quarterly DLUHC progress updates; we count only sites with confirmed development consent orders.",
    sortOrder: 20,
  },
  {
    id: "bics_rollout",
    name: "British Industrial Competitiveness Scheme rollout",
    department: "DESNZ",
    latest: "8,140 firms onboarded, target >10,000 by Apr 2027",
    target: "Up to 25% electricity relief",
    status: "on_track",
    sourceUrl: "https://www.gov.uk/government/organisations/department-for-energy-security-and-net-zero",
    sourceLabel: "DESNZ (scheme page)",
    notes: "Onboarded-firms count from DESNZ monthly BICS update letters and quarterly ministerial statements to the House. There is no single machine-readable dashboard yet; see the DESNZ homepage for the latest statement.",
    sortOrder: 30,
  },
  {
    id: "smr_fleet",
    name: "Small Modular Reactor fleet, first site selected",
    department: "GBE",
    latest: "Shortlist of 3 sites, final FID slipped to Q3",
    target: "Original target: Q1 2026",
    status: "slipping",
    sourceUrl: "https://www.gov.uk/government/organisations/great-british-energy",
    sourceLabel: "Great British Energy",
    notes: "Site shortlist and FID dates tracked via Great British Nuclear ministerial updates. Latest status is the most recent SMR programme announcement on the GBE page.",
    sortOrder: 40,
  },
  {
    id: "planning_bill",
    name: "Planning and Infrastructure Bill -- Royal Assent",
    department: "Parliament",
    latest: "Received Royal Assent 18 Dec 2025",
    target: "Commitment delivered",
    status: "shipped",
    sourceUrl: "https://www.legislation.gov.uk/ukpga/2025/34/enacted",
    sourceLabel: "Planning & Infrastructure Act 2025",
    notes: "Full enacted text on legislation.gov.uk. Stage-by-stage parliamentary record at bills.parliament.uk/bills/3946. Royal Assent 18 December 2025.",
    sortOrder: 50,
  },
  {
    id: "keep_britain_working",
    name: "Keep Britain Working -- health-related inactivity",
    department: "DWP",
    latest: "2.81m, effectively unchanged from 2.80m at launch",
    target: "Stated ambition: meaningful reduction by 2027",
    status: "missed",
    sourceUrl: "https://www.gov.uk/government/organisations/department-for-work-pensions",
    sourceLabel: "DWP",
    notes: "Inactivity-due-to-long-term-sickness numbers come from ONS Labour Force Survey (series LF69, LFS: Econ. inactivity reasons: Long Term Sick: UK: 16-64). The policy target is set out in the DWP 'Get Britain Working' white paper; the rolling figure is against that baseline.",
    sortOrder: 60,
  },
  {
    id: "sizewell_c",
    name: "Sizewell C -- construction milestones",
    department: "DESNZ",
    latest: "Main civils underway, on schedule vs. 2024 baseline",
    target: "Commissioning late 2030s",
    status: "on_track",
    sourceUrl: "https://www.sizewellc.com/",
    sourceLabel: "Sizewell C project",
    notes: "Milestone status from the project's quarterly updates. Spending profile cross-referenced against DESNZ annual report and OBR EFO Box on NPP programme costs.",
    sortOrder: 70,
  },
  {
    id: "grid_connections",
    name: "Grid connections reform -- queue reduction",
    department: "DESNZ/NESO",
    latest: "Queue re-ordered, first cohort through in Q1",
    target: "End \"first come first served\" by 2026",
    status: "on_track",
    sourceUrl: "https://www.neso.energy/",
    sourceLabel: "NESO (connections reform)",
    notes: "Queue-reform progress comes from NESO's Connections Reform programme updates. Confirm via the most recent TMO4+ milestone report on the NESO site.",
    sortOrder: 80,
  },
];
