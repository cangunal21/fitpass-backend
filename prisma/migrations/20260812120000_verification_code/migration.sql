-- Kayıt akışı e-posta LİNKİNDEN 6 haneli KODA geçiyor (mobilde uygulamadan çıkmadan girilir).
-- code: SHA-256; attempts: kaba kuvvete karşı yanlış deneme sayacı.
ALTER TABLE "EmailVerificationToken" ADD COLUMN IF NOT EXISTS "code" TEXT;
ALTER TABLE "EmailVerificationToken" ADD COLUMN IF NOT EXISTS "attempts" INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS "EmailVerificationToken_userId_used_idx" ON "EmailVerificationToken"("userId", "used");
