// The Check card compares only figures of a similar size: a monthly price is not held against a total budget, a near miss still counts.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { quantities, mismatches, refQuantities } from "./moments/overpromise.ts";

// the Check card compared unrelated numbers (a monthly price against a total budget).
test("check: figures of very different size are not one figure said wrong; a near miss still is", () => {
  const refs = refQuantities({ notes: ["budget: $85,000", "monthly hosting cost: 250 shekels a month", "Pilot price: $1,000"] });
  assert.equal(
    mismatches(
      quantities("The monthly price is $1,200"),
      refs.filter((r) => r.source.startsWith("budget")),
    ).length,
    0,
  );
  assert.equal(
    mismatches(
      quantities("It is 8,000 shekels for the fourth language"),
      refs.filter((r) => r.source.startsWith("monthly")),
    ).length,
    0,
  );
  assert.equal(mismatches(quantities("1200 ₪ for the site"), refQuantities({ notes: ["budget 60,000 NIS"] })).length, 0);
  assert.equal(
    mismatches(
      quantities("The pilot price is $1,200"),
      refs.filter((r) => r.source.startsWith("Pilot")),
    ).length,
    1,
  );
  assert.equal(
    mismatches(
      quantities("The pilot price is $10,000"),
      refs.filter((r) => r.source.startsWith("Pilot")),
    ).length,
    1,
    "one zero too many",
  );
});
