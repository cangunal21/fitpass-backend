import prisma from './prisma'
import { longestDailyStreak } from './streak'

// Kullanıcının kazanmış olması gereken rozetleri hesaplar ve eksikleri verir.
// Geriye yeni kazanılan rozet adlarını döndürür (bildirim için).
export async function syncUserBadges(userId: number): Promise<string[]> {
  const now = new Date()

  const [bookings, dropins, badges, earned, user] = await Promise.all([
    prisma.booking.findMany({
      where: { userId, status: 'confirmed', session: { startsAt: { lt: now } } },
      select: {
        taggedFriends: true,
        session: { select: { startsAt: true, class: { select: { category: true, venueId: true } } } },
      },
    }),
    prisma.dropInParticipant.findMany({
      where: { userId, status: 'confirmed', slot: { startsAt: { lt: now } } },
      select: { slot: { select: { startsAt: true, venueId: true, sportCategory: { select: { name: true } } } } },
    }),
    prisma.badge.findMany(),
    prisma.userBadge.findMany({ where: { userId }, select: { badgeId: true, sportCategoryId: true } }),
    prisma.user.findUnique({ where: { id: userId }, select: { tier: { select: { name: true } } } }),
  ])

  const totalLessons = bookings.length + dropins.length
  const dates = [
    ...bookings.map(b => b.session?.startsAt),
    ...dropins.map(d => d.slot?.startsAt),
  ].filter(Boolean) as Date[]
  const streak = longestDailyStreak(dates)

  // Spor adları (ders kategorisi metni + drop-in spor adı)
  const sportNames = [
    ...bookings.map(b => b.session?.class?.category),
    ...dropins.map(d => d.slot?.sportCategory?.name),
  ].filter(Boolean) as string[]
  const distinctSports = new Set(sportNames).size

  const sportCounts = new Map<string, number>()
  for (const s of sportNames) sportCounts.set(s, (sportCounts.get(s) || 0) + 1)

  const venueCounts = new Map<number, number>()
  for (const b of bookings) { const v = b.session?.class?.venueId; if (v) venueCounts.set(v, (venueCounts.get(v) || 0) + 1) }
  for (const d of dropins) { const v = d.slot?.venueId; if (v) venueCounts.set(v, (venueCounts.get(v) || 0) + 1) }
  const maxVenue = venueCounts.size ? Math.max(...venueCounts.values()) : 0

  const teamCount = bookings.filter(b => Array.isArray(b.taggedFriends) && (b.taggedFriends as any[]).length > 0).length

  const earnedBadgeIds = new Set(earned.map(e => e.badgeId))
  const earnedSportIds = new Set(earned.filter(e => e.sportCategoryId != null).map(e => e.sportCategoryId as number))

  const newlyAwarded: string[] = []
  const toCreate: { userId: number; badgeId: number; sportCategoryId: number | null }[] = []

  for (const badge of badges) {
    if (badge.criteriaType === 'sport_master') {
      const threshold = badge.criteriaValue || 40
      for (const [name, count] of sportCounts) {
        if (count < threshold) continue
        const sc = await prisma.sportCategory.findFirst({ where: { name }, select: { id: true } })
        if (sc && !earnedSportIds.has(sc.id)) {
          toCreate.push({ userId, badgeId: badge.id, sportCategoryId: sc.id })
          earnedSportIds.add(sc.id)
          newlyAwarded.push(`${name} ustası`)
        }
      }
      continue
    }

    if (earnedBadgeIds.has(badge.id)) continue

    let ok = false
    switch (badge.criteriaType) {
      case 'first_lesson': ok = totalLessons >= 1; break
      case 'lessons': ok = totalLessons >= (badge.criteriaValue || 0); break
      case 'streak': ok = streak >= (badge.criteriaValue || 0); break
      case 'variety': ok = distinctSports >= (badge.criteriaValue || 0); break
      case 'loyalty': ok = maxVenue >= (badge.criteriaValue || 0); break
      case 'team': ok = teamCount >= (badge.criteriaValue || 0); break
      case 'tier_top': ok = user?.tier?.name === 'Olimpik'; break
    }
    if (ok) {
      toCreate.push({ userId, badgeId: badge.id, sportCategoryId: null })
      newlyAwarded.push(badge.name)
    }
  }

  if (toCreate.length) {
    await prisma.userBadge.createMany({ data: toCreate })
  }
  return newlyAwarded
}
