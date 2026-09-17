import { db } from '../src/lib/db';
import { DEMO_PASSWORD } from '../src/lib/demo/seed';
import { resetDemoData } from '../src/lib/demo/reset';
import { formatMoney } from '../src/lib/money';
import { systemContext } from '../src/lib/auth/context';
import { balanceSheet, incomeStatement, profitByLocation, trialBalance } from '../src/lib/accounting/reports';

/**
 * Build the demo company.
 *
 *   npm run db:seed                       1200 jobs over twelve months
 *   DEMO_JOBS=300 npm run db:seed         a smaller, faster dataset
 *   DEMO_SEED=42 npm run db:seed          a different but equally reproducible company
 */
async function main() {
  // Left unset, the seeder derives the job count from headcount and a realistic
  // utilization rate — passing a number here unconditionally would override that.
  const jobCount = process.env.DEMO_JOBS ? Number(process.env.DEMO_JOBS) : undefined;
  const seed = Number(process.env.DEMO_SEED ?? 20260917);

  console.log(
    `Seeding demo company (${jobCount ?? 'volume derived from headcount'}, seed ${seed})\n`,
  );

  const result = await resetDemoData(db, {
    jobCount,
    seed,
    onProgress: (message) => console.log(`  ${message}`),
  });

  const ctx = systemContext(result.organizationId);
  const today = new Date();
  const yearStart = new Date(Date.UTC(today.getUTCFullYear() - 1, today.getUTCMonth(), 1));

  const tb = await trialBalance(db, ctx, {});
  const bs = await balanceSheet(db, ctx, today);
  const byLocation = await profitByLocation(db, ctx, { from: yearStart, to: today });
  const pl = await incomeStatement(db, ctx, { from: yearStart, to: today });

  console.log('\nSeeded:');
  for (const [key, value] of Object.entries(result.counts)) {
    console.log(`  ${key.padEnd(16)} ${value}`);
  }

  console.log('\nTrailing twelve months by branch:');
  console.log('  Branch          Revenue        COGS     Gross profit   Margin');
  for (const row of byLocation) {
    console.log(
      `  ${row.locationName.padEnd(12)} ${formatMoney(row.revenueCents).padStart(12)} ` +
        `${formatMoney(row.cogsCents).padStart(11)} ${formatMoney(row.grossProfitCents).padStart(14)} ` +
        `${row.grossMarginPercent.toFixed(1).padStart(7)}%`,
    );
  }

  console.log('\nTrailing twelve months, consolidated:');
  console.log(`  Revenue              ${formatMoney(pl.revenue.totalCents).padStart(14)}`);
  console.log(`  Cost of goods sold   ${formatMoney(pl.costOfGoodsSold.totalCents).padStart(14)}`);
  console.log(`  Gross profit         ${formatMoney(pl.grossProfitCents).padStart(14)}  ${pl.grossMarginPercent.toFixed(1)}%`);
  console.log(`  Operating expenses   ${formatMoney(pl.operatingExpenses.totalCents).padStart(14)}`);
  console.log(`  Net income           ${formatMoney(pl.netIncomeCents).padStart(14)}  ${
    pl.revenue.totalCents === 0n
      ? '0.0'
      : (Number((pl.netIncomeCents * 1000n) / pl.revenue.totalCents) / 10).toFixed(1)
  }%`);

  console.log('\nLedger:');
  console.log(`  Trial balance debits   ${formatMoney(tb.totalDebitsCents).padStart(14)}`);
  console.log(`  Trial balance credits  ${formatMoney(tb.totalCreditsCents).padStart(14)}`);
  console.log(`  Balanced               ${tb.isBalanced ? 'yes' : 'NO — investigate'}`);
  console.log(`  Balance sheet ties     ${bs.isBalanced ? 'yes' : 'NO — investigate'}`);

  console.log(`\nSign in as any of these with password: ${DEMO_PASSWORD}`);
  for (const account of result.signIn) console.log(`  ${account.email}`);

  console.log(`\nDone in ${(result.elapsedMs / 1000).toFixed(1)}s`);

  if (!tb.isBalanced || !bs.isBalanced) {
    throw new Error('Seed produced an unbalanced ledger');
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
