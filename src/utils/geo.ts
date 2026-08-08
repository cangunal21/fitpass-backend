import prisma from './prisma'

// Bir mahallenin bağlı olduğu şehri döndürür (yoksa null).
//
// NEDEN VAR: kod tabanında `cityId` üç yerde SABİT 1 (İstanbul) yazılıyordu. Bu, platform yalnız
// İstanbul'dayken zararsızdı — ama veritabanında ZATEN 5 şehir var (İstanbul, Ankara, Bursa, İzmir,
// Muğla) ve Neighborhood kendi cityId'sini taşıyor. Yani ilçe seçici başka bir şehri gösterdiği anda
// kullanıcı/salon "Ankara mahallesi + İstanbul şehri" gibi TUTARSIZ bir satıra yazılır ve canlıdaki
// `?cityId=` filtresi onları sessizce yanlış şehirde listeler (fark edilmesi zor veri bozulması).
// Doğru değer tahmin edilmez, mahalleden TÜRETİLİR.
export async function cityIdOfNeighborhood(neighborhoodId: number | null | undefined): Promise<number | null> {
  if (!neighborhoodId) return null
  const n = await prisma.neighborhood.findUnique({ where: { id: neighborhoodId }, select: { cityId: true } })
  return n?.cityId ?? null
}
