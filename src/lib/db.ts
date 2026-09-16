import { PrismaClient } from '@prisma/client';

/**
 * The unscoped client. Use it only for authentication, seeding, migrations and the
 * posting engine's own internals. Everything that serves a request should go through
 * `scopedDb(ctx)` so tenant and cost isolation cannot be forgotten.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db;

export type Db = PrismaClient;
/** A transaction handle: the client surface available inside `db.$transaction`. */
export type Tx = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;
