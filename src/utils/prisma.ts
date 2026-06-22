import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'

const connectionString = process.env.DATABASE_URL ?? 'postgresql://cangunal@localhost:5432/fitpass'

const adapter = new PrismaPg({ connectionString })

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient }

export const prisma: PrismaClient = globalForPrisma.prisma || new PrismaClient({ adapter })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma

export default prisma
