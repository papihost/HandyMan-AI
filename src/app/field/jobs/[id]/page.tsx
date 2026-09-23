'use client';

import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  actions,
  jobTotal,
  loadJob,
  loadPriceBook,
  loadVanStock,
  localPhotos,
  money,
  type ClientJob,
  type ClientPriceItem,
  type ClientStockLine,
} from '../../../../client/store';
import { subscribe } from '../../../../client/sync';
import { PriceBookPicker, type PickedLine } from '../../../../components/PriceBookPicker';
import { Sheet } from '../../../../components/Sheet';
import { SignaturePad } from '../../../../components/SignaturePad';

type SheetName = 'work' | 'parts' | 'changeOrder' | 'quote' | 'payment' | 'complete' | null;

/** Best-effort position. A technician in a plant room has no GPS and must not be blocked. */
function currentPosition(): Promise<GeolocationCoordinates | undefined> {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(undefined);
    navigator.geolocation.getCurrentPosition(
      (position) => resolve(position.coords),
      () => resolve(undefined),
      { enableHighAccuracy: true, timeout: 4000, maximumAge: 60_000 },
    );
  });
}

export default function JobPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [job, setJob] = useState<ClientJob | null | undefined>(undefined);
  const [priceBook, setPriceBook] = useState<ClientPriceItem[]>([]);
  const [stock, setStock] = useState<ClientStockLine[]>([]);
  const [photos, setPhotos] = useState<{ storageKey: string; blob: Blob; stage: string }[]>([]);
  const [sheet, setSheet] = useState<SheetName>(null);
  const [clockedIn, setClockedIn] = useState(false);

  const reload = useCallback(async () => {
    const [loaded, book, van, shots] = await Promise.all([
      loadJob(id),
      loadPriceBook(),
      loadVanStock(),
      localPhotos(id),
    ]);
    setJob(loaded);
    setPriceBook(book);
    setStock(van);
    setPhotos(shots);
  }, [id]);

  useEffect(() => {
    void reload();
    return subscribe(() => void reload());
  }, [reload]);

  if (job === undefined) return <p className="py-12 text-center text-[var(--color-ink-soft)]">Loading…</p>;

  if (job === null) {
    return (
      <div className="card p-8 text-center">
        <p className="text-lg font-semibold">This job is no longer yours</p>
        <p className="mt-1 text-[var(--color-ink-soft)]">
          It was reassigned or closed. Nothing you recorded has been lost.
        </p>
        <button type="button" onClick={() => router.replace('/field')} className="btn btn-quiet mt-5">
          Back to my day
        </button>
      </div>
    );
  }

  const total = jobTotal(job);
  const done = job.status === 'COMPLETED';

  return (
    <div className="space-y-4">
      <JobHeader job={job} />
      <SiteCard job={job} />

      {!done && (
        <ActionBar
          job={job}
          clockedIn={clockedIn}
          onStatus={async (status) => {
            await actions.setStatus(job.id, status);
            await reload();
          }}
          onClock={async (direction) => {
            const position = await currentPosition();
            if (direction === 'in') {
              await actions.clockIn(job.id, position);
              setClockedIn(true);
            } else {
              await actions.clockOut(job.id, position);
              setClockedIn(false);
            }
            await reload();
          }}
        />
      )}

      <WorkCard
        job={job}
        total={total}
        readOnly={done}
        onAddWork={() => setSheet('work')}
        onChangeOrder={() => setSheet('changeOrder')}
      />

      <PartsCard stock={stock} readOnly={done} onUse={() => setSheet('parts')} />

      <QuoteCard onQuote={() => setSheet('quote')} />

      <PaymentCard job={job} total={total} onTake={() => setSheet('payment')} />

      <PhotoCard
        photos={photos}
        serverCount={job.photoCount}
        onCapture={async (blob, stage) => {
          await actions.capturePhoto(job.id, blob, { stage, position: await currentPosition() });
          await reload();
        }}
      />

      {job.history.length > 0 && <HistoryCard job={job} />}

      {!done && (
        <button type="button" onClick={() => setSheet('complete')} className="btn btn-go w-full py-4 text-lg">
          Finish job
        </button>
      )}

      {done && (
        <div className="card border-[var(--color-go)] p-4 text-center">
          <p className="font-semibold text-[var(--color-go)]">Job complete</p>
          <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
            The office has everything. Nothing else to do here.
          </p>
        </div>
      )}

      <AddWorkSheet
        open={sheet === 'work'}
        items={priceBook}
        stock={stock}
        onClose={() => setSheet(null)}
        onConfirm={async (lines) => {
          await actions.addLines(job.id, lines);
          setSheet(null);
          await reload();
        }}
      />

      <PartsSheet
        open={sheet === 'parts'}
        stock={stock}
        onClose={() => setSheet(null)}
        onConfirm={async (lines) => {
          await actions.consumeParts(job.id, lines);
          setSheet(null);
          await reload();
        }}
      />

      <QuoteSheet
        open={sheet === 'quote'}
        items={priceBook}
        stock={stock}
        onClose={() => setSheet(null)}
        onConfirm={async (input) => {
          await actions.createQuote(job.id, {
            title: input.title,
            options: input.options.map((option) => ({
              name: option.name,
              isRecommended: option.isRecommended,
              lines: option.lines.map((line) => ({
                priceBookItemId: line.priceBookItemId,
                quantity: line.quantity,
              })),
            })),
            selectedOptionName: input.selectedOptionName,
            signatureDataUrl: input.signatureDataUrl,
            signerName: input.signerName,
          });
          setSheet(null);
          await reload();
        }}
      />

      <ChangeOrderSheet
        open={sheet === 'changeOrder'}
        items={priceBook}
        stock={stock}
        onClose={() => setSheet(null)}
        onConfirm={async (input) => {
          await actions.createChangeOrder(job.id, input);
          setSheet(null);
          await reload();
        }}
      />

      <PaymentSheet
        open={sheet === 'payment'}
        total={total}
        taken={takenSoFar(job)}
        onClose={() => setSheet(null)}
        onConfirm={async (input) => {
          await actions.collectPayment(job.id, input);
          setSheet(null);
          await reload();
        }}
      />

      <CompleteSheet
        open={sheet === 'complete'}
        job={job}
        total={total}
        onClose={() => setSheet(null)}
        onConfirm={async (signerName, dataUrl) => {
          if (dataUrl) {
            await actions.captureSignature(job.id, dataUrl, {
              kind: 'COMPLETION',
              signerName,
              documentHash: `total:${total.toString()}`,
            });
          }
          await actions.setStatus(job.id, 'COMPLETED');
          setSheet(null);
          await reload();
        }}
      />
    </div>
  );
}

