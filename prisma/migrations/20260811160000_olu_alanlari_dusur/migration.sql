-- ALLOW-DESTRUCTIVE: iki kolon da ÖLÜ. yearlyTierResetDate hiçbir yerde geçmiyordu;
-- tierSportCounts yalnızca yazılıyor, hiç okunmuyordu. Üretimde ikisinin de dolu satır
-- sayısı 0 (kontrol edildi). Kodları AŞAMA 1'de (commit 86ed7d7) kaldırıldı ve canlıya
-- alındı; bu deploy'da çalışan hiçbir konteyner bu kolonları SELECT etmiyor.
-- İki aşamalı geçişin 2. adımıdır — bkz. DEPLOY.md.

ALTER TABLE "User" DROP COLUMN IF EXISTS "tierSportCounts";
ALTER TABLE "User" DROP COLUMN IF EXISTS "yearlyTierResetDate";
