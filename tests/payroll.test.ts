import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/lib/db';
import { systemContext, type AuthContext } from '../src/lib/auth/context';
import { ACCOUNTS } from '../src/lib/accounting/chart-of-accounts';
import { postJournalEntry } from '../src/lib/accounting/ledger';
import { laborCostedLines } from '../src/lib/accounting/rules/labor';
import { trialBalance } from '../src/lib/accounting/reports';
import {
  accrualVariance,
  approveTime,
  payrollPreview,
  runPayroll,
  weeklyTimesheets,
  weekStartOf,
} from '../src/lib/payroll/service';
import {
  createTestJob,
  createTestOrg,
  createTestTechnician,
  utc,
  type TestOrg,
} from './factory';

/**
 * Hours, approved and paid.
 *
 * The accounting question underneath is the interesting one: the jobs have been accruing
 * labour at a loaded rate all along, and payroll is what settles it. The two are not
 * meant to be equal, and the gap is the point.
 */

let org: TestOrg;
let ctx: AuthContext;
let tech: { technicianId: string; userId: string };

beforeAll(async () => {
  org = await createTestOrg('Payroll');
  ctx = systemContext(org.organizationId);
  tech = await createTestTechnician(org.organizationId, org.locationId);
});

afterAll(async () => {
  await db.$disconnect();
});

/** A shift on a job: the clock entry and nothing else. */
async function shift(technicianId: string, startedAt: Date, hours: number, jobId?: string) {
  return db.timeEntry.create({
    data: {
      technicianId,
      jobId: jobId ?? null,
      kind: 'WORK',
      startedAt,
      endedAt: new Date(startedAt.getTime() + hours * 3_600_000),
      minutes: Math.round(hours * 60),
      isBillable: true,
      loadedHourlyCents: 4_056n,
    },
  });
}

describe('approving time', () => {
  it('shows a week by person, and approval carries a name and a time', async () => {
    const week = weekStartOf(utc(2026, 5, 6));
    const job = await createTestJob(org.organizationId, org.locationId);

    await shift(tech.technicianId, utc(2026, 5, 4), 7.5, job.jobId);
    await shift(tech.technicianId, utc(2026, 5, 5), 8.25, job.jobId);

    const sheets = await weeklyTimesheets(db, ctx, week);
    const row = sheets.find((r) => r.technicianId === tech.technicianId)!;
    expect(row.entryCount).toBe(2);
    expect(row.hours).toBeCloseTo(15.75, 2);
    expect(row.approvedHours).toBe(0);

    const approved = await approveTime(db, ctx, {
      entryIds: row.entries.map((entry) => entry.id),
      approved: true,
    });
    expect(approved.changed).toBe(2);

    const entry = await db.timeEntry.findUniqueOrThrow({ where: { id: row.entries[0].id } });
    expect(entry.isApproved).toBe(true);
    expect(entry.approvedAt).not.toBeNull();

    // And an approval can be taken back while nobody has been paid for it.
    await approveTime(db, ctx, { entryIds: [row.entries[0].id], approved: false });
    const after = await db.timeEntry.findUniqueOrThrow({ where: { id: row.entries[0].id } });
    expect(after.isApproved).toBe(false);
    expect(after.approvedAt).toBeNull();
  });
});

