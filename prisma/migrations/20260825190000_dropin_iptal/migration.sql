-- Drop-in katılımından çıkma (İptal ve İade Politikası m.3.4).
-- Katılımcı satırı SİLİNMEZ, damgalanır: silinirse iade borcunu gösteren kayıt kalmaz.
ALTER TABLE "DropInParticipant" ADD COLUMN "refundType" TEXT;
ALTER TABLE "DropInParticipant" ADD COLUMN "refundAmount" DOUBLE PRECISION;
ALTER TABLE "DropInParticipant" ADD COLUMN "cancelledAt" TIMESTAMP(3);
