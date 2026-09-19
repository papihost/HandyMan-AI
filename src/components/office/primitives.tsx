import { formatMoney } from '../../lib/money';

/** Money, right-aligned and tabular so a column of figures lines up. */
export function Money({ cents, bold }: { cents: bigint; bold?: boolean }) {
  return (
    <span className={`tabular-nums ${bold ? 'font-semibold' : ''}`}>{formatMoney(cents)}</span>
  );
}

export function Percent({ value, decimals = 1 }: { value: number; decimals?: number }) {
  return <span className="tabular-nums">{value.toFixed(decimals)}%</span>;
}

/**
 * A headline number.
 *
 * A single current value is a stat tile, not a one-bar bar chart. The figure uses
 * proportional figures because it stands alone; only columns need tabular ones.
 */
export function StatTile({
  label,
  value,
  note,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  note?: string;
  tone?: 'neutral' | 'good' | 'warning' | 'critical';
}) {
  const toneColor =
    tone === 'good'
      ? 'var(--good-ink)'
      : tone === 'warning'
        ? 'var(--serious)'
        : tone === 'critical'
          ? 'var(--critical)'
          : 'var(--ink)';

  return (
    <div className="panel p-4">
      <p className="text-xs font-bold uppercase tracking-wide" style={{ color: 'var(--ink-muted)' }}>
        {label}
      </p>
      <p className="mt-1.5 text-3xl font-semibold" style={{ color: toneColor }}>
        {value}
      </p>
      {note && (
        <p className="mt-1 text-sm" style={{ color: 'var(--ink-2)' }}>
          {note}
        </p>
      )}
    </div>
  );
}

/**
 * A horizontal magnitude bar.
 *
 * Thin mark, rounded data end, anchored to the baseline. Sequential blue by default —
 * one hue, more is longer. `emphasis` paints one bar in a status colour when that bar is
 * the point of the chart; it always ships beside a label, never as colour alone.
 */
export function Bar({
  value,
  max,
  emphasis,
  label,
}: {
  value: number;
  max: number;
  emphasis?: 'critical' | 'good';
  label?: string;
}) {
  const width = max <= 0 ? 0 : Math.max(0, Math.min(100, (value / max) * 100));
  const color =
    emphasis === 'critical'
      ? 'var(--critical)'
      : emphasis === 'good'
        ? 'var(--good)'
        : 'var(--seq)';

  return (
    <div
      className="h-2.5 w-full overflow-hidden rounded-full"
      style={{ background: 'var(--grid)' }}
      role="img"
      aria-label={label}
    >
      <div
        className="h-full rounded-full"
        style={{ width: `${width}%`, background: color, minWidth: width > 0 ? '0.5rem' : 0 }}
      />
    </div>
  );
}

/**
 * A status flag.
 *
 * Status colour never carries meaning alone: the mark always arrives with a word beside
 * it, so it survives colour blindness, printing and forced-colors.
 */
export function Flag({
  tone,
  children,
}: {
  tone: 'good' | 'warning' | 'serious' | 'critical';
  children: React.ReactNode;
}) {
  const color = `var(--${tone})`;
  const glyph = tone === 'good' ? '●' : tone === 'critical' ? '▲' : '◆';

  return (
    <span className="inline-flex items-center gap-1.5 text-sm font-semibold" style={{ color }}>
      <span aria-hidden>{glyph}</span>
      {children}
    </span>
  );
}

export function Panel({
  title,
  action,
  children,
  subtitle,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="panel overflow-hidden">
      <header className="flex items-baseline justify-between gap-4 px-4 pt-4">
        <div>
          <h2 className="font-semibold">{title}</h2>
          {subtitle && (
            <p className="text-sm" style={{ color: 'var(--ink-2)' }}>
              {subtitle}
            </p>
          )}
        </div>
        {action}
      </header>
      <div className="mt-3">{children}</div>
    </section>
  );
}

export function statusTone(status: string): 'good' | 'warning' | 'serious' | 'critical' | null {
  if (['PAID', 'COMPLETED', 'CLOSED'].includes(status)) return 'good';
  if (['IN_PROGRESS', 'EN_ROUTE'].includes(status)) return 'warning';
  if (['ON_HOLD', 'OVERDUE'].includes(status)) return 'critical';
  return null;
}
