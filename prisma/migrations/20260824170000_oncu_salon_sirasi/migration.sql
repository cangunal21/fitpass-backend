-- ONCU SALON SIRASI (O13). Salon sunumunda 8 salona YAZILI olarak soz verildi:
-- "Ilk 50 salona ozel · Platform 200 salona ulasana dek 'Ilk 50 · Oncu Salon' rozetiyle
--  uygulamada one cikarilirsiniz."
-- Sira ONAY aninda verilir (kayit aninda degil): kaydolup onaylanmayan salon sirayi kilitlemesin.
ALTER TABLE "Venue" ADD COLUMN "founderRank" INTEGER;

-- Tekillik DB'de: esizamanli iki onayda MAX+1 okumasi yarisir ve ayni numarayi uretebilir.
CREATE UNIQUE INDEX "Venue_founderRank_key" ON "Venue"("founderRank");

-- ZATEN ONAYLI SALONLAR: sirayi geriye donuk ver (onay tarihi kaydedilmedigi icin id sirasi
-- en yakin vekil; bugun canlida 1 onayli salon var, sapma riski yok).
WITH sirali AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY id ASC) AS sira
  FROM "Venue" WHERE "isApproved" = true
)
UPDATE "Venue" v SET "founderRank" = s.sira FROM sirali s WHERE v.id = s.id;
