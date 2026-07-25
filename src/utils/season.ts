// Sezonluk liderlik: tablo her mevsim başında otomatik sıfırlanır (depolanan state yok —
// pencere kaydığı için geçmiş sezon aktiviteleri sayımdan düşer).
// 1 Aralık → Kış, 1 Mart → İlkbahar, 1 Haziran → Yaz, 1 Eylül → Sonbahar.
// Sınırlar TR (UTC+3) DUVAR-SAATİNE göre hesaplanır — streak/istanbulDayKey ile tutarlı, sunucu
// TZ'inden (Railway=UTC) bağımsız. Böylece TR 1 Ara 01:30'daki seans (=30 Kas 22:30 UTC) doğru
// (Kış) sezona düşer; UTC hesabı yanlış sezona koyardı (streak-sezon uyumsuzluğu).
const TR_OFFSET_MS = 3 * 3600 * 1000
// Bir UTC anının TR'deki yıl/ay'ını verir
function trParts(d: Date): { y: number; m: number } {
  const t = new Date(d.getTime() + TR_OFFSET_MS)
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() }
}
// TR-yerel (y, ay, 1) 00:00'ın UTC anı
function trMonthStart(y: number, m: number): Date {
  return new Date(Date.UTC(y, m, 1) - TR_OFFSET_MS)
}
// TR duvar-saatine göre yıl (yıllık puan reseti vb. için)
export function trYear(now: Date = new Date()): number {
  return trParts(now).y
}

export function seasonStart(now: Date = new Date()): Date {
  const { y, m } = trParts(now)
  if (m === 11) return trMonthStart(y, 11)      // Aralık → Kış (bu yıl başladı)
  if (m <= 1) return trMonthStart(y - 1, 11)    // Ocak, Şubat → Kış (geçen Aralık başladı)
  if (m <= 4) return trMonthStart(y, 2)         // Mart-Mayıs → İlkbahar
  if (m <= 7) return trMonthStart(y, 5)         // Haziran-Ağustos → Yaz
  return trMonthStart(y, 8)                      // Eylül-Kasım → Sonbahar
}

export function seasonInfo(now: Date = new Date()) {
  const start = seasonStart(now)
  const { y: sy, m: sm } = trParts(start) // start TR-gece-yarısı → TR parçaları doğru ay/yıl verir
  const name = sm === 11 ? 'Kış' : sm === 2 ? 'Bahar' : sm === 5 ? 'Yaz' : 'Güz'
  const nameEn = sm === 11 ? 'Winter' : sm === 2 ? 'Spring' : sm === 5 ? 'Summer' : 'Fall'
  // Kış Aralık→Şubat iki takvim yılına yayılır → "Kış 2025-2026"
  const label = sm === 11 ? `${name} ${sy}-${sy + 1}` : `${name} ${sy}`
  const labelEn = sm === 11 ? `${nameEn} ${sy}-${sy + 1}` : `${nameEn} ${sy}`
  const slug = sm === 11 ? 'kis' : sm === 2 ? 'bahar' : sm === 5 ? 'yaz' : 'guz'
  const key = `${slug}-${sy}`
  return { start, name, nameEn, label, labelEn, key, year: sy }
}

// seasonKey (örn "yaz-2026") → görünen etiket (TR + EN). Şampiyon rozeti gösteriminde kullanılır.
export function seasonLabelsFromKey(key?: string | null): { label: string; labelEn: string } {
  if (!key) return { label: '', labelEn: '' }
  const [slug, yStr] = key.split('-')
  const y = parseInt(yStr)
  const name = slug === 'kis' ? 'Kış' : slug === 'bahar' ? 'Bahar' : slug === 'yaz' ? 'Yaz' : slug === 'guz' ? 'Güz' : slug
  const nameEn = slug === 'kis' ? 'Winter' : slug === 'bahar' ? 'Spring' : slug === 'yaz' ? 'Summer' : slug === 'guz' ? 'Fall' : slug
  if (isNaN(y)) return { label: name, labelEn: nameEn }
  const suffix = slug === 'kis' ? `${y}-${y + 1}` : `${y}`
  return { label: `${name} ${suffix}`, labelEn: `${nameEn} ${suffix}` }
}
