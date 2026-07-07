import prisma from './prisma'

// Kod-yönetimli kanonik rozetleri idempotent garanti eder (ensureTiers gibi).
// Şimdilik yalnızca sezon-şampiyonu şablon rozeti; diğer rozetler (Kurucu/Elçi/usta)
// DB'de zaten var. UserBadge satırları scope/rank/seasonKey ile kişiye özel yazılır.
export async function ensureBadges() {
  try {
    await prisma.badge.upsert({
      where: { key: 'season_champion' },
      update: {},
      create: {
        key: 'season_champion',
        name: 'Sezon Şampiyonu',
        description: 'Bir sezonda ilinde/ilçesinde bir spor dalında ilk 3’e girenlere verilir.',
        criteriaType: 'season_champion',
      },
    })
  } catch (e) {
    console.error('ensureBadges error:', e)
  }
}
