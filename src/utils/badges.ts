import prisma from './prisma'
import { longestDailyStreak } from './streak'
import { seasonInfo } from './season'

// Kullanıcının kazanmış olması gereken rozetleri hesaplar ve eksikleri verir.
// Geriye yeni kazanılan rozet adlarını döndürür (bildirim için).
export async function syncUserBadges(userId: number): Promise<string[]> {
  const now = new Date()

  const [bookings, dropins, badges, earned, user, completedReferrals] = await Promise.all([
    prisma.booking.findMany({
      // GAMING ÖNLEME: TÜM rozet sayaçları (ders/sport/venue/takım/streak) yalnızca GERÇEKTEN
      // gidilen (checkedIn) derslerden — booking-and-no-show ile rozet kazanılmasın.
      where: { userId, status: 'confirmed', checkedIn: true, session: { startsAt: { lt: now } } },
      select: {
        taggedFriends: true,
        checkedIn: true,
        session: { select: { startsAt: true, class: { select: { sportCategoryId: true, venueId: true, sportCategory: { select: { name: true } } } } } },
      },
    }),
    prisma.dropInParticipant.findMany({
      where: { userId, status: 'confirmed', checkedIn: true, slot: { startsAt: { lt: now } } },
      select: { checkedIn: true, slot: { select: { startsAt: true, venueId: true, sportCategoryId: true, sportCategory: { select: { name: true } } } } },
    }),
    prisma.badge.findMany(),
    prisma.userBadge.findMany({ where: { userId }, select: { badgeId: true, sportCategoryId: true } }),
    prisma.user.findUnique({ where: { id: userId }, select: { tier: { select: { name: true } }, recordStreak: true, createdAt: true } }),
    prisma.referral.count({ where: { referrerId: userId, status: 'completed' } }), // Elçi: tamamlanan davet
  ])

  const totalLessons = bookings.length + dropins.length
  // Düzenli rozeti: bir SEZON içinde 10 ders (all-time değil). HERHANGİ bir sezonda başarıldıysa
  // verilir — sadece güncel sezona bakmak, geçmiş sezonda 10'a ulaşıp o sezon uygulamayı hiç
  // açmayan kullanıcıyı kaçırırdı. Bu yüzden dersleri sezona göre grupla, EN YÜKSEK sezonu al.
  const seasonTally = new Map<string, number>()
  const tallySeason = (d?: Date | null) => { if (!d) return; const k = seasonInfo(new Date(d)).key; seasonTally.set(k, (seasonTally.get(k) || 0) + 1) }
  for (const b of bookings) tallySeason(b.session?.startsAt)
  for (const d of dropins) tallySeason(d.slot?.startsAt)
  const maxSeasonLessons = seasonTally.size ? Math.max(...seasonTally.values()) : 0
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

  // Spor kimliği FK (sportCategoryId) ile sayılır — serbest-metin `category` case/yazım farkıyla
  // aynı sporu ikiye bölerdi ("Yoga"≠"yoga") → variety/ustalık sayımı sapardı. id→ad (rozet mesajı için).
  const sportIdName = new Map<number, string>()
  const sportCounts = new Map<number, number>()
  const bumpSport = (id?: number | null, name?: string | null) => {
    if (id == null) return
    sportCounts.set(id, (sportCounts.get(id) || 0) + 1)
    if (name && !sportIdName.has(id)) sportIdName.set(id, name)
  }
  for (const b of bookings) bumpSport(b.session?.class?.sportCategoryId, b.session?.class?.sportCategory?.name)
  for (const d of dropins) bumpSport(d.slot?.sportCategoryId, d.slot?.sportCategory?.name)
  const distinctSports = sportCounts.size

  const venueCounts = new Map<number, number>()
  for (const b of bookings) { const v = b.session?.class?.venueId; if (v) venueCounts.set(v, (venueCounts.get(v) || 0) + 1) }
  for (const d of dropins) { const v = d.slot?.venueId; if (v) venueCounts.set(v, (venueCounts.get(v) || 0) + 1) }
  const maxVenue = venueCounts.size ? Math.max(...venueCounts.values()) : 0

  const teamCount = bookings.filter(b => Array.isArray(b.taggedFriends) && (b.taggedFriends as any[]).length > 0).length

  const earnedBadgeIds = new Set(earned.map(e => e.badgeId))

  const newlyAwarded: string[] = []
  const toCreate: { userId: number; badgeId: number; sportCategoryId: number | null }[] = []
  let regRank: number | null = null // Kurucu için kayıt sırası (lazy, tek kez hesaplanır)

  for (const badge of badges) {
    if (badge.criteriaType === 'sport_master') {
      const threshold = badge.criteriaValue || 40
      // Dedup YALNIZCA bu sport_master rozetine göre — şampiyon rozeti (aynı sportCategoryId'yi
      // taşır) o sporda ustalığı ENGELLEMESİN.
      const earnedMasterSports = new Set(earned.filter(e => e.badgeId === badge.id && e.sportCategoryId != null).map(e => e.sportCategoryId as number))
      for (const [scId, count] of sportCounts) {
        if (count < threshold) continue
        if (!earnedMasterSports.has(scId)) {
          toCreate.push({ userId, badgeId: badge.id, sportCategoryId: scId })
          earnedMasterSports.add(scId)
          newlyAwarded.push(`${sportIdName.get(scId) || 'Spor'} ustası`)
        }
      }
      continue
    }

    if (earnedBadgeIds.has(badge.id)) continue

    let ok = false
    switch (badge.criteriaType) {
      case 'first_lesson': ok = totalLessons >= 1; break
      case 'lessons': ok = maxSeasonLessons >= (badge.criteriaValue || 0); break // Düzenli = herhangi bir sezonda 10
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
      toCreate.push({ userId, badgeId: badge.id, sportCategoryId: null, _name: badge.name } as any)
    }
  }

  if (toCreate.length) {
    // newlyAwarded GERÇEKTEN YAZILAN satırlardan türetilir. Önceden hesaplanan `toCreate` listesinden
    // türetiliyordu: skipDuplicates zaten sahip olunan rozeti sessizce atlarken isim listede kalıyor,
    // kullanıcı aynı rozet için TEKRAR TEKRAR "yeni rozet" bildirimi/e-postası alıyordu.
    // Tekil create + P2002 yutma → yalnızca gerçekten eklenen satır sayılır (ifade-index'i ON CONFLICT'i tetikler).
    for (const row of toCreate as any[]) {
      const { _name, ...data } = row
      try {
        await prisma.userBadge.create({ data })
        newlyAwarded.push(_name)
      } catch (e: any) {
        if (e?.code !== 'P2002') throw e // zaten sahip → sessizce atla, "yeni" sayma
      }
    }
  }
  return newlyAwarded
}
