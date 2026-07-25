import prisma from './prisma'
import { trYear } from './season'

export async function computeCompletedLessons(userId: number): Promise<number> {
  const now = new Date()
  // GAMING ÖNLEME: yalnız GERÇEKTEN gidilen (checkedIn) dersler sayılır — booking-and-no-show ile
  // tier/pointRate şişirilmesin (streak/rozet/liderlik ile aynı kural).
  const [classCount, dropInCount] = await Promise.all([
    prisma.booking.count({
      where: { userId, status: 'confirmed', checkedIn: true, session: { startsAt: { lt: now } } },
    }),
    prisma.dropInParticipant.count({
      where: { userId, status: 'confirmed', checkedIn: true, slot: { startsAt: { lt: now } } },
    }),
  ])
  return classCount + dropInCount
}

// Puanları yılda bir sıfırla (lazy): ait olduğu yıl geçmişse 0'la.
// Puan kazandırma sistemi eklenince otomatik her 1 Ocak'ta sıfırlanır.
export async function resetYearlyPointsIfNeeded(userId: number) {
  const currentYear = trYear() // TR duvar-saati yılı — UTC yıl sınırı (Railway) 3 saat kayardı
  // Koşullu + atomik (mutlak SET yerine): yıl damgası eskiyse SIFIRLA+damgala; damga yoksa yalnız damgala.
  // İki updateMany koşulu (lt vs null) örtüşmez → idempotent, eşzamanlı çağrıda tutarlı.
  await prisma.user.updateMany({
    where: { id: userId, rewardPointsYear: { lt: currentYear } },
    data: { rewardPoints: 0, rewardPointsYear: currentYear },
  })
  await prisma.user.updateMany({
    where: { id: userId, rewardPointsYear: null },
    data: { rewardPointsYear: currentYear },
  })
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
