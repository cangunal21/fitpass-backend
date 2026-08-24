-- IPTAL SONUCU YAPISAL ALANA (O14 hazirligi).
-- Bugune kadar iade tipi/tutari YALNIZCA `notes` icinde Turkce metindi ve web onu
-- `notes.split('Iptal: ')[1]` ile ayristiriyordu. Komisyon motoru (#79) geldiginde gec iptalde
-- komisyon TUTULAN TUTAR uzerinden hesaplanacak; o taban serbest metinden okunamaz.
ALTER TABLE "Booking" ADD COLUMN "refundType" TEXT;
ALTER TABLE "Booking" ADD COLUMN "refundAmount" DOUBLE PRECISION;
