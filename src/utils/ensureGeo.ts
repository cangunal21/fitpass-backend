import prisma from './prisma'

// İstanbul (39 ilçe) zaten seed'li. Bu fonksiyon 4 yeni ili + TÜM resmi ilçelerini
// idempotent ekler (her açılışta çalışır, eksikleri tamamlar, çift kayıt oluşturmaz).
// İlçe koordinatı = il merkezi (filtre için yeterli; nearby sıralaması yaklaşık olur).
// İlçe listeleri resmî ve eksiksiz, alfabetik sırada.
const CITIES: { name: string; lat: number; lng: number; districts: string[] }[] = [
  {
    name: 'Ankara', lat: 39.9334, lng: 32.8597,
    districts: [
      'Akyurt', 'Altındağ', 'Ayaş', 'Bala', 'Beypazarı', 'Çamlıdere', 'Çankaya', 'Çubuk',
      'Elmadağ', 'Etimesgut', 'Evren', 'Gölbaşı', 'Güdül', 'Haymana', 'Kahramankazan',
      'Kalecik', 'Keçiören', 'Kızılcahamam', 'Mamak', 'Nallıhan', 'Polatlı', 'Pursaklar',
      'Sincan', 'Şereflikoçhisar', 'Yenimahalle',
    ],
  },
  {
    name: 'Bursa', lat: 40.1826, lng: 29.0665,
    districts: [
      'Büyükorhan', 'Gemlik', 'Gürsu', 'Harmancık', 'İnegöl', 'İznik', 'Karacabey', 'Keles',
      'Kestel', 'Mudanya', 'Mustafakemalpaşa', 'Nilüfer', 'Orhaneli', 'Orhangazi', 'Osmangazi',
      'Yenişehir', 'Yıldırım',
    ],
  },
  {
    name: 'İzmir', lat: 38.4237, lng: 27.1428,
    districts: [
      'Aliağa', 'Balçova', 'Bayındır', 'Bayraklı', 'Bergama', 'Beydağ', 'Bornova', 'Buca',
      'Çeşme', 'Çiğli', 'Dikili', 'Foça', 'Gaziemir', 'Güzelbahçe', 'Karabağlar', 'Karaburun',
      'Karşıyaka', 'Kemalpaşa', 'Kınık', 'Kiraz', 'Konak', 'Menderes', 'Menemen', 'Narlıdere',
      'Ödemiş', 'Seferihisar', 'Selçuk', 'Tire', 'Torbalı', 'Urla',
    ],
  },
  {
    name: 'Muğla', lat: 37.2153, lng: 28.3636,
    districts: [
      'Bodrum', 'Dalaman', 'Datça', 'Fethiye', 'Kavaklıdere', 'Köyceğiz', 'Marmaris', 'Menteşe',
      'Milas', 'Ortaca', 'Seydikemer', 'Ula', 'Yatağan',
    ],
  },
]

// Açılışta çağrılır. Hata olursa loglar ama sunucuyu düşürmez (boot güvenli).
export async function ensureGeo(): Promise<void> {
  try {
    for (const c of CITIES) {
      let city = await prisma.city.findFirst({ where: { name: c.name } })
      if (!city) city = await prisma.city.create({ data: { name: c.name } })
      const existing = await prisma.neighborhood.findMany({ where: { cityId: city.id }, select: { name: true } })
      const have = new Set(existing.map(n => n.name))
      const toAdd = c.districts.filter(d => !have.has(d))
      if (toAdd.length) {
        await prisma.neighborhood.createMany({
          data: toAdd.map(name => ({ name, cityId: city!.id, latitude: c.lat, longitude: c.lng })),
        })
      }
    }
  } catch (err) {
    console.error('ensureGeo error:', err)
  }
}
