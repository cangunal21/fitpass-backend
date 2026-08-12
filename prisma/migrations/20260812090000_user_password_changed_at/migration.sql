-- Kullanıcı realm'inde parola-değişimi damgası: parola değiştikten sonra zaten dağıtılmış
-- access token'lar (JWT, 1 saat) iptal edilemiyordu. Salon/eğitmen'de bu kolon zaten vardı.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "passwordChangedAt" TIMESTAMP(3);
