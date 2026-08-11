import prisma from '../utils/prisma'
import { awardAttendanceOnCheckin } from '../controllers/bookingController'

/**
 * KATILIM PUANI MUTABAKATI — check-in yapılmış ama puanı kredilenmemiş rezervasyonları tamamlar.
 *
 * NEDEN GEREKLİ: check-in ucunda puan kredisi "ateşle-unut" çağrılıyor:
 *   `awardAttendanceOnCheckin(booking.id).catch(() => {})`
 * Bu BİLİNÇLİ bir tercih — müşteri salonun kapısında beklerken puan yazımı yüzünden check-in'in
 * yavaşlaması ya da hata vermesi kabul edilemez. Ama çağrı başarısız olursa (süreç deploy
 * sırasında ölür, DB anlık hata verir, fonksiyonun kendi catch'i yutar) sonuç şu olur:
 *   • booking.checkedIn = true  → kullanıcı derse gitmiş görünür
 *   • RewardPoint('attendance') satırı YOK → puan HİÇ verilmemiştir
 *   • booking.pointsEarned rezervasyon anındaki TAHMİN olarak kalır (bayat)
 * Kullanıcı hak ettiği puanı hiç almaz ve kimse fark etmez.
 *
 * ÇÖZÜM: durum-tabanlı mutabakat (bekleme listesi süpürgesiyle aynı desen). Job, check-in'li
 * ama defterde 'attendance' satırı olmayan rezervasyonları bulur ve awardAttendanceOnCheckin'i
 * yeniden çağırır — fonksiyon zaten idempotenttir (satır varsa hiçbir şey yapmaz), o yüzden
 * çift kredi riski yoktur.
 */

/** Ne kadar geriye bakılacak. Check-in ancak seans saatine yakın yapılır; 7 gün fazlasıyla yeter. */
const GERIYE_GUN = 7

export async function reconcileAttendancePoints(): Promise<number> {
  try {
    const sinir = new Date(Date.now() - GERIYE_GUN * 86400000)

    // Check-in yapılmış ama 'attendance' defter satırı OLMAYAN rezervasyonlar.
    // (İlişkisel NOT EXISTS: rewardPoints ilişkisi Booking üzerinde tanımlı değil, o yüzden
    // iki adımda — önce adaylar, sonra defterde olanları çıkar.)
    const adaylar = await prisma.booking.findMany({
      where: {
        checkedIn: true,
        status: { in: ['confirmed', 'pending'] },
        checkedInAt: { gte: sinir },
      },
      select: { id: true },
      take: 500, // güvenlik sınırı; kalanlar sonraki turda
    })
    if (adaylar.length === 0) return 0

    const ids = adaylar.map(a => a.id)
    const kredili = await prisma.rewardPoint.findMany({
      where: { bookingId: { in: ids }, source: 'attendance' },
      select: { bookingId: true },
    })
    const krediliSet = new Set(kredili.map(k => k.bookingId))
    const eksik = ids.filter(id => !krediliSet.has(id))
    if (eksik.length === 0) return 0

    let tamamlanan = 0
    for (const id of eksik) {
      try {
        await awardAttendanceOnCheckin(id) // idempotent — yarışta ikinci çağrı 0 döner
        tamamlanan++
      } catch (e) {
        console.error(`Katılım puanı mutabakatı başarısız: booking#${id}`, e)
      }
    }
    console.warn(`⚠️ Katılım puanı mutabakatı: ${eksik.length} kredilenmemiş check-in bulundu, ${tamamlanan} tamamlandı.`)
    return tamamlanan
  } catch (err) {
    console.error('Attendance reconcile job error:', err)
    return 0
  }
}