describe('running payroll', () => {
  it('counts overtime by the week, not across the period', async () => {
    const payOrg = await createTestOrg('PayrollOvertime');
    const payCtx = systemContext(payOrg.organizationId);
    const worker = await createTestTechnician(payOrg.organizationId, payOrg.locationId);

    // Two forty-five hour weeks: ten hours of overtime, not five.
    for (const [monday, hoursPerDay] of [
      [utc(2026, 6, 1), 9],
      [utc(2026, 6, 8), 9],
    ] as const) {
      for (let day = 0; day < 5; day++) {
        await shift(
          worker.technicianId,
          new Date(monday.getTime() + day * 86_400_000 + 8 * 3_600_000),
          hoursPerDay,
        );
      }
    }

    const all = await db.timeEntry.findMany({ where: { technicianId: worker.technicianId } });
    await approveTime(db, payCtx, { entryIds: all.map((e) => e.id), approved: true });

    const preview = await payrollPreview(db, payCtx, {
      periodStart: utc(2026, 6, 1),
      periodEnd: utc(2026, 6, 15),
    });

    const line = preview.lines[0];
    expect(line.regularHours).toBe(80);
    expect(line.overtimeHours).toBe(10);

    // 80 at $28.00 plus 10 at time and a half.
    expect(line.baseHourlyCents).toBe(2_800n);
    expect(line.grossCents).toBe(2_800n * 80n + (2_800n * 15n) / 10n * 10n);
    // Employer taxes are payroll tax plus workers' comp; benefits are their own line.
    expect(line.employerTaxCents).toBe(
      (line.grossCents * 765n) / 10_000n + (line.grossCents * 800n) / 10_000n,
    );
    expect(line.benefitsCents).toBe((line.grossCents * 600n) / 10_000n);
    expect(line.totalCostCents).toBe(
      line.grossCents + line.employerTaxCents + line.benefitsCents,
    );
  });

  it('relieves what the jobs accrued, and leaves the difference where it can be seen', async () => {
    const payOrg = await createTestOrg('PayrollAccrual');
    const payCtx = systemContext(payOrg.organizationId);
    const worker = await createTestTechnician(payOrg.organizationId, payOrg.locationId);
    const job = await createTestJob(payOrg.organizationId, payOrg.locationId);

    // The job costs the hour at the loaded rate: that is what credits the liability.
    await postJournalEntry(db, payCtx, {
      entryDate: utc(2026, 7, 8),
      source: 'PAYROLL',
      memo: 'Technician hours',
      lines: laborCostedLines({
        jobId: job.jobId,
        locationId: payOrg.locationId,
        technicianId: worker.technicianId,
        hours: '40',
        baseHourlyCents: 2_800n,
        loadedHourlyCents: 4_056n,
      }),
    });

    const accruedBefore = await trialBalance(db, payCtx, { to: utc(2026, 7, 31) });
    expect(
      accruedBefore.rows.find((r) => r.code === ACCOUNTS.PAYROLL_LIABILITIES)!.balanceCents,
    ).toBe(4_056n * 40n);

    for (let day = 0; day < 5; day++) {
      await shift(
        worker.technicianId,
        new Date(utc(2026, 7, 6).getTime() + day * 86_400_000 + 8 * 3_600_000),
        8,
        job.jobId,
      );
    }
    const entries = await db.timeEntry.findMany({ where: { technicianId: worker.technicianId } });
    await approveTime(db, payCtx, { entryIds: entries.map((e) => e.id), approved: true });

    const { run } = await runPayroll(db, payCtx, {
      periodStart: utc(2026, 7, 6),
      periodEnd: utc(2026, 7, 20),
      payDate: utc(2026, 7, 24),
    });

    expect(run.runNo).toMatch(/^PR-\d{5}$/);
    expect(Number(run.regularHours)).toBe(40);
    expect(Number(run.overtimeHours)).toBe(0);

    const after = await trialBalance(db, payCtx, { to: utc(2026, 7, 31) });
    const liability = after.rows.find((r) => r.code === ACCOUNTS.PAYROLL_LIABILITIES)!;
    const bank = after.rows.find((r) => r.code === ACCOUNTS.BANK_PAYROLL)!;

    // The money left the payroll account; the liability came down by the same amount.
    expect(bank.balanceCents).toBe(-run.totalCostCents);
    expect(liability.balanceCents).toBe(4_056n * 40n - run.totalCostCents);
    expect(after.isBalanced).toBe(true);

    // The residue is the loaded rate being wrong, and the report says by how much.
    const variance = await accrualVariance(db, payCtx);
    expect(variance.accruedCents).toBe(4_056n * 40n);
    expect(variance.paidCents).toBe(run.totalCostCents);
    expect(variance.outstandingCents).toBe(liability.balanceCents);
  });

  it('settles the accrual to nothing once the van is out of it', async () => {
    const payOrg = await createTestOrg('PayrollVan');
    const payCtx = systemContext(payOrg.organizationId);
    const worker = await createTestTechnician(payOrg.organizationId, payOrg.locationId);
    const job = await createTestJob(payOrg.organizationId, payOrg.locationId);

    // The same forty hours, costed with the van and phone separated out of the accrual.
    await postJournalEntry(db, payCtx, {
      entryDate: utc(2026, 9, 7),
      source: 'PAYROLL',
      memo: 'Technician hours',
      lines: laborCostedLines({
        jobId: job.jobId,
        locationId: payOrg.locationId,
        technicianId: worker.technicianId,
        hours: '40',
        baseHourlyCents: 2_800n,
        loadedHourlyCents: 4_056n,
        fixedHourlyCents: 650n,
      }),
    });

    for (let day = 0; day < 5; day++) {
      await shift(
        worker.technicianId,
        new Date(utc(2026, 9, 7).getTime() + day * 86_400_000 + 8 * 3_600_000),
        8,
        job.jobId,
      );
    }
    const entries = await db.timeEntry.findMany({ where: { technicianId: worker.technicianId } });
    await approveTime(db, payCtx, { entryIds: entries.map((e) => e.id), approved: true });

    const { run } = await runPayroll(db, payCtx, {
      periodStart: utc(2026, 9, 7),
      periodEnd: utc(2026, 9, 21),
      payDate: utc(2026, 9, 25),
    });

    const after = await trialBalance(db, payCtx, { to: utc(2026, 9, 30) });
    const liability = after.rows.find((r) => r.code === ACCOUNTS.PAYROLL_LIABILITIES)!;
    const applied = after.rows.find((r) => r.code === ACCOUNTS.VEHICLE_PHONE_APPLIED)!;

    /*
     * This is the whole point: what accrued as payroll is what payroll paid, to within
     * rounding. Eight cents over forty hours is left, and it is real — the loaded rate
     * rounds each hour's payroll tax to the cent while the run applies the rate to the
     * period's gross. Before the van came out of it the residue was $260 on the same
     * forty hours, and no run could ever have settled a penny of it.
     */
    expect(run.totalCostCents).toBe(136_248n);
    expect(liability.balanceCents).toBe((4_056n - 650n) * 40n - run.totalCostCents);
    expect(liability.balanceCents).toBe(-8n);

    // The van and phone are still charged to the job — they are just owed elsewhere. A
    // contra expense carries a credit balance, which the trial balance reports negative.
    expect(applied.balanceCents).toBe(-650n * 40n);
    expect(after.isBalanced).toBe(true);
  });

  it('pays an hour once, and refuses a period that overlaps one already run', async () => {
    const payOrg = await createTestOrg('PayrollOnce');
    const payCtx = systemContext(payOrg.organizationId);
    const worker = await createTestTechnician(payOrg.organizationId, payOrg.locationId);

    for (let day = 0; day < 4; day++) {
      await shift(
        worker.technicianId,
        new Date(utc(2026, 8, 3).getTime() + day * 86_400_000 + 8 * 3_600_000),
        8,
      );
    }
    const entries = await db.timeEntry.findMany({ where: { technicianId: worker.technicianId } });
    await approveTime(db, payCtx, { entryIds: entries.map((e) => e.id), approved: true });

    await runPayroll(db, payCtx, {
      periodStart: utc(2026, 8, 3),
      periodEnd: utc(2026, 8, 17),
      payDate: utc(2026, 8, 21),
    });

    // The same hours are not payable again.
    const second = await payrollPreview(db, payCtx, {
      periodStart: utc(2026, 8, 3),
      periodEnd: utc(2026, 8, 17),
    });
    expect(second.lines.length).toBe(0);

    await expect(
      runPayroll(db, payCtx, {
        periodStart: utc(2026, 8, 10),
        periodEnd: utc(2026, 8, 24),
        payDate: utc(2026, 8, 28),
      }),
    ).rejects.toThrow(/already covers part of that period/);

    // And paid time cannot have its approval taken back.
    await expect(
      approveTime(db, payCtx, { entryIds: [entries[0].id], approved: false }),
    ).rejects.toThrow(/already been paid/);
  });

  it('will not run a period with nothing approved in it', async () => {
    const payOrg = await createTestOrg('PayrollEmpty');
    const payCtx = systemContext(payOrg.organizationId);
    const worker = await createTestTechnician(payOrg.organizationId, payOrg.locationId);
    await shift(worker.technicianId, utc(2026, 9, 7), 8);

    const preview = await payrollPreview(db, payCtx, {
      periodStart: utc(2026, 9, 7),
      periodEnd: utc(2026, 9, 21),
    });
    expect(preview.lines.length).toBe(0);
    expect(preview.unapprovedHours).toBe(8);

    await expect(
      runPayroll(db, payCtx, { periodStart: utc(2026, 9, 7), periodEnd: utc(2026, 9, 21) }),
    ).rejects.toThrow(/No approved hours/);
  });
});
