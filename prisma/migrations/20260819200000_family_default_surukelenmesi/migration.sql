-- SURUKELENME TEMIZLIGI: RefreshToken/PanelRefreshToken."family" kolonundaki DB varsayilani.
--
-- Sema `@default(uuid())` diyor; bu Prisma'da ISTEMCI TARAFI uretimdir. DB'de ise ayrica
-- `gen_random_uuid()` varsayilani duruyordu (eski bir `db push` doneminden kalma). Sonuc:
-- her `prisma migrate dev` bu farki yeniden onerip ILGISIZ bir degisikligi bir sonraki
-- ozellik migration'ina karistiriyordu (online ders migration'inda tam bu oldu, oradan
-- bilerek CIKARILDI ve ayri ele alinmak uzere isaretlendi).
--
-- DAVRANIS DEGISIKLIGI YOK, olculdu: hicbir yerde bu tablolara ham SQL INSERT yok ve
-- issueRefreshToken/issuePanelRefreshToken yeni oturumda `family`yi Prisma varsayilanindan
-- (istemci tarafi uuid) aliyor -> DB varsayilani bugun zaten HIC kullanilmiyor.
ALTER TABLE "RefreshToken" ALTER COLUMN "family" DROP DEFAULT;
ALTER TABLE "PanelRefreshToken" ALTER COLUMN "family" DROP DEFAULT;
