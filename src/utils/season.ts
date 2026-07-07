// Sezonluk liderlik: tablo her mevsim başında otomatik sıfırlanır (depolanan state yok —
// pencere kaydığı için geçmiş sezon aktiviteleri sayımdan düşer).
// 1 Aralık → Kış, 1 Mart → İlkbahar, 1 Haziran → Yaz, 1 Eylül → Sonbahar.
// Not: sınırlar sunucu yerel saatiyle (Railway = UTC) hesaplanır; mevsim dönümünde ~3 saatlik
// kayma olabilir, liderlik için önemsiz.

export function seasonStart(now: Date = new Date()): Date {
  const y = now.getFullYear()
  const m = now.getMonth() // 0-11
  if (m === 11) return new Date(y, 11, 1)      // Aralık → Kış (bu yıl başladı)
  if (m <= 1) return new Date(y - 1, 11, 1)    // Ocak, Şubat → Kış (geçen Aralık başladı)
  if (m <= 4) return new Date(y, 2, 1)         // Mart-Mayıs → İlkbahar
  if (m <= 7) return new Date(y, 5, 1)         // Haziran-Ağustos → Yaz
  return new Date(y, 8, 1)                      // Eylül-Kasım → Sonbahar
}

export function seasonInfo(now: Date = new Date()) {
  const start = seasonStart(now)
  const sm = start.getMonth()
  const sy = start.getFullYear()
  const name = sm === 11 ? 'Kış' : sm === 2 ? 'İlkbahar' : sm === 5 ? 'Yaz' : 'Sonbahar'
  const nameEn = sm === 11 ? 'Winter' : sm === 2 ? 'Spring' : sm === 5 ? 'Summer' : 'Fall'
  // Kış Aralık→Şubat iki takvim yılına yayılır → "Kış 2025-2026"
  const label = sm === 11 ? `${name} ${sy}-${sy + 1}` : `${name} ${sy}`
  const labelEn = sm === 11 ? `${nameEn} ${sy}-${sy + 1}` : `${nameEn} ${sy}`
  const slug = sm === 11 ? 'kis' : sm === 2 ? 'ilkbahar' : sm === 5 ? 'yaz' : 'sonbahar'
  const key = `${slug}-${sy}`
  return { start, name, nameEn, label, labelEn, key, year: sy }
}
