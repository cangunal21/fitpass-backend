import prisma from './prisma'

// Şema @unique'in prod `db push` veri-kaybı uyarısına takılmadan DB-seviyesi tekillik sağlamak için
// idempotent partial unique index'ler. Boot'ta bir kez çalışır (IF NOT EXISTS → tekrar zararsız).
export async function ensureIndexes() {
  try {
    // Eğitmen e-postası (login kimliği) tekil olmalı; NULL'lara izin (davet edilmemiş hocalar).
    // E-postalar uygulama düzeyinde küçük harfle saklanır → düz (email) kolonu üzerinde index yeter.
    // UserBadge bloğundaki gibi ÖNCE mevcut çiftleri temizle: tek bir eski dupe, CREATE'i patlatıp
    // catch'e düşürüyordu ve tekillik SESSİZCE hiç kurulmuyordu (kalıcı koruma boşluğu).
    await prisma.$executeRawUnsafe(`
      DELETE FROM "Instructor" a USING "Instructor" b
      WHERE a.id > b.id AND a.email IS NOT NULL AND b.email IS NOT NULL AND lower(a.email) = lower(b.email)
        AND a."passwordHash" IS NULL
    `)
    await prisma.$executeRawUnsafe(
      `CREATE UNIQUE INDEX IF NOT EXISTS instructor_email_unique ON "Instructor"(email) WHERE email IS NOT NULL`
    )
  } catch (e) {
    console.error('ensureIndexes (instructor_email) hata (yok sayıldı):', e)
  }

  try {
    // SPOR KATEGORİSİ MÜKERRERLİĞİ: `SportCategory.name` şemada @unique DEĞİL, seed ise
    // createMany({skipDuplicates:true}) kullanıyor — skipDuplicates yalnız GERÇEK unique kısıt üzerinden
    // çalıştığı için seed her koşuşta aynı isimleri TEKRAR ekliyordu (dev DB'de Yoga id=1,12,23 gibi
    // üçe katlanmış hâl ölçüldü). Etkisi kozmetik değil: kategori-adı filtreleri (liderlik ?branch=,
    // ders listesi kategori filtresi) id'lere BÖLÜNÜR — bir kullanıcının Yoga dersi id=12'ye bağlıysa
    // id=1 ile filtreleyen sorguda GÖRÜNMEZ.
    // Birleştirme: en KÜÇÜK id kanonik kabul edilir, referanslar ona taşınır, boşalan kopya silinir.
    // İdempotent ve prod-güvenli (referans taşımak aynı isimli kategori için anlamca kayıpsızdır).
    const dupes = await prisma.$queryRawUnsafe<{ keep: number; drop: number }[]>(`
      SELECT MIN(id) OVER (PARTITION BY lower(name)) AS keep, id AS drop
      FROM "SportCategory"
    `)
    for (const { keep, drop } of dupes) {
      if (!keep || keep === drop) continue
      for (const [table, col] of [
        ['UserTierHistory', 'sportCategoryId'], ['UserBadge', 'sportCategoryId'],
        ['VenueSportCategory', 'sportCategoryId'], ['Class', 'sportCategoryId'],
        ['DropInSlot', 'sportCategoryId'], ['ActivityLog', 'sportCategoryId'],
        ['MonthlyLeaderboard', 'sportCategoryId'],
      ] as const) {
        await prisma.$executeRawUnsafe(`UPDATE "${table}" SET "${col}" = $1 WHERE "${col}" = $2`, keep, drop)
      }
      await prisma.$executeRawUnsafe(`DELETE FROM "SportCategory" WHERE id = $1`, drop)
      console.log(`ensureIndexes: mükerrer spor kategorisi birleştirildi (id ${drop} → ${keep})`)
    }
    // Tekrarı kalıcı engelle (bundan sonra seed'in skipDuplicates'i gerçekten çalışır)
    await prisma.$executeRawUnsafe(
      `CREATE UNIQUE INDEX IF NOT EXISTS sportcategory_name_lower_unique ON "SportCategory"(lower(name))`
    )
  } catch (e) {
    console.error('ensureIndexes (sportCategory dedupe) hata (yok sayıldı):', e)
  }

  try {
    // Kullanıcı adı uygulama genelinde büyük/küçük harf DUYARSIZ ele alınıyor ("Ali" ile "ali" aynı kişi
    // sayılıyor) ama şemadaki @unique byte-exact; tek koruma atomik OLMAYAN bir ILIKE findFirst'tü →
    // eşzamanlı iki kayıt "Ali"/"ali" olarak birlikte var olabilirdi. Kullanıcı adı kayıttan sonra
    // değiştirilemediği için bu kalıcı bir kimlik çakışması olurdu.
    await prisma.$executeRawUnsafe(
      `CREATE UNIQUE INDEX IF NOT EXISTS user_username_lower_unique ON "User"(lower(username))`
    )
  } catch (e) {
    console.error('ensureIndexes (user_username_lower) hata (yok sayıldı):', e)
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
