-- ALLOW-DESTRUCTIVE: FK'yi ON DELETE SET NULL'a cevirebilmek icin dusurup yeniden kuruyoruz.
-- VERI KAYBI YOK: kolon NOT NULL'dan nullable'a GENISLETILIYOR (daralma degil) ve FK ayni
-- kolon uzerine ayni hedefle yeniden kuruluyor. Mevcut satirlarin hicbiri degismez.
--
-- GEREKCE: hesap silinirken o kullanicinin ACTIGI sikayetler de siliniyordu; boylece BASKA
-- kullanicilar hakkindaki incelenmemis moderasyon kaniti yok oluyordu (olculdu: 10 acik sikayet
-- -> sikayet eden hesabini sildi -> 0). Sikayet asil olarak SIKAYET EDILEN hakkindadir.

ALTER TABLE "Report" ALTER COLUMN "reporterUserId" DROP NOT NULL;

ALTER TABLE "Report" DROP CONSTRAINT "Report_reporterUserId_fkey";

ALTER TABLE "Report" ADD CONSTRAINT "Report_reporterUserId_fkey"
  FOREIGN KEY ("reporterUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