function JobHeader({ job }: { job: ClientJob }) {
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-[var(--color-ink-soft)]">{job.jobNo}</span>
        <span className="rounded-full bg-black/5 px-2.5 py-0.5 text-xs font-bold">
          {job.status.replace('_', ' ')}
        </span>
        {job.isWarranty && (
          <span className="rounded-full bg-[var(--color-stop)]/12 px-2.5 py-0.5 text-xs font-bold text-[var(--color-stop)]">
            CALLBACK — NOT BILLABLE
          </span>
        )}
      </div>
      <h1 className="mt-1 text-2xl font-bold">{job.title}</h1>
      {job.description && <p className="mt-1 text-[var(--color-ink-soft)]">{job.description}</p>}
    </div>
  );
}

function SiteCard({ job }: { job: ClientJob }) {
  const address = `${job.property.addressLine1}, ${job.property.city}, ${job.property.state} ${job.property.postalCode}`;

  return (
    <section className="card space-y-3 p-4">
      <div>
        <p className="text-lg font-semibold">{job.customer.name}</p>
        <p className="text-[var(--color-ink-soft)]">{address}</p>
      </div>

      {/* The two things a technician taps on arrival, side by side and thumb-sized. */}
      <div className="flex gap-2">
        {job.customer.phone && (
          <a href={`tel:${job.customer.phone}`} className="btn btn-quiet flex-1">
            Call
          </a>
        )}
        <a
          href={`https://maps.google.com/?q=${encodeURIComponent(address)}`}
          target="_blank"
          rel="noreferrer"
          className="btn btn-quiet flex-1"
        >
          Directions
        </a>
      </div>

      {job.property.accessNotes && (
        <p
          className="rounded-xl px-3 py-2.5 text-sm font-medium"
          style={{ background: 'var(--color-brand-soft)' }}
        >
          <span className="font-bold">Getting in: </span>
          {job.property.accessNotes}
        </p>
      )}

      {job.property.equipment.length > 0 && (
        <ul className="space-y-1 text-sm text-[var(--color-ink-soft)]">
          {job.property.equipment.map((item) => (
            <li key={item.id}>
              {item.name}
              {item.modelNumber ? ` · ${item.modelNumber}` : ''}
              {item.serialNumber ? ` · s/n ${item.serialNumber}` : ''}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ActionBar({
  job,
  clockedIn,
  onStatus,
  onClock,
}: {
  job: ClientJob;
  clockedIn: boolean;
  onStatus: (status: string) => Promise<void>;
  onClock: (direction: 'in' | 'out') => Promise<void>;
}) {
  const before = ['SCHEDULED', 'DISPATCHED', 'APPROVED', 'DRAFT'].includes(job.status);
  const enRoute = job.status === 'EN_ROUTE';

  return (
    <div className="grid grid-cols-2 gap-2">
      {before && (
        <button type="button" onClick={() => void onStatus('EN_ROUTE')} className="btn btn-primary col-span-2 py-4">
          On my way
        </button>
      )}
      {enRoute && (
        <button type="button" onClick={() => void onStatus('IN_PROGRESS')} className="btn btn-primary col-span-2 py-4">
          Arrived — start work
        </button>
      )}
      <button
        type="button"
        onClick={() => void onClock(clockedIn ? 'out' : 'in')}
        className={`btn ${clockedIn ? 'btn-quiet' : 'btn-go'} col-span-2 py-4`}
      >
        {clockedIn ? 'Clock out' : 'Clock in'}
      </button>
    </div>
  );
}

function WorkCard({
  job,
  total,
  readOnly,
  onAddWork,
  onChangeOrder,
}: {
  job: ClientJob;
  total: bigint;
  readOnly: boolean;
  onAddWork: () => void;
  onChangeOrder: () => void;
}) {
  return (
    <section className="card p-4">
      <div className="flex items-center justify-between">
        <h2 className="font-bold">Work</h2>
        <p className="text-lg font-bold tabular-nums">{money(total)}</p>
      </div>

      <ul className="mt-3 space-y-2">
        {job.lines.length === 0 && (
          <li className="py-4 text-center text-[var(--color-ink-soft)]">Nothing added yet.</li>
        )}
        {job.lines.map((line) => (
          <li key={line.id} className="flex items-baseline justify-between gap-3 text-sm">
            <span className="min-w-0">
              <span className="font-medium">{line.description}</span>
              <span className="text-[var(--color-ink-soft)]"> × {line.quantity}</span>
              {line.id.startsWith('pending') && (
                <span className="ml-2 rounded bg-[var(--color-brand)]/12 px-1.5 py-0.5 text-xs font-semibold text-[var(--color-brand)]">
                  not sent
                </span>
              )}
            </span>
            <span className="shrink-0 tabular-nums">{money(line.unitPriceCents)}</span>
          </li>
        ))}
      </ul>

      {!readOnly && (
        <div className="mt-4 flex gap-2">
          <button type="button" onClick={onAddWork} className="btn btn-primary flex-1">
            Add work
          </button>
          <button type="button" onClick={onChangeOrder} className="btn btn-quiet flex-1">
            Found extra work
          </button>
        </div>
      )}
    </section>
  );
}

function PartsCard({
  stock,
  readOnly,
  onUse,
}: {
  stock: ClientStockLine[];
  readOnly: boolean;
  onUse: () => void;
}) {
  const carrying = stock.filter((line) => Number(line.quantity) > 0);

  return (
    <section className="card p-4">
      <div className="flex items-center justify-between">
        <h2 className="font-bold">On the van</h2>
        <span className="text-sm text-[var(--color-ink-soft)]">{carrying.length} items</span>
      </div>

      {!readOnly && (
        <button type="button" onClick={onUse} className="btn btn-quiet mt-3 w-full">
          Record parts used
        </button>
      )}
    </section>
  );
}

function PhotoCard({
  photos,
  serverCount,
  onCapture,
}: {
  photos: { storageKey: string; blob: Blob; stage: string }[];
  serverCount: number;
  onCapture: (blob: Blob, stage: string) => Promise<void>;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [stage, setStage] = useState('BEFORE');
  const [urls, setUrls] = useState<Record<string, string>>({});

  useEffect(() => {
    const made: Record<string, string> = {};
    for (const photo of photos) made[photo.storageKey] = URL.createObjectURL(photo.blob);
    setUrls(made);
    return () => {
      for (const url of Object.values(made)) URL.revokeObjectURL(url);
    };
  }, [photos]);

  return (
    <section className="card p-4">
      <div className="flex items-center justify-between">
        <h2 className="font-bold">Photos</h2>
        <span className="text-sm text-[var(--color-ink-soft)]">{serverCount} sent</span>
      </div>

      <div className="mt-3 flex gap-2">
        {['BEFORE', 'DURING', 'AFTER'].map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setStage(option)}
            className={`btn flex-1 text-sm ${stage === option ? 'btn-primary' : 'btn-quiet'}`}
          >
            {option[0] + option.slice(1).toLowerCase()}
          </button>
        ))}
      </div>

      {photos.length > 0 && (
        <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
          {photos.map((photo) => (
            <div key={photo.storageKey} className="relative shrink-0">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={urls[photo.storageKey]}
                alt={`${photo.stage.toLowerCase()} photo`}
                className="size-24 rounded-lg object-cover"
              />
              <span className="absolute bottom-1 left-1 rounded bg-black/60 px-1.5 text-[10px] font-bold text-white">
                {photo.stage}
              </span>
            </div>
          ))}
        </div>
      )}

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        // Opens the camera straight away on a tablet rather than a file browser.
        capture="environment"
        className="hidden"
        onChange={async (event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) await onCapture(file, stage);
        }}
      />

      <button type="button" onClick={() => inputRef.current?.click()} className="btn btn-quiet mt-3 w-full">
        Take {stage.toLowerCase()} photo
      </button>
    </section>
  );
}

function HistoryCard({ job }: { job: ClientJob }) {
  return (
    <section className="card p-4">
      <h2 className="font-bold">Been here before</h2>
      <ul className="mt-2 space-y-1.5 text-sm">
        {job.history.map((visit) => (
          <li key={visit.jobNo} className="flex items-baseline justify-between gap-3">
            <span className="min-w-0 truncate">
              {visit.title}
              {visit.isWarranty && (
                <span className="ml-2 text-xs font-bold text-[var(--color-stop)]">CALLBACK</span>
              )}
            </span>
            <span className="shrink-0 text-[var(--color-ink-soft)]">
              {visit.completedAt ? new Date(visit.completedAt).toLocaleDateString() : '—'}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function useBasket() {
  const [basket, setBasket] = useState<PickedLine[]>([]);
  const add = (line: PickedLine) => setBasket((current) => [...current, line]);
  const clear = () => setBasket([]);
  const total = basket.reduce(
    (sum, line) => sum + (line.unitPriceCents * BigInt(Math.round(Number(line.quantity) * 100))) / 100n,
    0n,
  );
  return { basket, add, clear, total };
}

function AddWorkSheet({
  open,
  items,
  stock,
  onClose,
  onConfirm,
}: {
  open: boolean;
  items: ClientPriceItem[];
  stock: ClientStockLine[];
  onClose: () => void;
  onConfirm: (lines: PickedLine[]) => Promise<void>;
}) {
  const { basket, add, clear, total } = useBasket();

  return (
    <Sheet
      open={open}
      title="Add work"
      onClose={() => {
        clear();
        onClose();
      }}
      footer={
        <button
          type="button"
          disabled={basket.length === 0}
          onClick={async () => {
            await onConfirm(basket);
            clear();
          }}
          className="btn btn-primary w-full py-4 disabled:opacity-50"
        >
          Add {basket.length} {basket.length === 1 ? 'line' : 'lines'} · {money(total)}
        </button>
      }
    >
      <PriceBookPicker items={items} stock={stock} onAdd={add} />
    </Sheet>
  );
}

function PartsSheet({
  open,
  stock,
  onClose,
  onConfirm,
}: {
  open: boolean;
  stock: ClientStockLine[];
  onClose: () => void;
  onConfirm: (lines: { priceBookItemId: string; quantity: string }[]) => Promise<void>;
}) {
  const [used, setUsed] = useState<Record<string, number>>({});

  const lines = Object.entries(used)
    .filter(([, quantity]) => quantity > 0)
    .map(([priceBookItemId, quantity]) => ({ priceBookItemId, quantity: String(quantity) }));

  return (
    <Sheet
      open={open}
      title="Parts used"
      onClose={() => {
        setUsed({});
        onClose();
      }}
      footer={
        <button
          type="button"
          disabled={lines.length === 0}
          onClick={async () => {
            await onConfirm(lines);
            setUsed({});
          }}
          className="btn btn-primary w-full py-4 disabled:opacity-50"
        >
          Take {lines.length} off the van
        </button>
      }
    >
      <ul className="space-y-2">
        {stock
          .filter((line) => Number(line.quantity) > 0)
          .map((line) => {
            const quantity = used[line.priceBookItemId] ?? 0;
            const onVan = Number(line.quantity);

            return (
              <li key={line.priceBookItemId} className="card flex items-center gap-3 p-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold">{line.name}</p>
                  <p className="text-sm text-[var(--color-ink-soft)]">
                    {line.sku} · {onVan} on van
                  </p>
                </div>

                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() =>
                      setUsed((c) => ({ ...c, [line.priceBookItemId]: Math.max(0, quantity - 1) }))
                    }
                    className="btn btn-quiet px-0 text-xl"
                    style={{ width: '3rem' }}
                    aria-label={`Fewer ${line.name}`}
                  >
                    −
                  </button>
                  <span className="w-10 text-center text-lg font-semibold tabular-nums">{quantity}</span>
                  <button
                    type="button"
                    // Capped at what is actually on the truck: booking out stock you do
                    // not have is how van counts drift.
                    onClick={() =>
                      setUsed((c) => ({ ...c, [line.priceBookItemId]: Math.min(onVan, quantity + 1) }))
                    }
                    className="btn btn-quiet px-0 text-xl"
                    style={{ width: '3rem' }}
                    aria-label={`More ${line.name}`}
                  >
                    +
                  </button>
                </div>
              </li>
            );
          })}
      </ul>
    </Sheet>
  );
}

function ChangeOrderSheet({
  open,
  items,
  stock,
  onClose,
  onConfirm,
}: {
  open: boolean;
  items: ClientPriceItem[];
  stock: ClientStockLine[];
  onClose: () => void;
  onConfirm: (input: {
    reason: string;
    lines: PickedLine[];
    signatureDataUrl?: string;
    signerName?: string;
  }) => Promise<void>;
}) {
  const { basket, add, clear, total } = useBasket();
  const [reason, setReason] = useState('');
  const [signerName, setSignerName] = useState('');
  const [signature, setSignature] = useState<string | null>(null);

  const reset = () => {
    clear();
    setReason('');
    setSignerName('');
    setSignature(null);
  };

  const ready = reason.trim().length > 3 && basket.length > 0 && !!signature && signerName.trim().length > 1;

  return (
    <Sheet
      open={open}
      title="Extra work found"
      onClose={() => {
        reset();
        onClose();
      }}
      footer={
        <button
          type="button"
          disabled={!ready}
          onClick={async () => {
            await onConfirm({
              reason,
              lines: basket,
              signatureDataUrl: signature ?? undefined,
              signerName,
            });
            reset();
          }}
          className="btn btn-go w-full py-4 disabled:opacity-50"
        >
          Approve · {money(total)}
        </button>
      }
    >
      <div className="space-y-4">
        <p className="rounded-xl px-3 py-2.5 text-sm" style={{ background: 'var(--color-brand-soft)' }}>
          Get this signed <span className="font-bold">before</span> you start the extra work. An
          unsigned change is work the company does for free.
        </p>

        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-[var(--color-ink-soft)]">What did you find?</span>
          <input
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Flange cracked under the bowl"
            className="field-input"
          />
        </label>

        <div>
          <p className="mb-2 text-sm font-medium text-[var(--color-ink-soft)]">Extra work</p>
          {basket.length > 0 && (
            <ul className="mb-3 space-y-1 text-sm">
              {basket.map((line, index) => (
                <li key={index} className="flex justify-between">
                  <span>
                    {line.description} × {line.quantity}
                  </span>
                  <span className="tabular-nums">{money(line.unitPriceCents)}</span>
                </li>
              ))}
            </ul>
          )}
          <PriceBookPicker items={items} stock={stock} onAdd={add} />
        </div>

        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-[var(--color-ink-soft)]">Customer name</span>
          <input
            value={signerName}
            onChange={(event) => setSignerName(event.target.value)}
            className="field-input"
          />
        </label>

        <SignaturePad onChange={setSignature} label="Customer approves the extra work" />
      </div>
    </Sheet>
  );
}

/**
 * The prompt to quote something else.
 *
 * Deliberately its own card rather than a third button under the job's work: what the
 * technician is being asked is not "add to this job", it is "you are standing in a house,
 * did you see anything". Those are different questions and putting them side by side gets
 * the wrong one answered.
 */
function QuoteCard({ onQuote }: { onQuote: () => void }) {
  return (
    <section className="card p-4">
      <h2 className="font-bold">Spotted something else?</h2>
      <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
        Quote it now, while you are in front of them. Works with no signal.
      </p>
      <button type="button" onClick={onQuote} className="btn btn-quiet mt-3 w-full">
        Quote some work
      </button>
    </section>
  );
}

/**
 * A quote written at the kitchen table.
 *
 * Three prices, not one. A customer given a single number decides whether to do the work;
 * a customer given three decides which one — and the middle option is the one most people
 * take, which is why it is the one marked as recommended.
 *
 * Everything here comes off the price book already on the device, so it composes with no
 * signal. Signing is optional: sometimes the answer is "leave it with me", and a quote
 * with nobody's name on it is still a quote the office can chase.
 */
const TIERS = ['Good', 'Better', 'Best'] as const;

function QuoteSheet({
  open,
  items,
  stock,
  onClose,
  onConfirm,
}: {
  open: boolean;
  items: ClientPriceItem[];
  stock: ClientStockLine[];
  onClose: () => void;
  onConfirm: (input: {
    title: string;
    options: { name: string; isRecommended: boolean; lines: PickedLine[] }[];
    selectedOptionName: string;
    signatureDataUrl?: string;
    signerName?: string;
  }) => Promise<void>;
}) {
  const [title, setTitle] = useState('');
  const [optionCount, setOptionCount] = useState(1);
  const [active, setActive] = useState(0);
  const [baskets, setBaskets] = useState<PickedLine[][]>([[], [], []]);
  const [recommended, setRecommended] = useState(0);
  const [signerName, setSignerName] = useState('');
  const [signature, setSignature] = useState<string | null>(null);

  const reset = () => {
    setTitle('');
    setOptionCount(1);
    setActive(0);
    setBaskets([[], [], []]);
    setRecommended(0);
    setSignerName('');
    setSignature(null);
  };

  const totalOf = (lines: PickedLine[]) =>
    lines.reduce(
      (sum, line) =>
        sum + (line.unitPriceCents * BigInt(Math.round(Number(line.quantity) * 100))) / 100n,
      0n,
    );

  const add = (line: PickedLine) =>
    setBaskets((current) =>
      current.map((basket, index) => (index === active ? [...basket, line] : basket)),
    );

  const filled = baskets.slice(0, optionCount).filter((basket) => basket.length > 0);
  const ready = title.trim().length > 2 && filled.length > 0;
  const signed = !!signature && signerName.trim().length > 1;

  return (
    <Sheet
      open={open}
      title="Quote some work"
      onClose={() => {
        reset();
        onClose();
      }}
      footer={
        <button
          type="button"
          disabled={!ready}
          onClick={async () => {
            await onConfirm({
              title,
              options: baskets
                .slice(0, optionCount)
                .map((lines, index) => ({
                  name: optionCount === 1 ? 'Proposed work' : TIERS[index],
                  isRecommended: index === recommended,
                  lines,
                }))
                .filter((option) => option.lines.length > 0),
              selectedOptionName: optionCount === 1 ? 'Proposed work' : TIERS[active],
              signatureDataUrl: signed ? signature! : undefined,
              signerName: signed ? signerName : undefined,
            });
            reset();
          }}
          className="btn btn-go w-full py-4 disabled:opacity-50"
        >
          {signed
            ? `Accepted · ${money(totalOf(baskets[active]))}`
            : filled.length > 1
              ? `Save ${filled.length} options`
              : 'Save quote'}
        </button>
      }
    >
      <div className="space-y-4">
        <p className="rounded-xl px-3 py-2.5 text-sm" style={{ background: 'var(--color-brand-soft)' }}>
          For work that is <span className="font-bold">not</span> this job. Found something on
          the way past? Quote it while you are standing in front of them.
        </p>

        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-[var(--color-ink-soft)]">What is it for?</span>
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Water heater looks close to going"
            className="field-input"
          />
        </label>

        {optionCount > 1 && (
          <div className="flex gap-2">
            {TIERS.slice(0, optionCount).map((tier, index) => (
              <button
                key={tier}
                type="button"
                onClick={() => setActive(index)}
                className="tap flex-1 rounded-xl border px-2 py-2 text-center"
                style={{
                  borderColor: index === active ? 'var(--color-brand)' : 'var(--color-line)',
                  background: index === active ? 'var(--color-brand-soft)' : 'transparent',
                }}
              >
                <span className="block text-sm font-bold">{tier}</span>
                <span className="block text-xs tabular-nums text-[var(--color-ink-soft)]">
                  {money(totalOf(baskets[index]))}
                </span>
              </button>
            ))}
          </div>
        )}

        {optionCount > 1 && (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={recommended === active}
              onChange={() => setRecommended(active)}
            />
            <span>Recommend {TIERS[active]}</span>
          </label>
        )}

        <div>
          <div className="mb-2 flex items-center justify-between">
            <p className="text-sm font-medium text-[var(--color-ink-soft)]">
              {optionCount > 1 ? `What ${TIERS[active]} includes` : 'What the work is'}
            </p>
            {optionCount < TIERS.length && (
              <button
                type="button"
                onClick={() => {
                  setOptionCount((count) => count + 1);
                  setActive(optionCount);
                }}
                className="text-sm font-semibold"
                style={{ color: 'var(--color-brand)' }}
              >
                + another option
              </button>
            )}
          </div>

          {baskets[active].length > 0 && (
            <ul className="mb-3 space-y-1 text-sm">
              {baskets[active].map((line, index) => (
                <li key={index} className="flex justify-between">
                  <span>
                    {line.description} × {line.quantity}
                  </span>
                  <span className="tabular-nums">{money(line.unitPriceCents)}</span>
                </li>
              ))}
            </ul>
          )}
          <PriceBookPicker items={items} stock={stock} onAdd={add} />
        </div>

        <div className="card p-4">
          <p className="text-sm font-medium text-[var(--color-ink-soft)]">
            If they say yes now
          </p>
          <label className="mt-2 block space-y-1.5">
            <span className="text-sm">Customer name</span>
            <input
              value={signerName}
              onChange={(event) => setSignerName(event.target.value)}
              className="field-input"
            />
          </label>
          <div className="mt-3">
            <SignaturePad
              onChange={setSignature}
              label={`Customer accepts ${optionCount > 1 ? TIERS[active] : 'this quote'}`}
            />
          </div>
          <p className="mt-2 text-xs text-[var(--color-ink-soft)]">
            Leave this blank and the quote goes to the office to follow up.
          </p>
        </div>
      </div>
    </Sheet>
  );
}

/** What has been collected against this call, queued payments included. */
function takenSoFar(job: ClientJob): bigint {
  return (job.payments ?? []).reduce((total, payment) => total + payment.amountCents, 0n);
}

const METHOD_LABEL: Record<string, string> = {
  CASH: 'Cash',
  CHECK: 'Cheque',
  CARD: 'Card',
  ACH: 'Bank transfer',
  FINANCING: 'Finance',
  OTHER: 'Other',
};

/**
 * Money taken at the door.
 *
 * Most of a handyman shop's cash-flow problem is the gap between finishing a job and being
 * paid for it, and the cheapest way to close that gap is to ask while you are still
 * standing there. So this is a card of its own rather than a line in the completion sheet:
 * it is worth interrupting for, and it is still worth offering after the job is finished,
 * because the customer often goes to find their chequebook while the tech packs up.
 */
function PaymentCard({
  job,
  total,
  onTake,
}: {
  job: ClientJob;
  total: bigint;
  onTake: () => void;
}) {
  const taken = takenSoFar(job);
  const outstanding = total - taken;
  /*
   * What the office has already done with this job decides what to say here.
   *
   * A job the office has been paid for must not invite the technician to collect it again
   * — the customer settled by card last week and nobody on the doorstep knows. A job that
   * has been invoiced can still be paid in the field; it just goes against that invoice
   * rather than sitting as money on account.
   */
  const settled = job.status === 'PAID' || job.status === 'CLOSED';
  const billed = job.status === 'INVOICED';

  if (settled) {
    return (
      <section className="card p-4">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="font-bold">Payment</h2>
          <span className="text-sm text-[var(--color-ink-soft)]">{money(total)}</span>
        </div>
        <p className="mt-1 font-semibold text-[var(--color-go)]">Already paid for</p>
        <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
          The office has this one settled. Do not ask again.
        </p>
      </section>
    );
  }

  return (
    <section className="card p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-bold">Payment</h2>
        <span className="text-sm text-[var(--color-ink-soft)]">Work so far {money(total)}</span>
      </div>

      {taken > 0n && (
        <ul className="mt-2 space-y-1 text-sm">
          {job.payments.map((payment, index) => (
            <li key={`${payment.paymentNo}-${index}`} className="flex justify-between gap-3">
              <span>
                {METHOD_LABEL[payment.method] ?? payment.method}
                {payment.pending && (
                  <span className="ml-2 text-[var(--color-ink-soft)]">· waiting to send</span>
                )}
              </span>
              <span className="font-semibold tabular-nums">{money(payment.amountCents)}</span>
            </li>
          ))}
        </ul>
      )}

      {taken > 0n && outstanding <= 0n ? (
        <>
          <p className="mt-2 font-semibold text-[var(--color-go)]">
            {billed ? 'Paid in full' : 'The whole job, collected'}
          </p>
          {!billed && (
            <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
              Tax goes on the invoice, so the office may still bill the difference.
            </p>
          )}
        </>
      ) : (
        <p className="mt-2 text-sm text-[var(--color-ink-soft)]">
          {taken > 0n
            ? `${money(outstanding)} of the work still to collect.`
            : 'Ask before you pack up — an invoice posted tonight is money in three weeks.'}{' '}
          {billed
            ? 'The office has invoiced this, so what you take goes against that invoice.'
            : 'Tax is added when the office bills it, so anything taken here sits against this job until then.'}
        </p>
      )}

      <button type="button" onClick={onTake} className="btn btn-quiet mt-3 w-full">
        Take payment
      </button>
    </section>
  );
}

/**
 * Taking it.
 *
 * Cash and a cheque are real the moment they are in your hand, so they queue like every
 * other operation and land when there is signal. A card is not: it is not paid until the
 * processor says it is, and a device with no signal cannot ask. Queuing one would mean
 * telling a customer they have paid and finding out at midnight that they have not, so the
 * app says what it needs instead of pretending.
 */
function PaymentSheet({
  open,
  total,
  taken,
  onClose,
  onConfirm,
}: {
  open: boolean;
  total: bigint;
  taken: bigint;
  onClose: () => void;
  onConfirm: (input: {
    method: 'CASH' | 'CHECK' | 'CARD';
    amountCents: bigint;
    reference?: string;
  }) => Promise<void>;
}) {
  const outstanding = total - taken > 0n ? total - taken : 0n;
  const [method, setMethod] = useState<'CASH' | 'CHECK'>('CASH');
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [online, setOnline] = useState(true);

  useEffect(() => {
    if (!open) return;
    setAmount(outstanding > 0n ? (Number(outstanding) / 100).toFixed(2) : '');
    setReference('');
    setMethod('CASH');
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, [open, outstanding]);

  const cents = (() => {
    const value = Number(amount.replace(/[^0-9.]/g, ''));
    return Number.isFinite(value) && value > 0 ? BigInt(Math.round(value * 100)) : 0n;
  })();

  return (
    <Sheet
      open={open}
      title="Take payment"
      onClose={onClose}
      footer={
        <button
          type="button"
          disabled={busy || cents <= 0n || (method === 'CHECK' && !reference.trim())}
          onClick={async () => {
            setBusy(true);
            try {
              await onConfirm({
                method,
                amountCents: cents,
                reference: reference.trim() || undefined,
              });
            } finally {
              setBusy(false);
            }
          }}
          className="btn btn-go w-full py-4 text-lg"
        >
          {cents > 0n ? `Take ${money(cents)}` : 'Enter an amount'}
        </button>
      }
    >
      <div className="space-y-4 px-5 py-4">
        <div className="grid grid-cols-2 gap-2">
          {(['CASH', 'CHECK'] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setMethod(option)}
              className={`tap rounded-xl border-2 px-4 py-4 text-lg font-semibold ${
                method === option ? 'border-[var(--color-go)]' : ''
              }`}
              style={method === option ? undefined : { borderColor: 'var(--color-line)' }}
            >
              {METHOD_LABEL[option]}
            </button>
          ))}
        </div>

        <div
          className="rounded-xl border-2 border-dashed px-4 py-3 text-sm text-[var(--color-ink-soft)]"
          style={{ borderColor: 'var(--color-line)' }}
        >
          <span className="font-semibold">Card</span> —{' '}
          {online
            ? 'no reader is paired to this device, so a card has to go through the office.'
            : 'a card needs the processor, and you have no signal. Take cash or a cheque, or run it when you are back in coverage.'}
        </div>

        <label className="block">
          <span className="text-sm font-semibold">Amount</span>
          <input
            inputMode="decimal"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            placeholder="0.00"
            className="mt-1 w-full rounded-xl border-2 px-4 py-3 text-2xl tabular-nums"
            style={{ borderColor: 'var(--color-line)' }}
          />
        </label>

        {method === 'CHECK' && (
          <label className="block">
            <span className="text-sm font-semibold">Cheque number</span>
            <input
              value={reference}
              onChange={(event) => setReference(event.target.value)}
              placeholder="e.g. 1184"
              className="mt-1 w-full rounded-xl border-2 px-4 py-3 text-lg"
              style={{ borderColor: 'var(--color-line)' }}
            />
          </label>
        )}

        <p className="text-sm text-[var(--color-ink-soft)]">
          Write the receipt on the job: the office sees it the moment your queue drains, and
          the invoice it raises already knows this money came in.
        </p>
      </div>
    </Sheet>
  );
}

function CompleteSheet({
  open,
  job,
  total,
  onClose,
  onConfirm,
}: {
  open: boolean;
  job: ClientJob;
  total: bigint;
  onClose: () => void;
  onConfirm: (signerName: string, dataUrl: string | null) => Promise<void>;
}) {
  const [signerName, setSignerName] = useState('');
  const [signature, setSignature] = useState<string | null>(null);

  return (
    <Sheet
      open={open}
      title="Finish job"
      onClose={onClose}
      footer={
        <button
          type="button"
          disabled={!signature || signerName.trim().length < 2}
          onClick={() => void onConfirm(signerName, signature)}
          className="btn btn-go w-full py-4 disabled:opacity-50"
        >
          Complete job
        </button>
      }
    >
      <div className="space-y-4">
        <div className="card p-4">
          <p className="font-semibold">{job.title}</p>
          <ul className="mt-2 space-y-1 text-sm">
            {job.lines.map((line) => (
              <li key={line.id} className="flex justify-between">
                <span>
                  {line.description} × {line.quantity}
                </span>
                <span className="tabular-nums">{money(line.unitPriceCents)}</span>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex justify-between border-t pt-3 font-bold" style={{ borderColor: 'var(--color-line)' }}>
            <span>Total before tax</span>
            <span className="tabular-nums">{money(total)}</span>
          </div>
        </div>

        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-[var(--color-ink-soft)]">Who is signing?</span>
          <input
            value={signerName}
            onChange={(event) => setSignerName(event.target.value)}
            className="field-input"
          />
        </label>

        <SignaturePad onChange={setSignature} label="Customer confirms the work is done" />
      </div>
    </Sheet>
  );
}
