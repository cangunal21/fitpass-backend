-- Refresh jetonu döndürme (rotation) + replay tespiti (#30).
-- rotatedAt: jeton YENİLEME sırasında iptal edildiyse dolu; çıkış/parola değişimi iptalinde boş.
ALTER TABLE "PanelRefreshToken" ADD COLUMN IF NOT EXISTS "rotatedAt" TIMESTAMP(3);
ALTER TABLE "RefreshToken"      ADD COLUMN IF NOT EXISTS "rotatedAt" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "PanelRefreshToken_rotatedAt_idx" ON "PanelRefreshToken"("rotatedAt");
CREATE INDEX IF NOT EXISTS "RefreshToken_rotatedAt_idx"      ON "RefreshToken"("rotatedAt");
