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
    // SINIR, ELEMEDEN SONRA UYGULANMALI. Eskiden `take: 500` TÜM check-in'lilere uygulanıyor,
    // "defterde satırı var mı" elemesi ise o dilimin üzerinde BELLEKTE yapılıyordu. orderBy da yoktu.
    // Sonuç: kredilenmiş 500 kayıt dilimi doldurunca kredisizler pencereye hiç giremiyor ve
    // GERIYE_GUN=7 dolunca kalıcı düşüyorlardı — mutabakat işi mutabakatı yapamıyor.
    // ÖLÇÜLDÜ: 600 check-in (550 kredili / 50 kredisiz) → 5 turun HEPSİNDE tamamlanan=0.
    // Booking üzerinde rewardPoints ilişkisi tanımlı olmadığı için eleme SQL'de NOT EXISTS ile
    // yapılıyor; böylece LIMIT "eksik olanlara" uygulanıyor. En eskiden başla ki birikmiş iş boşalsın.
    const eksikSatirlar = await prisma.$queryRaw<{ id: number }[]>`
      SELECT b.id FROM "Booking" b
      WHERE b."checkedIn" = true
        AND b.status IN ('confirmed', 'pending')
        AND b."checkedInAt" >= ${sinir}
        AND NOT EXISTS (
          SELECT 1 FROM "RewardPoint" rp
          WHERE rp."bookingId" = b.id AND rp.source = 'attendance'
        )
      ORDER BY b."checkedInAt" ASC
      LIMIT 500
    `
    const eksik = eksikSatirlar.map(r => Number(r.id))
    if (eksik.length === 0) return 0
    console.log(`🧾 Mutabakat: ${eksik.length} kredilenmemiş check-in bulundu, işleniyor…`)

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
