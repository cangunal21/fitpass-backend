-- SALON/EĞİTMEN yenileme jetonu (task #30).
-- Panel realm'lerinde refresh mekanizması YOKTU; bu yüzden access token 7 GÜN yaşıyordu.
-- Salon paneli IBAN/vergi no/TCKN/KYC ve gelir raporu taşıdığı için çalınan bir token'ın
-- 7 gün geçerli kalması en büyük açıklardan biriydi. Bu tabloyla token 1 saate indi.
--
-- Tamamen EKLEYİCİ (yeni tablo) → mevcut konteynerle 20 sn'lik overlap'te sorun çıkarmaz.
-- IF NOT EXISTS: migration yeniden çalıştırılırsa da güvenli.

CREATE TABLE IF NOT EXISTS "PanelRefreshToken" (
    "id" SERIAL NOT NULL,
    "token" TEXT NOT NULL,
    "venueId" INTEGER,
    "instructorId" INTEGER,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revoked" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PanelRefreshToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PanelRefreshToken_token_key" ON "PanelRefreshToken"("token");
CREATE INDEX IF NOT EXISTS "PanelRefreshToken_venueId_idx" ON "PanelRefreshToken"("venueId");
CREATE INDEX IF NOT EXISTS "PanelRefreshToken_instructorId_idx" ON "PanelRefreshToken"("instructorId");

-- FK'ler: IF NOT EXISTS desteklenmediği için varlık kontrolüyle.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PanelRefreshToken_venueId_fkey') THEN
    ALTER TABLE "PanelRefreshToken" ADD CONSTRAINT "PanelRefreshToken_venueId_fkey"
      FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PanelRefreshToken_instructorId_fkey') THEN
    ALTER TABLE "PanelRefreshToken" ADD CONSTRAINT "PanelRefreshToken_instructorId_fkey"
      FOREIGN KEY ("instructorId") REFERENCES "Instructor"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
