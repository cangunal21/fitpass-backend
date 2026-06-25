import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'

const connectionString = process.env.DATABASE_URL ?? 'postgresql://cangunal@localhost:5432/fitpass'

// Bağlantı havuzu: varsayılan pg max=10 yük altında darboğaz yapıyordu.
// DB_POOL_MAX ile ayarlanır (Railway/Postgres plan limitine göre); varsayılan 20.
const adapter = new PrismaPg({ connectionString, max: Number(process.env.DB_POOL_MAX || 20) })

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient }

export const prisma: PrismaClient = globalForPrisma.prisma || new PrismaClient({ adapter })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma

export default prisma
