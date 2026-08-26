-- Anonimleştirilmiş finansal kayıt arşivi (Gizlilik Politikası 11.3).
-- Hesap silme ve seans silme, vergi/ticaret mevzuatının saklanmasını istediği işlem kayıtlarını
-- hard-delete ediyordu. Arşiv kişiyi DEĞİL işlemi tutar: userId yok, User'a FK yok.
CREATE TABLE "FinansalKayit" (
    "id" SERIAL NOT NULL,
    "bookingNumber" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "baseAmount" DOUBLE PRECISION NOT NULL,
    "commissionAmount" DOUBLE PRECISION NOT NULL,
    "userCommission" DOUBLE PRECISION NOT NULL,
    "venueCommission" DOUBLE PRECISION NOT NULL,
    "finalAmount" DOUBLE PRECISION NOT NULL,
    "venuePayout" DOUBLE PRECISION NOT NULL,
    "groupSize" INTEGER NOT NULL,
    "venueId" INTEGER,
    "instructorId" INTEGER,
    "paymentStatus" TEXT,
    "refundType" TEXT,
    "refundAmount" DOUBLE PRECISION,
    "reason" TEXT NOT NULL,
    "archivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "purgeAfter" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinansalKayit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "FinansalKayit_purgeAfter_idx" ON "FinansalKayit"("purgeAfter");
CREATE INDEX "FinansalKayit_venueId_idx" ON "FinansalKayit"("venueId");
