import prisma from './prisma'

// Kanonik rozet kataloğu — kod-yönetimli tek kaynak (ensureTiers gibi, boot'ta idempotent).
// Mevcut key'ler korunur (UserBadge referansları kırılmasın) ama kriter değerleri/isim/ikon
// güncellenir. Kademeli streak rozetleri (streak_3/7/30) kaldırıldı → tek "rekor seri"
// (User.recordStreak) modeli. iconUrl = frontend'in rozet görseline eşlediği anahtar.
const CANONICAL = [
  { key: 'first_lesson',    name: 'İlk adım',       description: 'İlk dersini tamamladın',              criteriaType: 'first_lesson', criteriaValue: 1,   iconUrl: 'Flag' },
  { key: 'lessons_10',      name: 'Düzenli',        description: 'Bir sezonda 10 derse ulaştın',        criteriaType: 'lessons',      criteriaValue: 10,  iconUrl: 'Target' },
  { key: 'variety_5',       name: 'Çok yönlü',      description: '3 farklı spor dalına gittin',         criteriaType: 'variety',      criteriaValue: 3,   iconUrl: 'Compass' },
  { key: 'loyalty_10',      name: 'Sadık sporcu',   description: 'Aynı salona 5 kez gittin',            criteriaType: 'loyalty',      criteriaValue: 5,   iconUrl: 'Heart' },
  { key: 'team_5',          name: 'Takım oyuncusu', description: '3 kez arkadaşınla (etiketleyerek) gittin', criteriaType: 'team',    criteriaValue: 3,   iconUrl: 'Users' },
  { key: 'sport_master_40', name: 'Spor ustası',    description: 'Bir spor dalında 40 ders yaptın',     criteriaType: 'sport_master', criteriaValue: 40,  iconUrl: 'sport' },
  { key: 'tier_olimpik',    name: 'Olimpik',        description: 'Olimpik seviyeye ulaştın',            criteriaType: 'tier_top',     criteriaValue: 120, iconUrl: 'Trophy' },
  { key: 'founder',         name: 'Kurucu',         description: 'İlk 500 üyeden birisin',              criteriaType: 'founder',      criteriaValue: 500, iconUrl: 'Crown' },
  { key: 'referral',        name: 'Elçi',           description: '3 davetini tamamladın',               criteriaType: 'referral',     criteriaValue: 3,   iconUrl: 'Speakerphone' },
  { key: 'season_champion', name: 'Sezon Şampiyonu', description: 'Bir sezonda ilinde/ilçende bir spor dalında ilk 3’e girdin', criteriaType: 'season_champion', criteriaValue: null, iconUrl: 'champion' },
]

export async function ensureBadges() {
  try {
    for (const b of CANONICAL) {
      await prisma.badge.upsert({
        where: { key: b.key },
        update: { name: b.name, description: b.description, criteriaType: b.criteriaType, criteriaValue: b.criteriaValue, iconUrl: b.iconUrl },
        create: b,
      })
    }
    // Kademeli streak rozetlerini kaldır (artık tek rekor-seri var) — önce UserBadge referansları
    const streakBadges = await prisma.badge.findMany({ where: { criteriaType: 'streak' }, select: { id: true } })
    if (streakBadges.length) {
      const ids = streakBadges.map(s => s.id)
      await prisma.userBadge.deleteMany({ where: { badgeId: { in: ids } } })
      await prisma.badge.deleteMany({ where: { id: { in: ids } } })
    }
  } catch (e) {
    console.error('ensureBadges error:', e)
  }
}
