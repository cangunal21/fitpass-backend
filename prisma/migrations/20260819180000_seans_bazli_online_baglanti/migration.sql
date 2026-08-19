-- Seans bazli online baglanti. Class.meetingUrl dersin VARSAYILAN linki; bu kolon dolduysa
-- o seans icin onu EZER. Gerekce: tekrarlayan toplanti tek link uretir (ders seviyesi yeter),
-- tek seferlik toplanti her seans icin ayri link uretir.
ALTER TABLE "Class_Session" ADD COLUMN "meetingUrl" TEXT;
