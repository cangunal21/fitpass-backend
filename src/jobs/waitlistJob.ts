import prisma from '../utils/prisma'
import { notifyFirstWaitlistUser } from '../controllers/waitlistController'

/**
 * BEKLEME LİSTESİ SÜPÜRGESİ — boşalan yerin sessizce boş kalmasını engeller.
 *
 * NEDEN GEREKLİ: `notifyFirstWaitlistUser` yalnızca bir OLAY üzerine çağrılıyordu
 * (cancelBooking). Bu iki durumu kaçırıyordu:
 *
 *  1) 30 DAKİKALIK ÖNCELİK PENCERESİ DOLUNCA. Bildirim alan kişi yeri kapamazsa satırı
 *     `notified` kalır ve 30 dk sonra tekrar uygun hale gelir — ama o anda yeni bir iptal
 *     olmadıkça KİMSE tekrar bakmıyordu. Yer boş, sırada insan var, kimseye haber gitmiyor.
 *  2) SALON KAPASİTEYİ ARTIRINCA. updateSession kapasiteyi büyütünce yer açılır ama hiçbir
 *     kod yolu bekleme listesine haber vermiyordu.
 *
 * ÇÖZÜM: olay-tabanlı yerine DURUM-TABANLI (mutabakat). Job "yeri olan + bekleyeni olan"
 * seansları tarar; yeri nasıl açıldığı önemli değil. Bu sayede gelecekte boşluk yaratan
 * yeni bir kod yolu eklense bile bekleyenler otomatik haberdar olur.
 */

/** Bildirim önceliği penceresi — waitlistController'daki INTERVAL '30 minutes' ile AYNI olmalı. */
const TUR_TAVANI = 50 // tek seansta bir turda en çok bu kadar bildirim (mutlak emniyet freni)
const PENCERE_DK = 30

export async function sweepWaitlist(): Promise<number> {
  try {
    const simdi = new Date()
    const pencereBaslangic = new Date(simdi.getTime() - PENCERE_DK * 60 * 1000)

    // Bildirilebilir bekleyeni olan gelecekteki açık seanslar.
    // 'waiting' hiç bildirilmemiş; 'notified' + eski notifiedAt penceresi dolmuş demektir.
    const adaylar = await prisma.waitlist.findMany({
      where: {
        OR: [
          { status: 'waiting' },
          { status: 'notified', notifiedAt: { lt: pencereBaslangic } },
        ],
        user: { banned: false },
        session: { status: 'open', startsAt: { gt: simdi } },
      },
      select: { sessionId: true },
      distinct: ['sessionId'],
      take: 200, // güvenlik sınırı; bir turda kapatılamayan bir sonraki turda ele alınır
    })
    if (adaylar.length === 0) return 0

    const sessionIds = [...new Set(adaylar.map(a => a.sessionId))]

    // Kapasiteler, doluluklar ve BEKLEYEN SAYILARI — TEK turda (seans başına ayrı sorgu atma).
    const [seanslar, doluluklar, bekleyenler] = await Promise.all([
      prisma.class_Session.findMany({
        where: { id: { in: sessionIds } },
        select: { id: true, capacity: true },
      }),
      prisma.booking.groupBy({
        by: ['sessionId'],
        where: { sessionId: { in: sessionIds }, status: { in: ['confirmed', 'pending'] } },
        _sum: { groupSize: true },
      }),
      // Kaç kişiye haber verilebileceğinin ÜST SINIRI: gerçekten bekleyen kişi sayısı.
      prisma.waitlist.groupBy({
        by: ['sessionId'],
        where: {
          sessionId: { in: sessionIds },
          OR: [{ status: 'waiting' }, { status: 'notified', notifiedAt: { lt: pencereBaslangic } }],
          user: { banned: false },
        },
        _count: { _all: true },
      }),
    ])
    const doluMap = new Map<number, number>()
    for (const d of doluluklar) if (d.sessionId != null) doluMap.set(d.sessionId, d._sum.groupSize || 0)
    const bekleyenMap = new Map<number, number>()
    for (const b of bekleyenler) if (b.sessionId != null) bekleyenMap.set(b.sessionId, b._count._all || 0)

    let bildirim = 0
    for (const s of seanslar) {
      if (s.capacity == null) continue
      const bos = s.capacity - (doluMap.get(s.id) || 0)
      if (bos <= 0) continue
      // Boş yer kadar kişiye haber ver (2 yer açıldıysa 2 kişi). notifyFirstWaitlistUser her
      // çağrıda FOR UPDATE SKIP LOCKED ile SIRADAKİ uygun bekleyeni sahiplenir; uygun kimse
      // kalmadıysa sessizce döner.
      //
      // DÖNGÜ BEKLEYEN SAYISIYLA SINIRLI: eskiden yalnız BOŞ KAPASİTEye bağlıydı. Kapasitesi
      // çok büyük bir seans (yazım hatası ya da kötü niyetli bir salon) bu döngüyü yüz binlerce
      // kez döndürüp DB havuzunu tüketebiliyor ve süpürgeyi kilitleyebiliyordu — oysa haber
      // verilecek kişi zaten bir avuç. TUR_TAVANI ayrıca mutlak bir emniyet freni.
      const hedef = Math.min(bos, bekleyenMap.get(s.id) || 0, TUR_TAVANI)
      for (let i = 0; i < hedef; i++) {
        await notifyFirstWaitlistUser(s.id)
        bildirim++
      }
    }

    if (bildirim > 0) console.log(`🔔 Bekleme listesi süpürgesi: ${seanslar.length} seans tarandı, ${bildirim} bildirim denemesi.`)
    return bildirim
  } catch (err) {
    console.error('Waitlist sweep job error:', err)
    return 0
  }
}
