import 'dotenv/config' // sunucunun (src/index.ts) yaptığı gibi: sırlar .env'den gelir, gömülü varsayılan YOK
import { PrismaPg } from '@prisma/adapter-pg'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { PrismaClient } = require('@prisma/client')

const connectionString = process.env.DATABASE_URL ?? 'postgresql://cangunal@localhost:5432/fitpass'
const adapter = new PrismaPg({ connectionString })
const prisma = new PrismaClient({ adapter })

// PRODUCTION'IN BIREBIR KOPYASI. 2026-07-30 prod yedeginden (data/SportCategory.csv) alindi.
//
// Neden birebir: kodda 6 yerde kategori ISIMLE aranıyor (venueController 130/352/401/582,
// instructorPortalController 82). Seed farkli isimler uretirse CI ve yerel gelistirme, prod'da
// BULUNMAYAN kategorilerle test eder; o yollarin gercek veriyle davranisi hic denenmemis olur.
// Olculdu (prod yedegi vs yerel): ayni ID'ler farkli sporlara denk geliyordu —
//   id 3 prod "Dövüş Sporları" / seed "Boks",  id 4 prod "Fitness" / seed "HIIT",
//   id 11 prod "Binicilik" / seed "Diğer",  Crossfit+Diğer prod'da yok, Deniz Sporları seed'de yoktu.
//
// Bu listeyi degistirecegin zaman: DOGRU KAYNAK PROD'DUR. Once prod'daki gercek satirlara bak
// (yedekteki data/SportCategory.csv ya da admin paneli), sonra burayi ona gore hizala.
// "Deniz Sporları" prod'da iconUrl'suz duruyor — kasitli: web/mobil ikonu isimden cozuyor
// (sportIcons.tsx getIconKeyForCategory: 'deniz' -> sailing), bu yuzden null bırakıldı.
const sports = [
  { name: 'Yoga', iconUrl: 'yoga', colorHex: '#d76792', hasInstructor: true },
  { name: 'Pilates', iconUrl: 'pilates', colorHex: '#e2b67d', hasInstructor: true },
  { name: 'Dövüş Sporları', iconUrl: 'boxing', colorHex: '#DC2626', hasInstructor: true },
  { name: 'Fitness', iconUrl: 'hiit', colorHex: '#EA580C', hasInstructor: true },
  { name: 'Dans', iconUrl: 'dance', colorHex: '#C026D3', hasInstructor: true },
  { name: 'Yüzme', iconUrl: 'swimming', colorHex: '#0284C7', hasInstructor: true },
  { name: 'Binicilik', iconUrl: 'equestrian', colorHex: '#92400E', hasInstructor: true },
  { name: 'Deniz Sporları', iconUrl: null, colorHex: '#00c7fc', hasInstructor: true },
  { name: 'Tenis', iconUrl: 'padel', colorHex: '#65A30D', hasInstructor: true },
]

