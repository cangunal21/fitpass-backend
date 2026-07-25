import prisma from './prisma'

// Şema @unique'in prod `db push` veri-kaybı uyarısına takılmadan DB-seviyesi tekillik sağlamak için
// idempotent partial unique index'ler. Boot'ta bir kez çalışır (IF NOT EXISTS → tekrar zararsız).
export async function ensureIndexes() {
  try {
    // Eğitmen e-postası (login kimliği) tekil olmalı; NULL'lara izin (davet edilmemiş hocalar).
    // E-postalar uygulama düzeyinde küçük harfle saklanır → düz (email) kolonu üzerinde index yeter.
    await prisma.$executeRawUnsafe(
      `CREATE UNIQUE INDEX IF NOT EXISTS instructor_email_unique ON "Instructor"(email) WHERE email IS NOT NULL`
    )
  } catch (e) {
    console.error('ensureIndexes (instructor_email) hata (yok sayıldı):', e)
  }

  try {
    // ROZET ÇİFT-VERİŞ koruması: syncUserBadges (oku-earned→createMany) ve championJob atomik DEĞİL —
    // eşzamanlı/tekrar çağrıda aynı rozet iki kez yazılabilirdi. Tüm rozet türlerini kapsayan ifade-tabanlı
    // tekil index (nullable'lar COALESCE ile normalize): düz=(user,badge); sport_master=+sportCategoryId;
    // season_champion=+seasonKey+scopeType+scopeId(+sport) — meşru çoklu şampiyon rozetine izin verir, yalnız
    // TIPATIP tekrarı engeller. createMany(skipDuplicates) bununla ON CONFLICT DO NOTHING'e döner.
    // Index'ten ÖNCE mevcut çiftleri temizle (aksi halde CREATE patlar); en küçük id kalır.
    await prisma.$executeRawUnsafe(`
      DELETE FROM "UserBadge" a USING "UserBadge" b
      WHERE a.id > b.id
        AND a."userId" = b."userId" AND a."badgeId" = b."badgeId"
        AND COALESCE(a."sportCategoryId",-1) = COALESCE(b."sportCategoryId",-1)
        AND COALESCE(a."seasonKey",'')     = COALESCE(b."seasonKey",'')
        AND COALESCE(a."scopeType",'')     = COALESCE(b."scopeType",'')
        AND COALESCE(a."scopeId",-1)       = COALESCE(b."scopeId",-1)
    `)
    await prisma.$executeRawUnsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS userbadge_award_unique ON "UserBadge"
      ("userId","badgeId",COALESCE("sportCategoryId",-1),COALESCE("seasonKey",''),COALESCE("scopeType",''),COALESCE("scopeId",-1))
    `)
  } catch (e) {
    console.error('ensureIndexes (userbadge_award) hata (yok sayıldı):', e)
  }
}
