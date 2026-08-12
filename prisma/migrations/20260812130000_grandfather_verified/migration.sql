-- MEVCUT HESAPLARI MUAF TUT.
-- E-posta doğrulama kapısı bu sürümle geliyor. Bu ana kadar kayıt olmuş herkes, doğrulama
-- İSTENMEYEN bir rejimde kayıt oldu: kapı geriye dönük uygulanırsa hepsi bir anda rezervasyon
-- yapamaz hâle gelir (demo/tanıtım hesapları dahil) ve bunun güvenlik kazancı yoktur — o
-- hesaplar zaten kurulmuş durumda. Kapı YENİ kayıtlar için anlamlı.
UPDATE "User" SET "isEmailVerified" = true WHERE "isEmailVerified" = false;
