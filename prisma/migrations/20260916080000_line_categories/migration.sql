-- CreateEnum
CREATE TYPE "LineCategory" AS ENUM ('LABOR', 'MATERIAL', 'AGREEMENT', 'FEE', 'SUBCONTRACT');

-- AlterTable
ALTER TABLE "InvoiceLine" ADD COLUMN     "category" "LineCategory" NOT NULL DEFAULT 'MATERIAL';

-- AlterTable
ALTER TABLE "Job" ADD COLUMN     "sourceQuoteId" TEXT;

-- AlterTable
ALTER TABLE "JobLine" ADD COLUMN     "category" "LineCategory" NOT NULL DEFAULT 'MATERIAL',
ADD COLUMN     "invoiceId" TEXT;

-- AlterTable
ALTER TABLE "PriceBookItem" DROP COLUMN "isTaxableLabor",
DROP COLUMN "isTaxableMaterial",
ADD COLUMN     "category" "LineCategory" NOT NULL DEFAULT 'MATERIAL',
ADD COLUMN     "isTaxExempt" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "QuoteLine" ADD COLUMN     "category" "LineCategory" NOT NULL DEFAULT 'MATERIAL';

-- CreateIndex
CREATE UNIQUE INDEX "Job_sourceQuoteId_key" ON "Job"("sourceQuoteId");

