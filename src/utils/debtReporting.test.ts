import assert from "node:assert/strict";
import test from "node:test";
import {
  debtRepaymentMatch,
  isDebtRepayment,
  receivedTransactionStatusMatch,
  summarizeDebtRepayments,
} from "./debtReporting";

test("Mongo match excludes cancellation adjustments from debt repayment reports", () => {
  assert.deepEqual(debtRepaymentMatch(), {
    type: "DEBIT",
    $nor: [{ paymentMethod: "ADJUSTMENT", reference: /^CANCEL:/ }],
  });
});

test("unpaid debt cancellation is not reported as received repayment", () => {
  const result = summarizeDebtRepayments([
    { type: "CREDIT", amount: 455_000 },
    { type: "DEBIT", paymentMethod: "ADJUSTMENT", reference: "CANCEL:385CK6WZNG", amount: 455_000 },
  ]);

  assert.deepEqual(result, { amount: 0, count: 0 });
});

test("partial debt cancellation reports only money actually received", () => {
  const result = summarizeDebtRepayments([
    { type: "CREDIT", amount: 455_000 },
    { type: "DEBIT", paymentMethod: "CASH", amount: 200_000 },
    { type: "DEBIT", paymentMethod: "ADJUSTMENT", reference: "CANCEL:PARTIAL", amount: 255_000 },
  ]);

  assert.deepEqual(result, { amount: 200_000, count: 1 });
});

test("fully paid debt cancellation keeps the real repayment in history", () => {
  assert.equal(isDebtRepayment({ type: "DEBIT", paymentMethod: "TRANSFER" }), true);
  assert.equal(isDebtRepayment({ type: "DEBIT", paymentMethod: "ADJUSTMENT", reference: "CANCEL:PAID" }), false);
});

test("legacy imported adjustment remains a reportable repayment", () => {
  assert.equal(isDebtRepayment({
    type: "DEBIT",
    paymentMethod: "ADJUSTMENT",
    reference: "LATDA_MYSQL:INVOICE:2731",
  }), true);
});

test("paid cancellation keeps the original receipt alongside its reversal", () => {
  assert.deepEqual(receivedTransactionStatusMatch(), {
    $in: ["POSTED", "REVERSED"],
  });
});

test("legacy repayment without a payment method remains reportable", () => {
  assert.equal(isDebtRepayment({ type: "DEBIT" }), true);
});
