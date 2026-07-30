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

// İptal/silme sırasında bir booking için GERİ ALINACAK puan miktarını hesaplar.
// CROSS-YEAR KORUMASI: puanlar her 1 Ocak'ta sıfırlanır (resetYearlyPointsIfNeeded). Bir booking
// ÖNCEKİ puan-yılında kazanılmışsa o puanlar reset'te ZATEN silinmiştir; iptalinde tekrar düşmek
// cari yılın MEŞRU puanını haksız siler (kullanıcı tek rezervasyon için iki kez puan kaybeder).
// booking'in kazanım yılı (createdAt, TR) kullanıcının güncel rewardPointsYear'ından ESKİYSE → 0 döndür.
// Aynı/yeni yıl ise Math.min ile bakiyeyi negatife düşürmeden düş.
export function reversiblePoints(
  pointsEarned: number,
  bookingCreatedAt: Date,
  userRewardPointsYear: number | null,
  currentBalance: number,
): number {
  if (!(pointsEarned > 0)) return 0
  const earnYear = trYear(new Date(bookingCreatedAt))
  // rewardPointsYear null → kullanıcı hiç reset görmemiş, tüm yıllar cari sayılır (düş).
  if (userRewardPointsYear != null && earnYear < userRewardPointsYear) return 0
  return Math.min(pointsEarned, Math.max(0, currentBalance))
}

export async function syncUserTier(userId: number) {
  const [count, tiers, current] = await Promise.all([
    computeCompletedLessons(userId),
    prisma.tier.findMany({ orderBy: { minLessons: 'desc' } }),
    prisma.user.findUnique({ where: { id: userId }, select: { totalLessonsCompleted: true, tierId: true } }),
  ])

  const tier = tiers.find(t => count >= t.minLessons) ?? tiers[tiers.length - 1] ?? null
  const newTierId = tier?.id ?? null

  // DIRTY-CHECK: değer değişmediyse YAZMA. getUserActivities her (anonim) public profil görüntülemede bunu
  // çağırıyordu → her istekte gereksiz User UPDATE'i = yazma amplifikasyonu + satır kilidi. Yalnız gerçekten
  // değişince güncelle.
  if (!current || current.totalLessonsCompleted !== count || current.tierId !== newTierId) {
    await prisma.user.update({
      where: { id: userId },
      data: { totalLessonsCompleted: count, tierId: newTierId },
    })
  }

  return { count, tier }
}
