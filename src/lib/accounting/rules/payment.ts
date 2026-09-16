import { ValidationError } from '../../errors';
import { ZERO, type Cents } from '../../money';
import { ACCOUNTS } from '../chart-of-accounts';
import type { PostingLine } from '../ledger';

export type PaymentChannel = 'CASH' | 'CHECK' | 'CARD' | 'ACH' | 'FINANCING' | 'OTHER';

export interface PaymentPostingInput {
  paymentNo: string;
  locationId: string;
  customerId: string;
  jobId?: string | null;
  method: PaymentChannel;
  amountCents: Cents;
  /** Processor fee withheld at capture. Expensed immediately, not netted against revenue. */
  feeCents?: Cents;
  /**
   * A deposit is money received before the work is earned: it is a liability, not
   * revenue and not a reduction of AR. Getting this wrong misstates both the balance
   * sheet and the income statement.
   */
  isDeposit: boolean;
}

/**
 * Payment received.
 *
 * Card and ACH land in Credit Card Clearing (the processor holds them until payout);
 * cash and cheques land in Undeposited Funds until a bank deposit is recorded. Neither
 * touches the bank account directly, which is what makes reconciliation possible.
 *
 *   Dr  Card Clearing / Undeposited Funds   amount - fee
 *   Dr  Merchant Processing Fees            fee
 *     Cr  Accounts Receivable               (payment against an invoice)
 *     Cr  Customer Deposits                 (deposit taken before the work)
 */
export function paymentReceivedLines(input: PaymentPostingInput): PostingLine[] {
  const fee = input.feeCents ?? ZERO;
  if (input.amountCents <= ZERO) throw new ValidationError('Payment must be a positive amount');
  if (fee < ZERO) throw new ValidationError('Processing fee must be a positive amount');
  if (fee > input.amountCents) throw new ValidationError('Processing fee exceeds the payment');

  const dimensions = {
    locationId: input.locationId,
    customerId: input.customerId,
    jobId: input.jobId ?? null,
  };

  const holdingAccount =
    input.method === 'CARD' || input.method === 'ACH'
      ? ACCOUNTS.CARD_CLEARING
      : ACCOUNTS.UNDEPOSITED_FUNDS;

  const lines: PostingLine[] = [
    {
      accountCode: holdingAccount,
      debitCents: input.amountCents - fee,
      memo: `Payment ${input.paymentNo}`,
      ...dimensions,
    },
  ];

  if (fee > ZERO) {
    lines.push({
      accountCode: ACCOUNTS.MERCHANT_FEES,
      debitCents: fee,
      memo: `Processing fee on payment ${input.paymentNo}`,
      ...dimensions,
    });
  }

  lines.push({
    accountCode: input.isDeposit ? ACCOUNTS.CUSTOMER_DEPOSITS : ACCOUNTS.AR,
    creditCents: input.amountCents,
    memo: input.isDeposit
      ? `Customer deposit ${input.paymentNo}`
      : `Payment ${input.paymentNo}`,
    ...dimensions,
  });

  return lines;
}

/**
 * Bank deposit: moves collected funds out of the holding account into the bank, matching
 * the physical deposit slip so the bank reconciliation has something to match against.
 *
 *   Dr  Operating Bank Account
 *     Cr  Undeposited Funds
 */
export function bankDepositLines(input: {
  depositNo: string;
  locationId?: string | null;
  amountCents: Cents;
  bankAccountCode?: string;
  fromAccountCode?: string;
}): PostingLine[] {
  if (input.amountCents <= ZERO) throw new ValidationError('Deposit must be a positive amount');

  const dimensions = { locationId: input.locationId ?? null };
  return [
    {
      accountCode: input.bankAccountCode ?? ACCOUNTS.BANK_OPERATING,
      debitCents: input.amountCents,
      memo: `Bank deposit ${input.depositNo}`,
      ...dimensions,
    },
    {
      accountCode: input.fromAccountCode ?? ACCOUNTS.UNDEPOSITED_FUNDS,
      creditCents: input.amountCents,
      memo: `Bank deposit ${input.depositNo}`,
      ...dimensions,
    },
  ];
}

/**
 * Processor payout: the card processor settles a batch to the bank.
 *
 *   Dr  Operating Bank Account
 *     Cr  Credit Card Clearing
 */
export function processorPayoutLines(input: {
  reference: string;
  amountCents: Cents;
  locationId?: string | null;
  bankAccountCode?: string;
}): PostingLine[] {
  if (input.amountCents <= ZERO) throw new ValidationError('Payout must be a positive amount');

  const dimensions = { locationId: input.locationId ?? null };
  return [
    {
      accountCode: input.bankAccountCode ?? ACCOUNTS.BANK_OPERATING,
      debitCents: input.amountCents,
      memo: `Processor payout ${input.reference}`,
      ...dimensions,
    },
    {
      accountCode: ACCOUNTS.CARD_CLEARING,
      creditCents: input.amountCents,
      memo: `Processor payout ${input.reference}`,
      ...dimensions,
    },
  ];
}
