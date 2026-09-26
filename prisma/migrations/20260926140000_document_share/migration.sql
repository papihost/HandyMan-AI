-- A link that shows one customer one document.
--
-- Only the hash is stored, exactly as sessions are handled: the token itself lives in the
-- customer's inbox and nowhere else, so a copy of this database is not a set of working
-- links to other people's invoices. The link expires, it can be revoked, and it records
-- when it was opened — a bill that has been read and not paid is a different conversation
-- from one that never arrived.

CREATE TABLE "DocumentShare" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "documentType" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "viewedAt" TIMESTAMP(3),
  "viewCount" INTEGER NOT NULL DEFAULT 0,
  "revokedAt" TIMESTAMP(3),
  "createdByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DocumentShare_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DocumentShare_tokenHash_key" ON "DocumentShare"("tokenHash");
CREATE INDEX "DocumentShare_organizationId_documentType_documentId_idx"
  ON "DocumentShare"("organizationId", "documentType", "documentId");
