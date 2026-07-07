import prisma from '../utils/prisma'
import { seasonInfo } from '../utils/season'
import { sendPushNotification } from '../utils/push'

// Sezon-sonu şampiyon rozetleri: bir sezon tamamlandığında, biten sezon için
// HER spor × HER ilçe ve HER il kırılımında ilk 3'e (1=altın/2=gümüş/3=bronz)
// 'season_champion' rozeti verir. Sezon başına TEK kez (seasonKey ile çift-vermez).
// Sıralama liderlikle aynı kuralla: kullanıcının EV konumu (neighborhoodId → cityId),
// biten sezondaki onaylı ders sayısı; banlı/gizli hariç.
export async function awardSeasonChampions() {
  try {
    const now = new Date()
    const cur = seasonInfo(now)
    // En son tamamlanmış sezon = güncel sezon başlangıcından 1 gün öncesi
    const prev = seasonInfo(new Date(cur.start.getTime() - 86400000))
    const windowStart = prev.start
    const windowEnd = cur.start // [prev.start, cur.start)

    const champBadge = await prisma.badge.findUnique({ where: { key: 'season_champion' }, select: { id: true } })
    if (!champBadge) return // ensureBadges henüz çalışmamış

    // Bu sezon için zaten ödül verildi mi? (tek-instance için yeterli çift-verme koruması)
    const already = await prisma.userBadge.count({ where: { badgeId: champBadge.id, seasonKey: prev.key } })
    if (already > 0) return

    const bookings = await prisma.booking.findMany({
      where: { status: 'confirmed', session: { startsAt: { gte: windowStart, lt: windowEnd } } },
      select: {
        userId: true,
        user: { select: { banned: true, activityPrivacy: true, neighborhoodId: true, neighborhood: { select: { cityId: true } } } },
        session: { select: { class: { select: { sportCategoryId: true } } } },
      },
    })

    // key: `${sportCategoryId}|${scopeType}|${scopeId}` → (userId → dersSayısı)
    const groups = new Map<string, Map<number, number>>()
    const bump = (sport: number, scopeType: string, scopeId: number, userId: number) => {
      const k = `${sport}|${scopeType}|${scopeId}`
      let g = groups.get(k); if (!g) { g = new Map(); groups.set(k, g) }
      g.set(userId, (g.get(userId) || 0) + 1)
    }
    for (const b of bookings) {
      const u = b.user
      if (!u || u.banned || u.activityPrivacy === 'private') continue // liderlikle aynı filtre
      const sport = b.session?.class?.sportCategoryId
      if (!sport) continue
      if (u.neighborhoodId) bump(sport, 'district', u.neighborhoodId, b.userId)
      if (u.neighborhood?.cityId) bump(sport, 'city', u.neighborhood.cityId, b.userId)
    }

    const toCreate: { userId: number; badgeId: number; sportCategoryId: number; scopeType: string; scopeId: number; rank: number; seasonKey: string }[] = []
    const winnersByUser = new Map<number, number>()
    for (const [k, g] of groups) {
      const [sportStr, scopeType, scopeIdStr] = k.split('|')
      const sportCategoryId = parseInt(sportStr)
      const scopeId = parseInt(scopeIdStr)
      const ranked = [...g.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3) // ilk 3
      ranked.forEach(([userId], i) => {
        toCreate.push({ userId, badgeId: champBadge.id, sportCategoryId, scopeType, scopeId, rank: i + 1, seasonKey: prev.key })
        winnersByUser.set(userId, (winnersByUser.get(userId) || 0) + 1)
      })
    }

    if (toCreate.length === 0) return
    await prisma.userBadge.createMany({ data: toCreate })

    // Kazananlara bildirim (best-effort)
    const users = await prisma.user.findMany({ where: { id: { in: [...winnersByUser.keys()] } }, select: { id: true, pushToken: true } })
    for (const u of users) {
      const n = winnersByUser.get(u.id) || 0
      const msg = `${prev.label} sezonunda ${n} şampiyonluk rozeti kazandın! 🏆`
      await prisma.notification.create({ data: { userId: u.id, type: 'badge', message: msg } }).catch(() => {})
      if (u.pushToken) sendPushNotification(u.pushToken, 'Sezon şampiyonu! 🏆', msg).catch(() => {})
    }
    console.log(`🏆 ${prev.key}: ${toCreate.length} şampiyon rozeti verildi (${users.length} kişi).`)
  } catch (err) {
    console.error('Season champion job error:', err)
  }
}
