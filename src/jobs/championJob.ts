import prisma from '../utils/prisma'
import { seasonInfo } from '../utils/season'
import { sendPushNotification } from '../utils/push'

// Sezon-sonu şampiyon rozetleri: bir sezon tamamlandığında, biten sezon için
// HER spor × HER ilçe ve HER il kırılımında ilk 3'e (1=altın/2=gümüş/3=bronz)
// 'season_champion' rozeti verir. Sezon başına TEK kez (seasonKey ile çift-vermez).
// Sıralama liderlikle aynı kuralla: kullanıcının EV konumu (neighborhoodId → cityId),
// biten sezondaki onaylı ders sayısı; banlı/gizli hariç.
// Lansman sezonu = Güz 2026 (1 Eyl–1 Ara 2026). İlk şampiyon ödülleri bu sezon bitince
// (1 Aralık 2026) düşer; lansman öncesi sezonlara (Bahar/Yaz 2026) ödül verilmez.
// 1 Eylül 2026 = Güz 2026 başlangıcı. TR (UTC+3) duvar-saatiyle — season.ts TR-tabanlı seasonStart
// ile HİZALI olmalı (aksi halde prev.start < LAUNCH karşılaştırması 3 saatlik kaymayla yanlış olurdu).
const LAUNCH_SEASON_START = new Date(Date.UTC(2026, 8, 1) - 3 * 3600 * 1000)

