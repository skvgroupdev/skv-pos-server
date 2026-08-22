import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateRecognizedProfit,
  calculateReturnedItemProfitImpact,
} from "./cashProfitReporting";

test("unpaid debt does not recognize profit", () => {
  assert.equal(calculateRecognizedProfit({ orderTotal: 100_000, orderCost: 70_000, appliedAmount: 0 }), 0);
});

test("partial debt recognizes profit in proportion to cash received", () => {
  assert.equal(calculateRecognizedProfit({ orderTotal: 100_000, orderCost: 70_000, appliedAmount: 20_000 }), 6_000);
});

test("overpayment only recognizes up to the bill profit", () => {
  assert.equal(calculateRecognizedProfit({ orderTotal: 100_000, orderCost: 70_000, appliedAmount: 120_000 }), 30_000);
});

test("returned item profit impact uses the returned item margin", () => {
  assert.equal(
    calculateReturnedItemProfitImpact([
      { price: 50_000, cost: 30_000, quantity: 2 },
      { price: 10_000, cost: 7_000, quantity: 1 },
    ]),
    43_000
  );
});
