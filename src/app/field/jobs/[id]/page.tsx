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

type SheetName = 'work' | 'parts' | 'changeOrder' | 'complete' | null;

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
