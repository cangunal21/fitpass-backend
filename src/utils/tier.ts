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
