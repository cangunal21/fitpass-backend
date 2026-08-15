import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'

const connectionString = process.env.DATABASE_URL ?? 'postgresql://cangunal@localhost:5432/fitpass'

// Bağlantı havuzu: varsayılan pg max=10 yük altında darboğaz yapıyordu.
// DB_POOL_MAX ile ayarlanır (Railway/Postgres plan limitine göre); varsayılan 20.
//
// ── ZAMAN AŞIMLARI (15 Ağu 2026) ────────────────────────────────────────────────────────────
// Havuzda HİÇBİR sınır yoktu. Sonuçları:
//   · Asılan tek bir sorgu bir bağlantıyı SONSUZA DEK tutar (sunucu tarafı iptal yok).
//   · 20 bağlantı da tutulunca sonraki her istek kuyrukta SÜRESİZ bekler — istemci zaman
//     aşımına uğrar, sunucu hâlâ "çalışıyor" sanır ve yük birikmeye devam eder.
//   · Boşta kalan bağlantılar kapanmadığı için ağ/DB tarafında kopan ("yarı açık") bağlantılar
//     havuzda ölü olarak kalabiliyordu.
// Hiçbir sınır, herhangi bir sınırdan kötüdür: sınır varsa hata GÖRÜNÜR olur ve iyileşme
// kendiliğinden gelir.
const adapter = new PrismaPg({
  connectionString,
  max: Number(process.env.DB_POOL_MAX || 20),
  // Tek bir SORGUnun üst sınırı. En uzun transaction bütçesiyle (30sn, bkz. venueController
  // purge/transfer) aynı tutuldu ki meşru bir iş yarıda kesilmesin — ama sonsuz da kalmasın.
  statement_timeout: Number(process.env.DB_STATEMENT_TIMEOUT_MS || 30_000),
  // Havuzdan bağlantı BEKLEME üst sınırı. Havuz doluysa süresiz kuyruğa girmek yerine hızlıca
  // hata ver: istemci anlamlı bir hata görür, sunucu da kuyrukta iş biriktirmez.
  connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS || 10_000),
  // Boştaki bağlantıyı kapat — yarı açık bağlantılar havuzda ölü olarak birikmesin.
  idleTimeoutMillis: 30_000,
})

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient }

export const prisma: PrismaClient = globalForPrisma.prisma || new PrismaClient({ adapter })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma

export default prisma
