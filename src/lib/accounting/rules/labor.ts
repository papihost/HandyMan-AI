import { ValidationError } from '../../errors';
import { applyRate, multiplyQuantity, ZERO, type Cents } from '../../money';
import { ACCOUNTS } from '../chart-of-accounts';
import type { PostingLine } from '../ledger';

/**
 * Labor cost and burden.
 *
 * The cost of an hour of a technician's time is not their wage. Payroll taxes, workers'
 * compensation, benefits, the van and the phone all have to be loaded onto billable hours
 * or every margin figure in the system is optimistic by 40-60%, and the owner prices work
 * off it.
 */

export interface BurdenInputs {
  baseHourlyCents: Cents;
  payrollTaxRate: string | number;
  workersCompRate: string | number;
  benefitsRate: string | number;
  vehicleMonthlyCents: Cents;
  phoneMonthlyCents: Cents;
  /** Billable hours per month — the denominator that spreads fixed costs over real work. */
  billableHoursPerMonth: string | number;
}

/**
 * The loaded hourly cost of a technician.
 *
 *   loaded = wage × (1 + payrollTax + workersComp + benefits)
 *          + (vehicle + phone) / billableHoursPerMonth
 *
 * A $28.00/hr technician at typical rates lands around $44/hr. That difference is the
 * whole argument for computing it.
 */
export function loadedHourlyCost(inputs: BurdenInputs): Cents {
  if (inputs.baseHourlyCents < ZERO) throw new ValidationError('Base wage cannot be negative');

  const billableHours = Number(inputs.billableHoursPerMonth);
  if (!Number.isFinite(billableHours) || billableHours <= 0) {
    throw new ValidationError('Billable hours per month must be greater than zero');
  }

  const variableBurden =
    applyRate(inputs.baseHourlyCents, inputs.payrollTaxRate) +
    applyRate(inputs.baseHourlyCents, inputs.workersCompRate) +
    applyRate(inputs.baseHourlyCents, inputs.benefitsRate);

  return inputs.baseHourlyCents + variableBurden + fixedHourlyCost(inputs);
}

/**
 * The part of the loaded rate that is not owed to anybody on payday.
 *
 * The van and the phone are real costs of an hour and belong in the margin, but they are
 * owed to a leasing company and a carrier, not to the technician. Keeping them separable
 * matters because the rest of the loaded rate accrues into Payroll Liabilities, and a
 * payroll run has to be able to settle that account to the cent. Anything in there that
 * payroll can never pay is not a liability, it is a filing error that grows every hour.
 */
export function fixedHourlyCost(inputs: BurdenInputs): Cents {
  const billableHours = Number(inputs.billableHoursPerMonth);
  if (!Number.isFinite(billableHours) || billableHours <= 0) {
    throw new ValidationError('Billable hours per month must be greater than zero');
  }

  const fixedMonthly = inputs.vehicleMonthlyCents + inputs.phoneMonthlyCents;
  // Half-up division of the fixed pool across billable hours.
  const hoursScaled = BigInt(Math.round(billableHours * 1000));
  return hoursScaled === 0n ? ZERO : (fixedMonthly * 1000n * 2n + hoursScaled) / (hoursScaled * 2n);
}

/** Split a loaded hourly cost back into its wage and burden components for the GL. */
export function splitBurden(
  baseHourlyCents: Cents,
  loadedHourlyCents: Cents,
): { wageCents: Cents; burdenCents: Cents } {
  if (loadedHourlyCents < baseHourlyCents) {
    throw new ValidationError('Loaded cost cannot be below the base wage');
  }
  return { wageCents: baseHourlyCents, burdenCents: loadedHourlyCents - baseHourlyCents };
}

