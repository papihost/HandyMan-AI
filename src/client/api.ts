/**
 * Talking to the server.
 *
 * Amounts arrive as strings and become BigInt here, at the edge, so nothing downstream has
 * to remember that a price was ever a string — and no amount passes through a double.
 */

export class OfflineError extends Error {
  constructor() {
    super('offline');
    this.name = 'OfflineError';
  }
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch {
    // A failed fetch is the normal state of a device in a plant room, not an exception.
    throw new OfflineError();
  }

  const body = (await response.json().catch(() => null)) as
    | (T & { error?: { message: string; code: string } })
    | null;

  if (!response.ok) {
    throw new ApiError(
      body?.error?.message ?? 'Request failed',
      response.status,
      body?.error?.code ?? 'UNKNOWN',
    );
  }

  return body as T;
}

export const api = {
  signIn: (email: string, password: string, deviceIdValue: string) =>
    request<{ user: SessionUser; expiresAt: string }>('/api/auth/sign-in', {
      method: 'POST',
      body: JSON.stringify({ email, password, deviceId: deviceIdValue, isFieldDevice: true }),
    }),

  signOut: () => request<{ ok: boolean }>('/api/auth/sign-out', { method: 'POST' }),

  me: () => request<{ user: SessionUser | null }>('/api/auth/me'),

  pull: (body: { since?: string; knownJobIds?: string[] }) =>
    request<PullPayload>('/api/field/pull', { method: 'POST', body: JSON.stringify(body) }),

  push: (body: { deviceId: string; operations: unknown[] }) =>
    request<PushPayload>('/api/field/push', { method: 'POST', body: JSON.stringify(body) }),

  async uploadPhoto(storageKey: string, blob: Blob): Promise<void> {
    const form = new FormData();
    form.set('storageKey', storageKey);
    form.set('file', blob);

    try {
      const response = await fetch('/api/field/photo', { method: 'POST', body: form });
      if (!response.ok) throw new ApiError('Upload failed', response.status, 'UPLOAD_FAILED');
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new OfflineError();
    }
  },
};

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  roles: string[];
  technicianId: string | null;
  canReadCost: boolean;
}

export interface PullPayload {
  serverTime: string;
  technicianId: string;
  full: boolean;
  jobs: RawJob[];
  priceBook: RawPriceItem[];
  vanStock: RawStock[];
  checklistTemplates: { id: string; name: string; serviceTypeId: string | null; items: unknown }[];
  revokedJobIds: string[];
}

export interface RawJob {
  id: string;
  jobNo: string;
  title: string;
  description: string | null;
  internalNotes: string | null;
  status: string;
  priority: string;
  isWarranty: boolean;
  isBillable: boolean;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  startedAt: string | null;
  completedAt: string | null;
  locationId: string;
  serviceTypeId: string | null;
  customer: { id: string; name: string; phone: string | null; email: string | null; isTaxExempt: boolean };
  property: {
    id: string;
    addressLine1: string;
    addressLine2: string | null;
    city: string;
    state: string;
    postalCode: string;
    latitude: string | null;
    longitude: string | null;
    accessNotes: string | null;
    equipment: { id: string; name: string; modelNumber: string | null; serialNumber: string | null }[];
  };
  lines: {
    id: string;
    description: string;
    quantity: string;
    unitPriceCents: string;
    discountCents: string;
    category: string;
    priceBookItemId: string | null;
    isBilled: boolean;
  }[];
  history: { jobNo: string; title: string; completedAt: string | null; isWarranty: boolean }[];
  checklistIds: string[];
  photoCount: number;
  payments: { paymentNo: string; method: string; amountCents: string; receivedAt: string }[];
}

export interface RawPriceItem {
  id: string;
  sku: string;
  name: string;
  description: string | null;
  category: string;
  kind: string;
  unit: string;
  priceCents: string;
  estimatedHours: string | null;
  serviceTypeId: string | null;
  isTaxExempt: boolean;
}

export interface RawStock {
  priceBookItemId: string;
  sku: string;
  name: string;
  quantity: string;
  stockLocationId: string;
}

export interface PushPayload {
  serverTime: string;
  results: {
    clientOpId: string;
    sequence: number;
    type: string;
    outcome: 'APPLIED' | 'DUPLICATE' | 'NOOP' | 'CONFLICT' | 'REJECTED';
    message?: string;
    entityId?: string;
    serverData?: Record<string, unknown>;
  }[];
  applied: number;
  duplicates: number;
  conflicts: number;
  rejected: number;
}
