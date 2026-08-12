-- Oturum zinciri (family): bir cihazın giriş→döndürme zinciri tek aile altında toplanır (#30).
-- Çıkış ve replay tespiti AİLEYİ kapatır; kullanıcının diğer cihazları etkilenmez.
-- Mevcut satırlara gen_random_uuid() ile ayrı aile verilir (her satır kendi zinciri sayılır).
ALTER TABLE "PanelRefreshToken" ADD COLUMN IF NOT EXISTS "family" TEXT NOT NULL DEFAULT gen_random_uuid()::text;
ALTER TABLE "RefreshToken"      ADD COLUMN IF NOT EXISTS "family" TEXT NOT NULL DEFAULT gen_random_uuid()::text;
CREATE INDEX IF NOT EXISTS "PanelRefreshToken_family_idx" ON "PanelRefreshToken"("family");
CREATE INDEX IF NOT EXISTS "RefreshToken_family_idx"      ON "RefreshToken"("family");