/**
 * Technician hours costed to a job.
 *
 * Wage and burden are posted to separate accounts so an owner can see what the burden
 * actually is, rather than having it buried inside a single labor number.
 *
 *   Dr  COGS — Direct Labor            hours × wage
 *   Dr  COGS — Labor Burden            hours × (loaded - wage)
 *     Cr  Payroll Liabilities          hours × (loaded - fixed)
 *     Cr  Vehicle & Phone Cost Applied hours × fixed
 *
 * The credit splits because the two halves are owed to different people. Wage, payroll
 * tax, workers' comp and benefits are owed to or for the technician, and a payroll run
 * settles them. The van and the phone are owed to a leasing company and a carrier, and
 * are already in overhead — applying them here moves that cost into the margin of the job
 * that used the hour, which is the whole point of a loaded rate.
 *
 * Crediting the fixed part to Payroll Liabilities instead, as this used to, makes the
 * balance sheet claim the company owes its technicians the van. Nothing can relieve it: a
 * payroll run pays wages, so the account grows by the fixed rate for every hour anybody
 * ever works and the residue reads as a rate variance it is not.
 */
export function laborCostedLines(input: {
  jobId: string;
  locationId: string;
  technicianId: string;
  serviceTypeId?: string | null;
  hours: string | number;
  baseHourlyCents: Cents;
  loadedHourlyCents: Cents;
  /**
   * The van-and-phone part of the loaded rate, from `fixedHourlyCost`. Omitted, the whole
   * loaded cost accrues as payroll — correct only where there is no fixed pool to separate.
   */
  fixedHourlyCents?: Cents;
  useWip?: boolean;
  description?: string;
}): PostingLine[] {
  const { wageCents, burdenCents } = splitBurden(input.baseHourlyCents, input.loadedHourlyCents);
  const fixedCents = input.fixedHourlyCents ?? ZERO;
  if (fixedCents < ZERO) throw new ValidationError('Fixed hourly cost cannot be negative');
  if (fixedCents > burdenCents) {
    throw new ValidationError('Fixed hourly cost cannot exceed the burden it is part of');
  }

  const wageTotal = multiplyQuantity(wageCents, input.hours);
  const burdenTotal = multiplyQuantity(burdenCents, input.hours);
  const fixedTotal = multiplyQuantity(fixedCents, input.hours);
  const total = wageTotal + burdenTotal;

  if (total <= ZERO) throw new ValidationError('Labor posting must carry a positive cost');

  const dimensions = {
    locationId: input.locationId,
    jobId: input.jobId,
    technicianId: input.technicianId,
    serviceTypeId: input.serviceTypeId ?? null,
  };
  const memo = input.description ?? `Labor — ${input.hours} hrs`;

  const lines: PostingLine[] = [];

  if (wageTotal > ZERO) {
    lines.push({
      accountCode: input.useWip ? ACCOUNTS.WIP : ACCOUNTS.COGS_LABOR,
      debitCents: wageTotal,
      memo,
      ...dimensions,
    });
  }
  if (burdenTotal > ZERO) {
    lines.push({
      accountCode: input.useWip ? ACCOUNTS.WIP : ACCOUNTS.COGS_BURDEN,
      debitCents: burdenTotal,
      memo: `${memo} (burden)`,
      ...dimensions,
    });
  }

  const payrollTotal = total - fixedTotal;
  if (payrollTotal > ZERO) {
    lines.push({
      accountCode: ACCOUNTS.PAYROLL_LIABILITIES,
      creditCents: payrollTotal,
      memo,
      ...dimensions,
    });
  }
  if (fixedTotal > ZERO) {
    lines.push({
      accountCode: ACCOUNTS.VEHICLE_PHONE_APPLIED,
      creditCents: fixedTotal,
      memo: `${memo} (van and phone)`,
      ...dimensions,
    });
  }

  return lines;
}

/**
 * Subcontractor cost billed to a job.
 *
 *   Dr  COGS — Subcontractors
 *     Cr  Accounts Payable
 */
export function subcontractorCostLines(input: {
  jobId: string;
  locationId: string;
  vendorId: string;
  amountCents: Cents;
  billNo?: string;
}): PostingLine[] {
  if (input.amountCents <= ZERO) {
    throw new ValidationError('Subcontractor cost must be a positive amount');
  }

  const dimensions = {
    locationId: input.locationId,
    jobId: input.jobId,
    vendorId: input.vendorId,
  };
  const memo = input.billNo ? `Subcontractor — ${input.billNo}` : 'Subcontractor cost';

  return [
    { accountCode: ACCOUNTS.COGS_SUBCONTRACTORS, debitCents: input.amountCents, memo, ...dimensions },
    { accountCode: ACCOUNTS.AP, creditCents: input.amountCents, memo, ...dimensions },
  ];
}
