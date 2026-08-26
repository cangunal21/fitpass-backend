/**
 * SALON HAREKET GÜNLÜĞÜ.
 *
 * Platform bugüne dek yalnızca SON DURUMU biliyordu; satıcının ne yaptığını hiç yazmıyordu.
 * "Bu salon sürekli son anda mı iptal ediyor", "kötü yorum alan dersi mi sildi", "fiyatı
 * rezervasyonlardan sonra mı yükseltti" sorularının hiçbiri cevaplanamıyordu — ve bu veri
 * GERİ GETİRİLEMEZ, yazılmadığı her gün kalıcı kayıp.
 */
import prisma from './prisma'

export type VenueOlayTuru = 'seans_iptal' | 'seans_guncelle' | 'ders_kapat' | 'ders_guncelle'

type Girdi = {
  venueId: number
  olay: VenueOlayTuru
  hedefTur?: 'session' | 'class'
  hedefId?: number | null
  oncesi?: unknown
  sonrasi?: unknown
  /** Olay anındaki onaylı/bekleyen rezervasyon sayısı — sonradan hesaplanamaz. */
  etkilenen?: number
  /** Seansın başlangıcı; kalan saat buradan hesaplanır. */
  baslangic?: Date | string | null
  aktor?: 'venue' | 'admin' | 'system'
}

/**
 * Olayı yazar. ATEŞLE-UNUT: günlük yazılamazsa salonun işlemi BOZULMAZ.
 * Tersi, bir log hatası yüzünden salonun seansını iptal edememesi demek olurdu.
 */
export function venueOlayYaz(g: Girdi): void {
  // "Son anda iptal" ancak olay anında yazılırsa ölçülebilir: seans silindikten sonra
  // startsAt'e bakma şansı kalmaz.
  const kalanSaat = g.baslangic
    ? Math.round(((new Date(g.baslangic).getTime() - Date.now()) / 3600000) * 10) / 10
    : null

  prisma.venueOlay
    .create({
      data: {
        venueId: g.venueId,
        aktor: g.aktor ?? 'venue',
        olay: g.olay,
        hedefTur: g.hedefTur ?? null,
        hedefId: g.hedefId ?? null,
        oncesi: (g.oncesi ?? null) as never,
        sonrasi: (g.sonrasi ?? null) as never,
        etkilenen: g.etkilenen ?? 0,
        kalanSaat,
      },
    })
    .catch(e => console.error('[venueOlay] yazılamadı', g.olay, (e as Error).message))
}

/**
 * Bir nesneden yalnız İZLENEN alanları çıkarır.
 *
 * Tüm nesneyi yazmıyoruz: günlük gereksiz şişer ve ilgisiz kişisel veri sızdırabilir.
 * Yalnız salonun davranışını anlatan alanlar tutulur.
 */
export const izlenen = (o: Record<string, unknown> | null | undefined) => {
  if (!o) return null
  const alanlar = ['startsAt', 'endsAt', 'capacity', 'status', 'basePrice', 'isActive', 'title', 'meetingUrl', 'deliveryMode']
  const c: Record<string, unknown> = {}
  for (const a of alanlar) if (o[a] !== undefined) c[a] = o[a]
  // meetingUrl BİLET niteliğinde (İptal-İade m.7.2) — günlüğe adresin kendisi yazılmaz,
  // yalnız değişip değişmediği. Admin panelinde okunabilir bir log, bileti sızdırmamalı.
  if ('meetingUrl' in c) c.meetingUrl = c.meetingUrl ? '(var)' : null
  return Object.keys(c).length ? c : null
}