export async function awardSeasonChampions(now: Date = new Date()) {
  try {
    const cur = seasonInfo(now)
    // En son tamamlanmış sezon = güncel sezon başlangıcından 1 gün öncesi
    const prev = seasonInfo(new Date(cur.start.getTime() - 86400000))
    // Lansman zemini: Güz 2026'dan önceki sezonları ödüllendirme
    if (prev.start < LAUNCH_SEASON_START) return
    const windowStart = prev.start
    const windowEnd = cur.start // [prev.start, cur.start)

    const champBadge = await prisma.badge.findUnique({ where: { key: 'season_champion' }, select: { id: true } })
    if (!champBadge) return // ensureBadges henüz çalışmamış

    // Bu sezon için zaten ödül verildi mi? (tek-instance için yeterli çift-verme koruması)
    const already = await prisma.userBadge.count({ where: { badgeId: champBadge.id, seasonKey: prev.key } })
    if (already > 0) return

    const userSelect = { banned: true, activityPrivacy: true, neighborhoodId: true, neighborhood: { select: { cityId: true } } }
    const [bookings, dropins] = await Promise.all([
      prisma.booking.findMany({
        // GAMING ÖNLEME: kalıcı şampiyon rozeti yalnızca GERÇEKTEN gidilen (checkedIn) derslerden —
        // no-show/ücretsiz booking ile küçük bir ilçede sahte şampiyonluk kazanılmasın (liderlikle aynı).
        where: { status: 'confirmed', checkedIn: true, session: { startsAt: { gte: windowStart, lt: windowEnd } } },
        select: {
          userId: true,
          user: { select: userSelect },
          session: { select: { class: { select: { sportCategoryId: true } } } },
        },
      }),
      // Drop-in katılımları da şampiyonluğa sayılır (liderlik/streak ile tutarlı; slot.sportCategoryId kanonik FK).
      prisma.dropInParticipant.findMany({
        where: { status: 'confirmed', checkedIn: true, slot: { startsAt: { gte: windowStart, lt: windowEnd } } },
        select: {
          userId: true,
          user: { select: userSelect },
          slot: { select: { sportCategoryId: true } },
        },
      }),
    ])

    // key: `${sportCategoryId}|${scopeType}|${scopeId}` → (userId → aktiviteSayısı)
    const groups = new Map<string, Map<number, number>>()
    const bump = (sport: number, scopeType: string, scopeId: number, userId: number) => {
      const k = `${sport}|${scopeType}|${scopeId}`
      let g = groups.get(k); if (!g) { g = new Map(); groups.set(k, g) }
      g.set(userId, (g.get(userId) || 0) + 1)
    }
    const tally = (u: { banned: boolean; neighborhoodId: number | null; neighborhood: { cityId: number | null } | null } | null, sport: number | null | undefined, userId: number) => {
      if (!u || u.banned) return // liderlikle aynı: sıralama HERKESE açık, yalnız banlı hariç (gizli de şampiyon olabilir; rozet herkese görünür)
      if (!sport) return
      if (u.neighborhoodId) bump(sport, 'district', u.neighborhoodId, userId)
      if (u.neighborhood?.cityId) bump(sport, 'city', u.neighborhood.cityId, userId)
    }
    for (const b of bookings) tally(b.user, b.session?.class?.sportCategoryId, b.userId)
    for (const d of dropins) tally(d.user, d.slot?.sportCategoryId, d.userId)

    const toCreate: { userId: number; badgeId: number; sportCategoryId: number; scopeType: string; scopeId: number; rank: number; seasonKey: string }[] = []
    const winnersByUser = new Map<number, number>()
    for (const [k, g] of groups) {
      const [sportStr, scopeType, scopeIdStr] = k.split('|')
      const sportCategoryId = parseInt(sportStr)
      const scopeId = parseInt(scopeIdStr)
      // DETERMİNİSTİK: skor DESC, eşitlikte userId ASC (Map-insertion sırasına bağlı kalıp keyfî eleme yapma).
      const sorted = [...g.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])
      // Standart yarışma sıralaması: aynı skor → aynı derece (rank = kendinden KESİN büyük skorlu sayısı + 1).
      // İlk 3 DERECEYE kadar herkes ödül alır — eş-skorlu kazanan ELENMEZ (2 kişi 1.'yse ikisi de altın,
      // sonraki bronz). sorted skor-azalan olduğundan rank monoton artar → rank>3'te güvenle dur.
      for (const [userId, score] of sorted) {
        const rank = 1 + sorted.filter(([, s]) => s > score).length
        if (rank > 3) break
        toCreate.push({ userId, badgeId: champBadge.id, sportCategoryId, scopeType, scopeId, rank, seasonKey: prev.key })
        winnersByUser.set(userId, (winnersByUser.get(userId) || 0) + 1)
      }
    }

    if (toCreate.length === 0) return
    // skipDuplicates: job tekrar çalışsa/yarışsa aynı sezon-şampiyon rozetini iki kez YAZMASIN
    // (userbadge_award_unique ifade-index'i ile ON CONFLICT DO NOTHING).
    await prisma.userBadge.createMany({ data: toCreate, skipDuplicates: true })

    // BİLDİRİM YALNIZCA BU KOŞUDA GERÇEKTEN YAZILAN SATIRLARDAN. Eskiden yukarıda HESAPLANAN
    // winnersByUser kümesinden besleniyordu: satır 30'daki "zaten verildi mi" koruması atomik
    // olmayan bir count() olduğu için iki örtüşen koşuda ikisi de count=0 görüp devam edebiliyor;
    // rozetler skipDuplicates sayesinde tek kalıyor ama her şampiyona İKİ bildirim + İKİ push
    // gidiyordu. createdAt penceresiyle "bu koşuda eklenenler" ayıklanır.
    const runStart = new Date(Date.now() - 60000)
    const written = await prisma.userBadge.findMany({
      where: { badgeId: champBadge.id, seasonKey: prev.key, createdAt: { gte: runStart } },
      select: { userId: true },
    })
    if (written.length === 0) return // hepsi zaten vardı → bu koşu yeni bir şey yazmadı, susalım
    const writtenByUser = new Map<number, number>()
    for (const w of written) writtenByUser.set(w.userId, (writtenByUser.get(w.userId) || 0) + 1)

    const users = await prisma.user.findMany({ where: { id: { in: [...writtenByUser.keys()] } }, select: { id: true, pushToken: true } })
    for (const u of users) {
      const n = writtenByUser.get(u.id) || 0
      const msg = `${prev.label} sezonunda ${n} şampiyonluk rozeti kazandın! 🏆`
      await prisma.notification.create({ data: { userId: u.id, type: 'badge', message: msg } }).catch(() => {})
      if (u.pushToken) sendPushNotification(u.pushToken, 'Sezon şampiyonu! 🏆', msg).catch(() => {})
    }
    console.log(`🏆 ${prev.key}: ${toCreate.length} şampiyon rozeti verildi (${users.length} kişi).`)
  } catch (err) {
    console.error('Season champion job error:', err)
  }
}
