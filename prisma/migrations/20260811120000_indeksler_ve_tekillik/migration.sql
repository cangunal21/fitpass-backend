-- Bu migration ELLE yazıldı ve TAMAMEN IDEMPOTENT (IF NOT EXISTS).
-- Sebep: index'lerin bir kısmı üretimde ZATEN VAR — ensureIndexes.ts onları boot'ta ham SQL
-- ile yaratıyordu. Prisma'nın ürettiği düz CREATE, var olan index'te patlayıp deploy'u
-- durdururdu. IF NOT EXISTS ile hem mevcut DB'de sorunsuz geçer hem sıfırdan kurulan
-- ortamda index'i gerçekten yaratır.

-- RewardPoint'te HİÇ index yoktu. Kritik olan birincisi: check-in idempotans kontrolü
-- (bookingId + source='attendance') AÇIK transaction ve User satır kilidi altında tam tablo
-- taraması yapıyordu → kilit süresi tablo büyüdükçe uzuyordu.
CREATE INDEX IF NOT EXISTS "RewardPoint_bookingId_source_idx" ON "RewardPoint"("bookingId", "source");
CREATE INDEX IF NOT EXISTS "RewardPoint_userId_createdAt_idx" ON "RewardPoint"("userId", "createdAt");

-- COĞRAFYA TEKİLLİĞİ: ensureGeo her açılışta "önce oku sonra yaz" ile çalışıyor. Sıfır-kesinti
-- deploy'da eski ve yeni konteyner ~20 sn birlikte çalıştığı için ikisi de aynı anda "İstanbul
-- yok" görüp iki kez ekleyebilir. Tekillik bunu DB seviyesinde imkânsız kılar.
CREATE UNIQUE INDEX IF NOT EXISTS "City_name_key" ON "City"("name");
CREATE UNIQUE INDEX IF NOT EXISTS "Neighborhood_cityId_name_key" ON "Neighborhood"("cityId", "name");

-- Class_Session (classId, startsAt) tekilliği: ensureIndexes'in ham SQL ile yarattığı index.
-- Artık şemada da tanımlı (@@unique ... map) → Prisma sürüklenme görmüyor.
CREATE UNIQUE INDEX IF NOT EXISTS "class_session_class_startsat_unique" ON "Class_Session"("classId", "startsAt");
