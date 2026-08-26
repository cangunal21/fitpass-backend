-- Salon hareket günlüğü: satıcının ne yaptığının kaydı.
-- Bugüne dek venueController hiçbir olay yazmıyordu; "bu salon sürekli son anda mı iptal
-- ediyor" sorusu hiçbir veriden cevaplanamıyordu ve bu veri geri getirilemez.
CREATE TABLE "VenueOlay" (
    "id" SERIAL NOT NULL,
    "venueId" INTEGER NOT NULL,
    "aktor" TEXT NOT NULL DEFAULT 'venue',
    "olay" TEXT NOT NULL,
    "hedefTur" TEXT,
    "hedefId" INTEGER,
    "oncesi" JSONB,
    "sonrasi" JSONB,
    "etkilenen" INTEGER NOT NULL DEFAULT 0,
    "kalanSaat" DOUBLE PRECISION,
    "olusturma" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VenueOlay_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "VenueOlay_venueId_olusturma_idx" ON "VenueOlay"("venueId", "olusturma");
CREATE INDEX "VenueOlay_olay_idx" ON "VenueOlay"("olay");
CREATE INDEX "VenueOlay_olusturma_idx" ON "VenueOlay"("olusturma");
