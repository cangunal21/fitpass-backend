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

// ────────────────────────────────────────────────────────────────────────────────────────────
// GÜN / HAFTA / AY SINIRI HESAPLARI
//
// Yukarıdakiler GÖSTERİM içindi. Bunlar HESAP için: "hangi gün", "haftanın kaçıncı günü",
// "ayın başı". Sunucu UTC çalıştığı için `new Date().setHours(0,0,0,0)`, `getDay()`,
// `new Date(y, m, 1)` gibi çağrılar SUNUCUNUN gününü verir, kullanıcının gününü değil.
// İstanbul'da 00:00–02:59 arası her şey UTC'de bir önceki güne düşer; bu aralıkta yapılan
// hesaplar bir gün kayar. Ölçüldü: salon "Pazartesi 19:00" girince tekrarlayan seans
// 2026-08-03T19:00Z, yani İstanbul'da 22:00 olarak kaydediliyordu (venueController).
//
// Türkiye 2016'dan beri SABİT UTC+3, yaz saati YOK. Bu yüzden ofset sabit alınabiliyor.
// Ülke yaz saatine dönerse DEĞİŞMESİ GEREKEN TEK YER burasıdır.
const TR_OFFSET_MS = 3 * 60 * 60 * 1000

/** Bir anın İstanbul'daki takvim günü: 'YYYY-MM-DD'. */
export const trYmd = (d: Date | string | number): string =>
  new Date(new Date(d).getTime() + TR_OFFSET_MS).toISOString().slice(0, 10)

/** Bir anın İstanbul'daki hafta günü. 0=Pazar … 6=Cumartesi (JS getDay ile aynı sözleşme). */
export const trWeekday = (d: Date | string | number): number =>
  new Date(new Date(d).getTime() + TR_OFFSET_MS).getUTCDay()

/**
 * TR duvar-saatinden gerçek an üretir: trInstant('2026-08-03', '19:00') → 16:00Z.
 * Geçersiz girdide Invalid Date döner; çağıran isNaN(x.getTime()) ile kontrol etmeli.
 */
export const trInstant = (ymd: string, hm: string): Date => new Date(`${ymd}T${hm}:00+03:00`)

/** 'YYYY-MM-DD' üzerine gün ekler (İstanbul takvimine göre). */
export const trAddDays = (ymd: string, days: number): string =>
  trYmd(new Date(trInstant(ymd, '12:00').getTime() + days * 86400000)) // öğlen: sınır etkilerinden uzak

/** İstanbul'da o günün 00:00'ı (an olarak). Gün filtreleri için alt sınır. */
export const trDayStart = (d: Date | string | number): Date => trInstant(trYmd(d), '00:00')

/** İstanbul'da ayın 1'i 00:00. monthDelta ile geriye/ileriye ay kaydırılır. */
export const trMonthStart = (d: Date | string | number, monthDelta = 0): Date => {
  const [y, m] = trYmd(d).split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1 + monthDelta, 1))
  return trInstant(t.toISOString().slice(0, 10), '00:00')
}
