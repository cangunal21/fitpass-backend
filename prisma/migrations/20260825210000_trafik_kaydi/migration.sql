-- 5651 yer sağlayıcı trafik kaydı (Gizlilik Politikası Bölüm 7).
-- Metin trafik kaydı tuttuğumuzu beyan ediyordu ama şemada IP tutan tek bir kolon yoktu.
CREATE TABLE "TrafikKaydi" (
    "id" SERIAL NOT NULL,
    "eventType" TEXT NOT NULL,
    "subjectType" TEXT,
    "subjectId" INTEGER,
    "contentType" TEXT,
    "contentId" INTEGER,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "purgeAfter" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrafikKaydi_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TrafikKaydi_purgeAfter_idx" ON "TrafikKaydi"("purgeAfter");
CREATE INDEX "TrafikKaydi_subjectType_subjectId_idx" ON "TrafikKaydi"("subjectType", "subjectId");
CREATE INDEX "TrafikKaydi_contentType_contentId_idx" ON "TrafikKaydi"("contentType", "contentId");
