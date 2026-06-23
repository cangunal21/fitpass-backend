import prisma from './prisma'

export async function computeCompletedLessons(userId: number): Promise<number> {
  const now = new Date()
  const [classCount, dropInCount] = await Promise.all([
    prisma.booking.count({
      where: { userId, status: 'confirmed', session: { startsAt: { lt: now } } },
    }),
    prisma.dropInParticipant.count({
      where: { userId, status: 'confirmed', slot: { startsAt: { lt: now } } },
    }),
  ])
  return classCount + dropInCount
}

// Puanları yılda bir sıfırla (lazy): ait olduğu yıl geçmişse 0'la.
// Puan kazandırma sistemi eklenince otomatik her 1 Ocak'ta sıfırlanır.
export async function resetYearlyPointsIfNeeded(userId: number) {
  const currentYear = new Date().getFullYear()
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { rewardPointsYear: true },
  })
  if (!user) return
  if (user.rewardPointsYear == null) {
    // İlk kez: yıl damgasını koy, puana dokunma
    await prisma.user.update({ where: { id: userId }, data: { rewardPointsYear: currentYear } })
  } else if (user.rewardPointsYear < currentYear) {
    // Yeni yıl: puanları sıfırla
    await prisma.user.update({ where: { id: userId }, data: { rewardPoints: 0, rewardPointsYear: currentYear } })
  }
}

export async function syncUserTier(userId: number) {
  const [count, tiers] = await Promise.all([
    computeCompletedLessons(userId),
    prisma.tier.findMany({ orderBy: { minLessons: 'desc' } }),
  ])

  const tier = tiers.find(t => count >= t.minLessons) ?? tiers[tiers.length - 1] ?? null

  await prisma.user.update({
    where: { id: userId },
    data: { totalLessonsCompleted: count, tierId: tier?.id ?? null },
  })

  return { count, tier }
}
