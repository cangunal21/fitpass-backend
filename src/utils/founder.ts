import prisma from './prisma'
import { cached } from './cache'
import type { Prisma } from '@prisma/client'

/**
 * ÖNCÜ SALON (O13) — salon sunumunda 8 salona YAZILI olarak verilen sözün kod karşılığı:
 *
 *   "İlk 50 salona özel · Platform 200 salona ulaşana dek 'İlk 50 · Öncü Salon' rozetiyle
 *    uygulamada öne çıkarılırsınız."
 *
 * İki ayrı sayı, iki ayrı anlam — karıştırılırsa söz bozulur:
 *   • 50  → ROZETİ kimin alacağı. Kalıcıdır: 47. salon her zaman 47. salondur.
 *   • 200 → ÖNE ÇIKARMANIN ne zaman biteceği. Geçicidir ve platform büyüdükçe kendiliğinden söner.
 *
 * BİTİŞ KOŞULU KODA GÖMÜLÜ olmak zorunda. Süresiz bir ayrıcalık vaat edilmedi; sayaç kodda
 * durmazsa söz belirsizleşir ve iki yıl sonra "siz öne çıkarma sözü vermiştiniz" tartışması çıkar.
 */
export const FOUNDER_BADGE_LIMIT = 50
export const FOUNDER_BOOST_UNTIL = 200

/** Rozeti hak ediyor mu? Sıra numarası olmayan (henüz onaylanmamış) salon hak etmez. */
export const isFounder = (rank: number | null | undefined): boolean =>
  typeof rank === 'number' && rank >= 1 && rank <= FOUNDER_BADGE_LIMIT

/**
 * Öne çıkarma hâlâ yürürlükte mi? Onaylı salon sayısı 200'e ulaşınca kendiliğinden kapanır.
 *
 * 5 dk önbellek: bu değer her salon listesi isteğinde okunuyor ve saniyede değişecek bir şey
 * değil. Önbelleksiz her istekte bir COUNT demek olurdu.
 */
export const founderBoostActive = async (): Promise<boolean> => {
  const n = (await cached('approved-venue-count', 300000, () =>
    prisma.venue.count({ where: { isApproved: true } }),
  )) as number
  return n < FOUNDER_BOOST_UNTIL
}

/**
 * Salona öncü sırasını VER. Yalnızca ilk onayda çalışır; zaten sırası olan salona dokunmaz
 * (askıya alınıp yeniden onaylanan salon sırasını KAYBETMEMELİ — sıra bir kere kazanılır).
 *
 * EŞZAMANLILIK: "MAX+1 oku, yaz" iki eşzamanlı onayda aynı numarayı üretebilir. Bu kod tabanında
 * "kodla sağlanan tekillik eşzamanlılıkta işe yaramaz" dersi zaten ödendi (Class_Session, Report),
 * bu yüzden tekillik DB'de bir unique index olarak duruyor ve burada çakışmada TEKRAR DENİYORUZ.
 * Tekrar sayısı küçük: onay bir admin eylemi, saniyede yüzlerce olmuyor.
 */
export async function assignFounderRank(venueId: number): Promise<number | null> {
  const mevcut = await prisma.venue.findUnique({ where: { id: venueId }, select: { founderRank: true } })
  if (!mevcut) return null
  if (mevcut.founderRank != null) return mevcut.founderRank // sıra bir kere verilir

  for (let deneme = 0; deneme < 5; deneme++) {
    const enBuyuk = await prisma.venue.aggregate({ _max: { founderRank: true } })
    const sonraki = (enBuyuk._max.founderRank ?? 0) + 1
    try {
      // WHERE founderRank: null → araya giren başka bir onay bu salona sıra verdiyse
      // count=0 döner ve mevcut sırayı EZMEYİZ.
      const r = await prisma.venue.updateMany({
        where: { id: venueId, founderRank: null },
        data: { founderRank: sonraki },
      })
      if (r.count === 0) {
        const tekrar = await prisma.venue.findUnique({ where: { id: venueId }, select: { founderRank: true } })
        return tekrar?.founderRank ?? null
      }
      return sonraki
    } catch (e: any) {
      // P2002 = unique ihlali: başka bir salon aynı anda bu numarayı aldı → yeniden hesapla.
      if (e?.code !== 'P2002') throw e
    }
  }
  // Beş denemede alınamadıysa SESSİZ KALMA: rozet sözü verilmiş bir salon sırasız kalıyor demektir.
  console.error(`assignFounderRank: ${venueId} için sıra verilemedi (5 deneme)`)
  return null
}

/**
 * Salon listesi sıralamasına öncü ağırlığı. Öne çıkarma kapandıysa BOŞ dizi döner ve
 * sıralama olduğu gibi kalır.
 *
 * DİKKAT: bu bir VİTRİN kuralıdır, kalite sıralaması DEĞİL. `getVenueLeaderboard`'un Wilson alt
 * sınırıyla karıştırma — o "hangi salon daha iyi" sorusunu cevaplıyor, bu "kime söz verdik".
 */
export const founderOrderBy = (aktif: boolean): Prisma.VenueOrderByWithRelationInput[] =>
  aktif ? [{ founderRank: { sort: 'asc', nulls: 'last' } }] : []
