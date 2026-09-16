import type { PrismaClient } from '@prisma/client';
import { requirePermission, type AuthContext } from '../auth/context';
import { PERMISSIONS } from '../auth/permissions';
import { scopedDb } from '../auth/scoped-db';
import { NotFoundError, ValidationError } from '../errors';
import { nextDocumentNumber } from '../accounting/sequences';

/**
 * Customers and the properties they own.
 *
 * A customer is a billing relationship; a property is a service address. They are separate
 * because a property manager is one customer with forty addresses, and because the service
 * history a technician needs on arrival belongs to the address, not the account.
 */

export interface CreateCustomerInput {
  type?: 'RESIDENTIAL' | 'COMMERCIAL' | 'PROPERTY_MANAGER' | 'BUILDER';
  companyName?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  billingAddress1?: string;
  billingCity?: string;
  billingState?: string;
  billingPostal?: string;
  paymentTermsDays?: number;
  priceTier?: string;
  isTaxExempt?: boolean;
  taxExemptCertNo?: string;
  source?: string;
  /** The first service address. Defaults to the billing address when omitted. */
  property?: CreatePropertyInput;
}

export interface CreatePropertyInput {
  label?: string;
  addressLine1: string;
  addressLine2?: string;
  city: string;
  state: string;
  postalCode: string;
  accessNotes?: string;
  taxJurisdictionId?: string;
}

export async function createCustomer(
  db: PrismaClient,
  ctx: AuthContext,
  input: CreateCustomerInput,
) {
  requirePermission(ctx, PERMISSIONS.CUSTOMER_WRITE);

  if (!input.companyName && !input.lastName) {
    throw new ValidationError('A customer needs either a company name or a last name');
  }

  return db.$transaction(async (tx) => {
    const customerNo = await nextDocumentNumber(tx, ctx.organizationId, 'CUSTOMER');

    return tx.customer.create({
      data: {
        organizationId: ctx.organizationId,
        customerNo,
        type: input.type ?? 'RESIDENTIAL',
        companyName: input.companyName ?? null,
        firstName: input.firstName ?? null,
        lastName: input.lastName ?? null,
        email: input.email?.trim().toLowerCase() ?? null,
        phone: input.phone ?? null,
        phoneNormalized: normalizePhone(input.phone),
        billingAddress1: input.billingAddress1 ?? null,
        billingCity: input.billingCity ?? null,
        billingState: input.billingState ?? null,
        billingPostal: input.billingPostal ?? null,
        paymentTermsDays: input.paymentTermsDays ?? 0,
        priceTier: input.priceTier ?? null,
        isTaxExempt: input.isTaxExempt ?? false,
        taxExemptCertNo: input.taxExemptCertNo ?? null,
        source: input.source ?? null,
        ...(input.property
          ? { properties: { create: toPropertyData(input.property) } }
          : input.billingAddress1 && input.billingCity && input.billingState && input.billingPostal
            ? {
                properties: {
                  create: {
                    addressLine1: input.billingAddress1,
                    city: input.billingCity,
                    state: input.billingState,
                    postalCode: input.billingPostal,
                  },
                },
              }
            : {}),
      },
      include: { properties: true },
    });
  });
}

export async function addProperty(
  db: PrismaClient,
  ctx: AuthContext,
  customerId: string,
  input: CreatePropertyInput,
) {
  requirePermission(ctx, PERMISSIONS.CUSTOMER_WRITE);

  const customer = await scopedDb(db, ctx).customer.findFirst({
    where: { id: customerId },
    select: { id: true },
  });
  if (!customer) throw new NotFoundError('Customer', customerId);

  return db.property.create({ data: { customerId, ...toPropertyData(input) } });
}

function toPropertyData(input: CreatePropertyInput) {
  return {
    label: input.label ?? null,
    addressLine1: input.addressLine1,
    addressLine2: input.addressLine2 ?? null,
    city: input.city,
    state: input.state,
    postalCode: input.postalCode,
    accessNotes: input.accessNotes ?? null,
    taxJurisdictionId: input.taxJurisdictionId ?? null,
  };
}

export interface DuplicateMatch {
  customerId: string;
  customerNo: string;
  displayName: string;
  /** 0-100. Anything at or above 80 is worth showing before a new record is created. */
  score: number;
  reasons: string[];
}

/**
 * Duplicate detection, run before a create and again during an import.
 *
 * Handyman customer lists are full of near-duplicates: the same household entered once by
 * the wife's name and once by the husband's, the same commercial account with and without
 * "LLC". Catching them at entry is far cheaper than merging them later, once each copy has
 * its own job history and open balance.
 */
export async function findDuplicates(
  db: PrismaClient,
  ctx: AuthContext,
  candidate: { email?: string; phone?: string; lastName?: string; companyName?: string; postalCode?: string },
): Promise<DuplicateMatch[]> {
  requirePermission(ctx, PERMISSIONS.CUSTOMER_READ);

  const email = candidate.email?.trim().toLowerCase();
  const phone = normalizePhone(candidate.phone);
  const name = (candidate.companyName ?? candidate.lastName ?? '').trim().toLowerCase();
  if (!email && !phone && !name) return [];

  const rows = await scopedDb(db, ctx).customer.findMany({
    where: {
      isActive: true,
      OR: [
        ...(email ? [{ email }] : []),
        ...(name ? [{ companyName: { contains: name, mode: 'insensitive' as const } }] : []),
        ...(name ? [{ lastName: { contains: name, mode: 'insensitive' as const } }] : []),
        ...(phone ? [{ phoneNormalized: phone }] : []),
      ],
    },
    select: {
      id: true,
      customerNo: true,
      companyName: true,
      firstName: true,
      lastName: true,
      email: true,
      phoneNormalized: true,
      properties: { select: { postalCode: true } },
    },
    take: 25,
  });

  return rows
    .map((row) => {
      const reasons: string[] = [];
      let score = 0;

      if (email && row.email === email) {
        score += 60;
        reasons.push('same email');
      }
      if (phone && row.phoneNormalized === phone) {
        score += 50;
        reasons.push('same phone');
      }

      const rowName = (row.companyName ?? row.lastName ?? '').trim().toLowerCase();
      if (name && rowName === name) {
        score += 30;
        reasons.push('same name');
      } else if (name && rowName && (rowName.includes(name) || name.includes(rowName))) {
        score += 15;
        reasons.push('similar name');
      }

      if (candidate.postalCode && row.properties.some((p) => p.postalCode === candidate.postalCode)) {
        score += 10;
        reasons.push('property in the same postal code');
      }

      return {
        customerId: row.id,
        customerNo: row.customerNo,
        displayName: row.companyName ?? `${row.firstName ?? ''} ${row.lastName ?? ''}`.trim(),
        score: Math.min(score, 100),
        reasons,
      };
    })
    .filter((m) => m.score >= 40)
    .sort((a, b) => b.score - a.score);
}

function normalizePhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  // Strip a leading US country code so +1 480 555 1234 matches 4805551234.
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}
