-- Sözleşme / açık rıza onay kaydı.
-- KVKK'da rızanın ispat yükü veri sorumlusundadır; onay kutusu göstermek ispat değildir.
-- Kimin, ne zaman, hangi metin sürümünü onayladığı burada saklanır.
CREATE TABLE "ConsentRecord" (
    "id" SERIAL NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" INTEGER NOT NULL,
    "docSlug" TEXT NOT NULL,
    "docVersion" TEXT NOT NULL,
    "clientVersion" TEXT,
    "kind" TEXT NOT NULL,
    "granted" BOOLEAN NOT NULL DEFAULT true,
    "consentedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "ConsentRecord_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ConsentRecord_subjectType_subjectId_idx" ON "ConsentRecord"("subjectType", "subjectId");
CREATE INDEX "ConsentRecord_docSlug_idx" ON "ConsentRecord"("docSlug");
