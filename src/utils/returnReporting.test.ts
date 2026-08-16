import assert from "node:assert/strict";
import test from "node:test";
import { combineReturnReportSummaries } from "./returnReporting";

test("cancelled items restored to stock are included in returned product totals", () => {
  assert.deepEqual(
    combineReturnReportSummaries(
      { count: 0, units: 0, value: 0, damagedCost: 0 },
      { count: 1, units: 1, value: 455_000, damagedCost: 0 }
    ),
    { count: 1, units: 1, value: 455_000, damagedCost: 0 }
  );
});

test("partial returns and cancelled order returns are combined without losing damage cost", () => {
  assert.deepEqual(
    combineReturnReportSummaries(
      { count: 2, units: 3, value: 900_000, damagedCost: 120_000 },
      { count: 1, units: 2, value: 400_000 }
    ),
    { count: 3, units: 5, value: 1_300_000, damagedCost: 120_000 }
  );
});

test("cancelled orders without a stock return do not change returned product totals", () => {
  assert.deepEqual(combineReturnReportSummaries(), {
    count: 0,
    units: 0,
    value: 0,
    damagedCost: 0,
  });
});