const districts = [
  { name: 'Adalar', lat: 40.8731, lng: 29.1216 },
  { name: 'Arnavutköy', lat: 41.1833, lng: 28.7333 },
  { name: 'Ataşehir', lat: 40.9923, lng: 29.1244 },
  { name: 'Avcılar', lat: 40.9797, lng: 28.7217 },
  { name: 'Bağcılar', lat: 41.0397, lng: 28.8564 },
  { name: 'Bahçelievler', lat: 40.9997, lng: 28.8564 },
  { name: 'Bakırköy', lat: 40.9817, lng: 28.8719 },
  { name: 'Başakşehir', lat: 41.0931, lng: 28.8019 },
  { name: 'Bayrampaşa', lat: 41.0447, lng: 28.9119 },
  { name: 'Beşiktaş', lat: 41.0422, lng: 29.0097 },
  { name: 'Beykoz', lat: 41.1281, lng: 29.1033 },
  { name: 'Beylikdüzü', lat: 40.9806, lng: 28.6431 },
  { name: 'Beyoğlu', lat: 41.0369, lng: 28.9772 },
  { name: 'Büyükçekmece', lat: 41.0217, lng: 28.5819 },
  { name: 'Çatalca', lat: 41.1433, lng: 28.4619 },
  { name: 'Çekmeköy', lat: 41.0397, lng: 29.1819 },
  { name: 'Esenler', lat: 41.0397, lng: 28.8764 },
  { name: 'Esenyurt', lat: 41.0281, lng: 28.6719 },
  { name: 'Eyüpsultan', lat: 41.0581, lng: 28.9319 },
  { name: 'Fatih', lat: 41.0186, lng: 28.9397 },
  { name: 'Gaziosmanpaşa', lat: 41.0647, lng: 28.9119 },
  { name: 'Güngören', lat: 41.0197, lng: 28.8764 },
  { name: 'Kadıköy', lat: 40.9908, lng: 29.0231 },
  { name: 'Kağıthane', lat: 41.0786, lng: 28.9719 },
  { name: 'Kartal', lat: 40.9131, lng: 29.1819 },
  { name: 'Küçükçekmece', lat: 41.0031, lng: 28.7764 },
  { name: 'Maltepe', lat: 40.9347, lng: 29.1319 },
  { name: 'Pendik', lat: 40.8781, lng: 29.2319 },
  { name: 'Sancaktepe', lat: 41.0031, lng: 29.2219 },
  { name: 'Sarıyer', lat: 41.1669, lng: 29.0519 },
  { name: 'Silivri', lat: 41.0731, lng: 28.2464 },
  { name: 'Sultanbeyli', lat: 40.9631, lng: 29.2619 },
  { name: 'Sultangazi', lat: 41.1081, lng: 28.8719 },
  { name: 'Şile', lat: 41.1781, lng: 29.6119 },
  { name: 'Şişli', lat: 41.0603, lng: 28.9872 },
  { name: 'Tuzla', lat: 40.8181, lng: 29.2964 },
  { name: 'Ümraniye', lat: 41.0197, lng: 29.1219 },
  { name: 'Üsküdar', lat: 41.0231, lng: 29.0150 },
  { name: 'Zeytinburnu', lat: 40.9981, lng: 28.9019 },
]

async function main() {
  // createMany({ skipDuplicates: true }) KULLANMIYORUZ. skipDuplicates yalnizca bir UNIQUE kisit
  // varsa is gorur; SportCategory.name'de sema seviyesinde unique YOK. Tekillik ancak sunucu
  // acilirken ensureIndexes.ts'in kurdugu sportcategory_name_lower_unique ile geliyor — yani
  // seed'in kostugu anda (CI'da: db push -> seed -> test) o indeks HENUZ YOK. Bu yuzden eski hali
  // her kosuda kategorileri COGALTIYORDU (canlida 26'ya kadar cikmis, elle birlestirildi).
  // Isim bazli (buyuk/kucuk harf duyarsiz) kontrol bu tuzagi indeksten bagimsiz kapatir.
  let olusturulan = 0
  for (const s of sports) {
    const mevcut = await prisma.sportCategory.findFirst({
      where: { name: { equals: s.name, mode: 'insensitive' } },
      select: { id: true },
    })
    // MEVCUT OLANA DOKUNMUYORUZ: renk/ikon admin panelinden degistirilebiliyor, seed onu ezmemeli.
    if (!mevcut) {
      await prisma.sportCategory.create({ data: s })
      olusturulan++
    }
  }
  console.log(`Sport categories seeded (${olusturulan} yeni, ${sports.length - olusturulan} zaten vardi).`)

  // İstanbul şehri
  const istanbul = await prisma.city.upsert({
    where: { id: 1 },
    update: { name: 'İstanbul' },
    create: { name: 'İstanbul' },
  })
  console.log('Istanbul city upserted.')

  for (const d of districts) {
    const exists = await prisma.neighborhood.findFirst({ where: { name: d.name, cityId: istanbul.id } })
    if (!exists) {
      await prisma.neighborhood.create({ data: { name: d.name, latitude: d.lat, longitude: d.lng, cityId: istanbul.id } })
    }
  }
  console.log('Istanbul districts seeded.')
}

main().catch(console.error).finally(() => prisma.$disconnect())
