'use client';

import { useMemo, useState } from 'react';
import { money, type ClientPriceItem, type ClientStockLine } from '../client/store';

export interface PickedLine {
  priceBookItemId: string;
  description: string;
  quantity: string;
  unitPriceCents: bigint;
}

/**
 * Choosing work from the price book, on a tablet, standing up.
 *
 * Search is over SKU and name together, because a technician types "wax" or "P-WAX"
 * depending on what is to hand. Van stock is shown against each part: the difference
 * between quoting something and being able to fit it today.
 *
 * Only the sell price is here. The device was never sent cost.
 */
export function PriceBookPicker({
  items,
  stock,
  onAdd,
}: {
  items: ClientPriceItem[];
  stock: ClientStockLine[];
  onAdd: (line: PickedLine) => void;
}) {
  const [query, setQuery] = useState('');
  const [quantities, setQuantities] = useState<Record<string, number>>({});

  const stockByItem = useMemo(
    () => new Map(stock.map((line) => [line.priceBookItemId, Number(line.quantity)])),
    [stock],
  );

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const pool = needle
      ? items.filter(
          (item) =>
            item.name.toLowerCase().includes(needle) || item.sku.toLowerCase().includes(needle),
        )
      : items;
    return pool.slice(0, 40);
  }, [items, query]);

  const quantityFor = (id: string) => quantities[id] ?? 1;
  const setQuantity = (id: string, value: number) =>
    setQuantities((current) => ({ ...current, [id]: Math.max(0.5, Math.round(value * 2) / 2) }));

  return (
    <div className="space-y-3">
      <input
        type="search"
        inputMode="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search the price book"
        className="field-input"
        autoFocus
      />

      {results.length === 0 && (
        <p className="py-8 text-center text-[var(--color-ink-soft)]">Nothing matches “{query}”.</p>
      )}

      <ul className="space-y-2">
        {results.map((item) => {
          const onVan = stockByItem.get(item.id);
          const quantity = quantityFor(item.id);

          return (
            <li key={item.id} className="card p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-semibold">{item.name}</p>
                  <p className="text-sm text-[var(--color-ink-soft)]">
                    {item.sku}
                    {item.estimatedHours ? ` · ${item.estimatedHours} hrs` : ''}
                    {onVan !== undefined && (
                      <>
                        {' · '}
                        <span className={onVan > 0 ? 'text-[var(--color-go)]' : 'text-[var(--color-stop)]'}>
                          {onVan > 0 ? `${onVan} on van` : 'none on van'}
                        </span>
                      </>
                    )}
                  </p>
                </div>
                <p className="shrink-0 text-right font-semibold tabular-nums">
                  {money(item.priceCents)}
                  <span className="block text-xs font-normal text-[var(--color-ink-soft)]">
                    per {item.unit}
                  </span>
                </p>
              </div>

              <div className="mt-3 flex items-center gap-2">
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setQuantity(item.id, quantity - 0.5)}
                    className="btn btn-quiet px-0 text-xl"
                    style={{ width: '3rem' }}
                    aria-label={`Less ${item.name}`}
                  >
                    −
                  </button>
                  <span className="w-14 text-center text-lg font-semibold tabular-nums">{quantity}</span>
                  <button
                    type="button"
                    onClick={() => setQuantity(item.id, quantity + 0.5)}
                    className="btn btn-quiet px-0 text-xl"
                    style={{ width: '3rem' }}
                    aria-label={`More ${item.name}`}
                  >
                    +
                  </button>
                </div>

                <button
                  type="button"
                  className="btn btn-primary flex-1"
                  onClick={() =>
                    onAdd({
                      priceBookItemId: item.id,
                      description: item.name,
                      quantity: String(quantity),
                      unitPriceCents: item.priceCents,
                    })
                  }
                >
                  Add · {money(item.priceCents * BigInt(Math.round(quantity * 100)) / 100n)}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
