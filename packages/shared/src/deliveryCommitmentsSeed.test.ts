import { describe, expect, it } from "vitest";
import { DELIVERY_COMMITMENTS_SEED } from "./deliveryCommitmentsSeed.js";
import { DELIVERY_STATUS_LABEL } from "./delivery.js";

describe("DELIVERY_COMMITMENTS_SEED", () => {
  it("contains at least the eight canonical commitments", () => {
    expect(DELIVERY_COMMITMENTS_SEED.length).toBeGreaterThanOrEqual(8);
    const ids = DELIVERY_COMMITMENTS_SEED.map((d) => d.id);
    // Spot-check the headline four — they are referenced by name in
    // editorial copy and the /methodology page.
    expect(ids).toContain("housing_305k");
    expect(ids).toContain("new_towns");
    expect(ids).toContain("planning_bill");
    expect(ids).toContain("keep_britain_working");
  });

  it("every commitment has a unique id", () => {
    const ids = DELIVERY_COMMITMENTS_SEED.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every commitment has an HTTPS sourceUrl pointing at a recognised primary-source host", () => {
    // Commitments must link to a primary source readers can navigate.
    // The allowlist is deliberately short: if you need to add a new
    // host, it should be a department, regulator, statutory body, or
    // the project's own site — never a news aggregator.
    const ALLOWED_HOSTS = [
      "www.gov.uk",
      "bills.parliament.uk",
      "www.legislation.gov.uk",
      "obr.uk",
      "www.bankofengland.co.uk",
      "www.ons.gov.uk",
      "www.sizewellc.com",
      "www.neso.energy",
    ];
    for (const d of DELIVERY_COMMITMENTS_SEED) {
      expect(d.sourceUrl, `${d.id} url`).toMatch(/^https:\/\//);
      const url = new URL(d.sourceUrl);
      expect(ALLOWED_HOSTS, `${d.id} host ${url.host}`).toContain(url.host);
    }
  });

  it("every commitment carries a non-trivial notes string naming the specific primary document", () => {
    // Notes are the minimum-viable substitute for a deep URL when the
    // upstream host only exposes a department homepage. Without them,
    // readers can't verify the numbers behind a shallow URL. Forty
    // characters is deliberately low — it rejects "See DESNZ." but
    // accepts a one-sentence pointer.
    for (const d of DELIVERY_COMMITMENTS_SEED) {
      expect(d.notes, `${d.id} notes`).toBeDefined();
      expect(d.notes.length, `${d.id} notes too short`).toBeGreaterThanOrEqual(40);
    }
  });

  it("every commitment declares a valid DeliveryStatus", () => {
    const valid = new Set(Object.keys(DELIVERY_STATUS_LABEL));
    for (const d of DELIVERY_COMMITMENTS_SEED) {
      expect(valid.has(d.status), `${d.id} status ${d.status}`).toBe(true);
    }
  });

  it("sort_order values are strictly increasing (stable scoreboard order)", () => {
    const orders = DELIVERY_COMMITMENTS_SEED.map((d) => d.sortOrder);
    for (let i = 1; i < orders.length; i += 1) {
      expect(orders[i], `row ${i}`).toBeGreaterThan(orders[i - 1]!);
    }
  });
});
