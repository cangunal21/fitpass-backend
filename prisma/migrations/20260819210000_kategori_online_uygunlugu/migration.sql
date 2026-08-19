-- KATEGORININ ONLINE'A UYGUNLUGU — tek dogruluk kaynagi.
-- Istemcilere sabit liste gomulseydi web ve mobilde iki kopya olur, ilkinde bayatlardi.
-- Sunucu ders acarken reddeder; istemciler filtreyi bu alandan cizer.
ALTER TABLE "SportCategory" ADD COLUMN "onlineAllowed" BOOLEAN NOT NULL DEFAULT false;

-- KARAR (19 Agu 2026, kullanici onayi): Yoga · Pilates · Fitness · Dans ACIK.
-- Dovus Sporlari KAPALI (online'da yalniz kardiyo turevi verilebilir, o da Fitness'in icinde).
-- Yuzme / Binicilik / Deniz Sporlari / Tenis fiziksel olarak imkansiz.
-- lower() ile eslestiriyoruz: canli kategori adlari elle duzenlenmis, buyuk/kucuk harf sapmasi
-- bir kategoriyi SESSIZCE disarida birakirdi.
UPDATE "SportCategory" SET "onlineAllowed" = true
WHERE lower(name) IN ('yoga', 'pilates', 'fitness', 'dans');
