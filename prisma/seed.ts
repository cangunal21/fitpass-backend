import { PrismaPg } from '@prisma/adapter-pg'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { PrismaClient } = require('@prisma/client')

const connectionString = process.env.DATABASE_URL ?? 'postgresql://cangunal@localhost:5432/fitpass'
const adapter = new PrismaPg({ connectionString })
const prisma = new PrismaClient({ adapter })

const sports = [
  { name: 'Yoga', iconUrl: 'yoga', colorHex: '#7C3AED', hasInstructor: true },
  { name: 'Pilates', iconUrl: 'pilates', colorHex: '#DB2777', hasInstructor: true },
  { name: 'Boks', iconUrl: 'boxing', colorHex: '#DC2626', hasInstructor: true },
  { name: 'HIIT', iconUrl: 'hiit', colorHex: '#EA580C', hasInstructor: true },
  { name: 'Halı Saha', iconUrl: 'football', colorHex: '#16A34A', hasInstructor: false },
  { name: 'Basketbol', iconUrl: 'basketball', colorHex: '#D97706', hasInstructor: false },
  { name: 'Padel', iconUrl: 'padel', colorHex: '#0891B2', hasInstructor: false },
  { name: 'Dans', iconUrl: 'dance', colorHex: '#C026D3', hasInstructor: true },
  { name: 'Yüzme', iconUrl: 'swimming', colorHex: '#0284C7', hasInstructor: true },
  { name: 'Crossfit', iconUrl: 'crossfit', colorHex: '#B45309', hasInstructor: true },
  { name: 'Diğer', iconUrl: 'zap', colorHex: '#6B7280', hasInstructor: false },
]

async function main() {
  await prisma.sportCategory.createMany({
    data: sports,
    skipDuplicates: true,
  })
  console.log('Sport categories seeded.')
}

main().catch(console.error).finally(() => prisma.$disconnect())
