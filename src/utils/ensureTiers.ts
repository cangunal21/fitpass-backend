import prisma from './prisma'

// Seviye (Tier) yapılandırmasının KANONİK kaynağı. Puan-kazanma oranı (pointRate, %)
// ve eşikler (minLessons) burada kodda tanımlıdır. Sunucu her açılışta bu 5 satırı
// idempotent upsert eder → prod DB (veya reseed edilmiş herhangi bir ortam) her deploy'da
// otomatik olarak bu değerlere hizalanır. Böylece "DB'de elle girilmiş, kaynağı belirsiz"
// tier verisi sorunu biter; oranlar tek yerden yönetilir.
//
// Oran yapısı: Aday %1 · Sporcu %2 · Profesyonel %3 · Elit %4 · Olimpik %5
const CANONICAL_TIERS = [
  { id: 1, name: 'Aday',        minLessons: 0,   pointRate: 1, colorHex: '#8B5CF6' },
  { id: 2, name: 'Sporcu',      minLessons: 10,  pointRate: 2, colorHex: '#10B981' },
  { id: 3, name: 'Profesyonel', minLessons: 35,  pointRate: 3, colorHex: '#3B82F6' },
  { id: 4, name: 'Elit',        minLessons: 70,  pointRate: 4, colorHex: '#F59E0B' },
  { id: 5, name: 'Olimpik',     minLessons: 120, pointRate: 5, colorHex: '#DC2626' },
]

// Açılışta çağrılır. Hata olursa loglar ama sunucuyu düşürmez (boot güvenli).
export async function ensureTiers(): Promise<void> {
  try {
    for (const t of CANONICAL_TIERS) {
      await prisma.tier.upsert({
        where: { id: t.id },
        update: { name: t.name, minLessons: t.minLessons, pointRate: t.pointRate, colorHex: t.colorHex },
        create: { id: t.id, name: t.name, minLessons: t.minLessons, pointRate: t.pointRate, colorHex: t.colorHex },
      })
    }
    console.log('✅ Tier yapılandırması senkronlandı (Aday %1 → Olimpik %5)')
  } catch (e: any) {
    console.error('ensureTiers hatası (sunucu ayakta):', e?.message || e)
  }
}
