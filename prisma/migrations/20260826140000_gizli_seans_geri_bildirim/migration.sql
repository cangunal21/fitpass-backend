-- Gizli seans geri bildirimi: yalnızca yöneticiye iletilir, hiçbir public uçtan dönmez.
-- Review'a kolon EKLENMEDİ çünkü sanitizeReview bir reddetme listesidir ve yeni kolon sızardı.
CREATE TABLE "SeansGeriBildirim" (
    "id" SERIAL NOT NULL,
    "bookingId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "venueId" INTEGER,
    "instructorId" INTEGER,
    "ilanEdilenGibi" BOOLEAN NOT NULL,
    "sebep" TEXT,
    "yorum" TEXT,
    "olusturma" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SeansGeriBildirim_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SeansGeriBildirim_bookingId_key" ON "SeansGeriBildirim"("bookingId");
CREATE INDEX "SeansGeriBildirim_venueId_idx" ON "SeansGeriBildirim"("venueId");
CREATE INDEX "SeansGeriBildirim_instructorId_idx" ON "SeansGeriBildirim"("instructorId");
CREATE INDEX "SeansGeriBildirim_ilanEdilenGibi_idx" ON "SeansGeriBildirim"("ilanEdilenGibi");
