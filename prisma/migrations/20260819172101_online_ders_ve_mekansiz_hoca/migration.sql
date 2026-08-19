-- ALLOW-DESTRUCTIVE: FK'ler ayni kolon uzerinde ayni hedefe YENIDEN kuruluyor (asagida),
-- amac ON DELETE davranisini SET NULL yerine RESTRICT yapmak. Hicbir satir silinmez/degismez;
-- kolon NOT NULL'dan nullable'a GENISLETILIYOR (daralma degil). Kapi dogru calisti: bu dosya
-- isaretsiz gonderilmisti ve deploy Railway'de burada durdu.

-- ONLINE DERS + MEKANSIZ (BIREYSEL) HOCA
--
-- Class.venueId ve Instructor.venueId NULLABLE hale geliyor: bugune kadar her ders bir salona,
-- her egitmen bir salona aitti. Mekansiz hoca kendi kaydolup kendi adina ONLINE ders satacak.
-- Kolon NOT NULL'dan nullable'a GENISLETILIYOR (daralma degil) -> mevcut satirlarin hicbiri
-- degismez, veri kaybi yok.
--
-- ONEMLI - FK DAVRANISI: Prisma nullable iliskiyi varsayilan olarak ON DELETE SET NULL uretir.
-- BU KABUL EDILEMEZ: bir salon silindiginde dersleri ve egitmenleri sessizce "mekansiz" hale
-- gelir ve online listede yeniden belirirdi (sessiz yanlis sonuc, hata vermez). Kisitlama
-- bilerek RESTRICT birakiliyor -- yani NOT NULL donemindeki davranisin AYNISI. deleteVenue
-- zaten dersleri (adminController.ts) ve egitmenleri acikca siliyor; FK'nin isi temizligi
-- ustlenmek degil, temizlenmemis bir silmeyi YUKSEK SESLE durdurmak.
--
-- NOT: Prisma bu migration'a RefreshToken/PanelRefreshToken "family" kolonlarindan DEFAULT
-- dusurmeyi de eklemisti. O degisiklik bu ozellikle ILGISIZ (onceden var olan bir surukleme)
-- ve ham SQL ekleyen betikleri bozabilir -> bilerek CIKARILDI, ayrica ele alinacak.

-- Class -----------------------------------------------------------------------------------
ALTER TABLE "Class" ADD COLUMN "deliveryMode" TEXT NOT NULL DEFAULT 'in_person';
ALTER TABLE "Class" ADD COLUMN "meetingUrl" TEXT;
ALTER TABLE "Class" ALTER COLUMN "venueId" DROP NOT NULL;

ALTER TABLE "Class" DROP CONSTRAINT "Class_venueId_fkey";
ALTER TABLE "Class" ADD CONSTRAINT "Class_venueId_fkey"
  FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- INVARYANT DB SEVIYESINDE: mekansiz ders yalnizca online olabilir. Salonu olmayan bir dersin
-- adresi de yoktur; yuz yuze isaretlenirse kullanicinin gidecegi yer YOK demektir. Bu kurali
-- yalnizca kodda tutmak, uc ayri yazma yolunda (salon paneli, egitmen portali, seed) tek tek
-- tekrar etmek anlamina gelirdi -- denetimlerin "kopya-kural surukelenmesi" sinifi tam olarak bu.
ALTER TABLE "Class" ADD CONSTRAINT "class_venueless_must_be_online"
  CHECK ("venueId" IS NOT NULL OR "deliveryMode" = 'online');

-- Yazim hatasi bir dersi sessizce gorunmez yapmasin (ne yuz yuze ne online listeye duser).
ALTER TABLE "Class" ADD CONSTRAINT "class_delivery_mode_valid"
  CHECK ("deliveryMode" IN ('in_person', 'online'));

-- Instructor ------------------------------------------------------------------------------
ALTER TABLE "Instructor" ADD COLUMN "isApproved" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Instructor" ADD COLUMN "approvedAt" TIMESTAMP(3);
ALTER TABLE "Instructor" ADD COLUMN "rejectionReason" TEXT;
ALTER TABLE "Instructor" ADD COLUMN "submittedAt" TIMESTAMP(3);
ALTER TABLE "Instructor" ALTER COLUMN "venueId" DROP NOT NULL;

ALTER TABLE "Instructor" DROP CONSTRAINT "Instructor_venueId_fkey";
ALTER TABLE "Instructor" ADD CONSTRAINT "Instructor_venueId_fkey"
  FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- MEVCUT EGITMENLER: hepsi bir salona bagli, dolayisiyla kapilari SALONUN durumu. isApproved
-- alani onlar icin okunmuyor (bkz. src/utils/seller.ts) -> geriye donuk doldurma GEREKMIYOR;
-- false birakmak mevcut hicbir egitmeni gizlemez.
