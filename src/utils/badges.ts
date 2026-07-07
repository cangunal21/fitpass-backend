import prisma from './prisma'
import { longestDailyStreak } from './streak'
import { seasonInfo } from './season'

// Kullanıcının kazanmış olması gereken rozetleri hesaplar ve eksikleri verir.
// Geriye yeni kazanılan rozet adlarını döndürür (bildirim için).
export async function syncUserBadges(userId: number): Promise<string[]> {
  const now = new Date()

  const [bookings, dropins, badges, earned, user, completedReferrals] = await Promise.all([
    prisma.booking.findMany({
      where: { userId, status: 'confirmed', session: { startsAt: { lt: now } } },
      select: {
        taggedFriends: true,
        checkedIn: true, // streak yalnızca check-in'li günlerden hesaplanır (count/sport confirmed kalır)
        session: { select: { startsAt: true, class: { select: { category: true, venueId: true } } } },
      },
    }),
    prisma.dropInParticipant.findMany({
      where: { userId, status: 'confirmed', slot: { startsAt: { lt: now } } },
      select: { checkedIn: true, slot: { select: { startsAt: true, venueId: true, sportCategory: { select: { name: true } } } } },
    }),
    prisma.badge.findMany(),
    prisma.userBadge.findMany({ where: { userId }, select: { badgeId: true, sportCategoryId: true } }),
    prisma.user.findUnique({ where: { id: userId }, select: { tier: { select: { name: true } }, recordStreak: true, createdAt: true } }),
    prisma.referral.count({ where: { referrerId: userId, status: 'completed' } }), // Elçi: tamamlanan davet
  ])

  const totalLessons = bookings.length + dropins.length
  // Düzenli rozeti: bir SEZON içinde 10 ders (all-time değil). Sezon penceresinden say.
  const seasonStart = seasonInfo(now).start
  const seasonLessons =
    bookings.filter(b => b.session && new Date(b.session.startsAt) >= seasonStart).length +
    dropins.filter(d => d.slot && new Date(d.slot.startsAt) >= seasonStart).length
  // Streak = GERÇEKTEN gidilmiş (check-in'li) günler — takvim/liderlikle tutarlı
  const dates = [
    ...bookings.filter(b => b.checkedIn).map(b => b.session?.startsAt),
    ...dropins.filter(d => d.checkedIn).map(d => d.slot?.startsAt),
  ].filter(Boolean) as Date[]
  const streak = longestDailyStreak(dates)

  // Rekor seri: kullanıcının EN UZUN serisi profilde tek rozet olarak gösterilir.
  // Yeni rekor kırılınca güncellenir (7 olunca eski 3 gider, 7 yazar). Kademeli streak
  // rozeti YOK — tek evrilen rekor. (Serinin altına düşmek rekoru silmez, rekor kalıcı.)
  if (streak > (user?.recordStreak || 0)) {
    await prisma.user.update({ where: { id: userId }, data: { recordStreak: streak } }).catch(() => {})
  }

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
  let regRank: number | null = null // Kurucu için kayıt sırası (lazy, tek kez hesaplanır)

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
      case 'lessons': ok = seasonLessons >= (badge.criteriaValue || 0); break // Düzenli = sezonda 10
      // 'streak' kademeli rozeti kaldırıldı → tek "rekor seri" (User.recordStreak) modeli
      case 'variety': ok = distinctSports >= (badge.criteriaValue || 0); break
      case 'loyalty': ok = maxVenue >= (badge.criteriaValue || 0); break
      case 'team': ok = teamCount >= (badge.criteriaValue || 0); break
      case 'tier_top': ok = user?.tier?.name === 'Olimpik'; break
      // Elçi: 3 tamamlanan davet (davet edilen dersini booklayınca completed olur)
      case 'referral': ok = completedReferrals >= (badge.criteriaValue || 3); break
      // Kurucu: ilk 500 kayıttan biri + en az 1 ders (İlk adım ile birlikte düşer)
      case 'founder': {
        if (totalLessons < 1 || !user?.createdAt) { ok = false; break }
        if (regRank === null) regRank = await prisma.user.count({ where: { createdAt: { lte: user.createdAt } } })
        ok = regRank <= (badge.criteriaValue || 500)
        break
      }
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
