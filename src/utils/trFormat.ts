// Kullanıcıya GÖSTERİLEN tarih/saat biçimlendirmesi — HER ZAMAN İstanbul saatiyle.
//
// Neden: Railway (ve çoğu bulut sunucusu) UTC çalışır. `toLocaleTimeString('tr-TR')` timeZone
// verilmezse SUNUCUNUN saat dilimini kullanır → hatırlatma e-postası/push'unda ders saati 3 saat
// GERİ görünür; 00:00–03:00 arası derslerde TARİH de bir gün geri kayar. Kullanıcı yanlış saate gider.
// Repoda TZ env ayarı yok, yani doğruluk sunucu yapılandırmasına bırakılamaz — biçim burada sabitlenir.
const TZ = 'Europe/Istanbul'

export const trDate = (d: Date | string | number): string =>
  new Date(d).toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: TZ })

export const trTime = (d: Date | string | number): string =>
  new Date(d).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', timeZone: TZ })

export const trDateShort = (d: Date | string | number): string =>
  new Date(d).toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: TZ })
