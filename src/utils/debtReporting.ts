export type DebtReportingTransaction = {
  type?: string;
  paymentMethod?: string | null;
  reference?: string | null;
  amount?: number;
};

export const debtRepaymentMatch = () => ({
  type: "DEBIT" as const,
  $nor: [
    {
      paymentMethod: "ADJUSTMENT" as const,
      reference: /^CANCEL:/,
    },
  ],
});

export const receivedTransactionStatusMatch = () => ({
  $in: ["POSTED", "REVERSED"] as const,
});

export const isDebtRepayment = (transaction: DebtReportingTransaction) =>
  transaction.type === "DEBIT" && !(
    transaction.paymentMethod === "ADJUSTMENT" && transaction.reference?.startsWith("CANCEL:")
  );

export const summarizeDebtRepayments = (transactions: DebtReportingTransaction[]) =>
  transactions.reduce<{ amount: number; count: number }>(
    (summary, transaction) => {
      if (!isDebtRepayment(transaction)) return summary;
      summary.amount += Number(transaction.amount || 0);
      summary.count += 1;
      return summary;
    },
    { amount: 0, count: 0 }
  );
