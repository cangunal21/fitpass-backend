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
    // Var olan çift kayıt (olmamalı — kolon yeni) index'i düşürebilir; loglayıp devam et (uygulama
    // düzeyi dupe kontrolü zaten var). Sunucuyu düşürme.
    console.error('ensureIndexes hata (yok sayıldı):', e)
  }
}
