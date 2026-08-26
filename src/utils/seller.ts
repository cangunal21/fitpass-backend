import type { Prisma } from '@prisma/client'

/**
 * SATICI KAPISI — TEK KAYNAK.
 *
 * Bir dersin yayında görünmesi ve satılabilmesi artık İKİ AYRI kaynaktan gelebiliyor:
 *
 *   • salona bağlı ders   (`venueId != null`) → kapı SALONUN durumudur   (isApproved && isActive)
 *   • mekânsız hoca dersi (`venueId == null`) → kapı EĞİTMENİN durumudur (isApproved && isActive)
 *
 * Bu iki dalı kırk küsur çağrı yerinde ayrı ayrı yazmak, denetimlerin en sık bulduğu kök nedeni
 * davet etmek olurdu ("KALIP B — tek örneği düzelt, sınıfı kapatma"): bir uçta kapı güncellenir,
 * kardeş uçta unutulur ve askıya alınmış bir satıcı tek bir yoldan görünmeye devam eder.
 * Yeni bir ders/seans okuyan uç yazarken kapıyı ELLE yazma, buradan geç.
 *
 * `isSuspended` de kontrol ediliyor: adminController askıya alırken `isActive`+`isSuspended`
 * ikisini birlikte yazıyor, yani bugün fazlalık — ama biri elle değiştirilirse kapı kapalı kalır.
 */

/** Yayında sayılan SALON. */
export const VENUE_LIVE = {
  isApproved: true,
  isActive: true,
  isSuspended: false,
} satisfies Prisma.VenueWhereInput

/** Yayında sayılan MEKÂNSIZ EĞİTMEN. (Salona bağlı eğitmende bu alanlar okunmaz — kapı salondur.) */
export const INSTRUCTOR_LIVE = {
  isApproved: true,
  isActive: true,
} satisfies Prisma.InstructorWhereInput

/**
 * `Class` üzerine uygulanacak where parçası. Salonlu ve mekânsız dersleri BİRLİKTE kapsar.
 *
 * DİKKAT: Bunu başka bir `OR` ile aynı nesnede birleştirme — ikinci `OR` birincisini ezer.
 * Böyle bir durumda `AND: [classLiveWhere(), { OR: [...] }]` yaz.
 */
export const classLiveWhere = (): Prisma.ClassWhereInput => ({
  OR: [
    { venue: { is: VENUE_LIVE } },
    { venueId: null, instructor: { is: INSTRUCTOR_LIVE } },
  ],
})

/** `Class_Session` sorgularında kullanılacak hâli. */
export const sessionLiveWhere = (): Prisma.Class_SessionWhereInput => ({
  class: classLiveWhere(),
})

/**
 * Tekil kayıt çekildikten SONRA yapılan kontroller için gereken alanlar.
 * Sorguya bunu `select`/`include` olarak koy ki `sellerBlocked` eksik veriyle çalışmasın.
 */
export const SELLER_SELECT = {
  venueId: true,
  venue: { select: { isApproved: true, isActive: true, isSuspended: true } },
  instructor: { select: { isApproved: true, isActive: true } },
} as const

export type SellerGateInput = {
  venueId: number | null
  venue?: { isApproved: boolean; isActive: boolean; isSuspended?: boolean } | null
  instructor?: { isApproved: boolean; isActive: boolean } | null
}

/**
 * Ders satılabilir/görünür mü? Engelliyse KULLANICIYA GÖSTERİLECEK mesajı döner, değilse `null`.
 *
 * Mesaj bilerek satıcı türünü ele vermiyor ("salonunuz askıda" vs "hocanız askıda" ayrımı
 * numaralandırma sinyali verirdi); çağıran uç isterse kendi bağlamına göre değiştirir.
 */
export function sellerBlocked(cls: SellerGateInput | null | undefined): string | null {
  if (!cls) return 'Ders bulunamadı.'

  if (cls.venueId != null) {
    const v = cls.venue
    if (!v || !v.isApproved || !v.isActive || v.isSuspended === true) {
      return 'Bu ders şu anda rezervasyona kapalı.'
    }
    return null
  }

  // Mekânsız hoca dersi. `instructor` HİÇ seçilmemişse (undefined) kapıyı açık sayamayız —
  // "veri yok" ile "veri uygun" aynı şey değildir; denetimlerin "yeşil kapı yanlış şeyi ölçüyor"
  // kalıbı tam olarak buydu. Fail-closed.
  const i = cls.instructor
  if (!i || !i.isApproved || !i.isActive) {
    return 'Bu ders şu anda rezervasyona kapalı.'
  }
  return null
}

/**
 * EĞİTMENİN kendi görünürlük kapısı (profil sayfası, yorumları, ders programı).
 * Salona bağlıysa kapı SALONDUR; mekânsızsa kapı KENDİ onayıdır.
 */
export const instructorLiveWhere = (): Prisma.InstructorWhereInput => ({
  isActive: true,
  OR: [{ venue: { is: VENUE_LIVE } }, { venueId: null, isApproved: true }],
})

export type InstructorGateInput = {
  venueId: number | null
  isActive: boolean
  isApproved: boolean
  venue?: { isApproved: boolean; isActive: boolean; isSuspended?: boolean } | null
}

/** Eğitmen public'te görünmemeli mi? `true` = gizle (404). */
export function instructorBlocked(i: InstructorGateInput | null | undefined): boolean {
  if (!i || i.isActive === false) return true
  if (i.venueId != null) {
    const v = i.venue
    return !v || !v.isApproved || !v.isActive || v.isSuspended === true
  }
  return !i.isApproved
}

/**
 * Ders kartındaki SATICI alanları. Salonlu derste salondan, mekânsız hoca dersinde eğitmenden
 * türetilir. Üç ayrı uç (sessions / for-you / session detay) bu alanları elle kurduğu için
 * kural üç kez kopyalanacaktı — "kopya-kural sürüklenmesi" denetimde yakalanan gerçek hata
 * sınıfı, bu yüzden tek fonksiyondan geçiyor.
 *
 * Mekânsız derste puan EĞİTMENİN puanıdır: kartta bir yıldız gösterilecekse, o dersi veren
 * kişinin puanı gösterilmeli — salon puanı diye 0 basmak yanlış bilgi olurdu.
 */
export type SellerCardInput = {
  venueId: number | null
  venue?: {
    name: string
    address: string | null
    avgRating: number
    totalReviews: number
    neighborhoodId: number | null
    neighborhood?: { name: string; latitude?: number | null; longitude?: number | null } | null
  } | null
  instructor?: { avgRating: number; totalReviews: number } | null
}

export type SellerCardFields = {
  venueId: number | null
  venueName: string | null
  venueAddress: string | null
  neighborhood: string | null
  neighborhoodId: number | null
  neighborhoodLat: number | null
  neighborhoodLng: number | null
  rating: number
  totalReviews: number
}

export function sellerCardFields(cls: SellerCardInput): SellerCardFields {
  const vid = cls.venueId
  const v = cls.venue
  if (vid != null && v) {
    return {
      venueId: vid,
      venueName: v.name,
      venueAddress: v.address ?? null,
      neighborhood: v.neighborhood?.name ?? null,
      neighborhoodId: v.neighborhoodId ?? null,
      neighborhoodLat: v.neighborhood?.latitude ?? null,
      neighborhoodLng: v.neighborhood?.longitude ?? null,
      rating: v.avgRating,
      totalReviews: v.totalReviews,
    }
  }
  return {
    venueId: null,
    venueName: null,
    venueAddress: null,
    neighborhood: null,
    neighborhoodId: null,
    neighborhoodLat: null,
    neighborhoodLng: null,
    rating: cls.instructor?.avgRating ?? 0,
    totalReviews: cls.instructor?.totalReviews ?? 0,
  }
}

/** Teslim biçimi filtresi. `mode` verilmezse filtre uygulanmaz (ikisi de gelir). */
export const deliveryWhere = (mode?: string | null): Prisma.ClassWhereInput =>
  mode === 'online' ? { deliveryMode: 'online' } : mode === 'in_person' ? { deliveryMode: 'in_person' } : {}

/** İstemciden gelen ham mod parametresini kanonikleştirir. Tanımadığını YOK SAYAR (filtre yok). */
export function parseDeliveryMode(raw: unknown): 'online' | 'in_person' | null {
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (v === 'online') return 'online'
  if (v === 'in_person' || v === 'inperson' || v === 'yuz_yuze') return 'in_person'
  return null
}

/**
 * ONLINE DERS SEZON LİDERLİĞİNE SAYILMAZ (ürün kararı — puan/tier/seri'ye SAYAR).
 * Liderlik ve şampiyon işi bu parçayı kullanır; kural tek yerde dursun diye burada.
 */
export const IN_PERSON_ONLY: Prisma.ClassWhereInput = { deliveryMode: 'in_person' }

/**
 * SATICI İLETİŞİMİ — dersi kim satıyorsa onun e-postası ve görünen adı.
 *
 * NEDEN AYRI FONKSİYON: "satıcı kim" ayrımı (venueId dolu mu?) bildirim kodunda İKİ AYRI YERDE
 * elle yazılmıştı ve ikisi de yalnız salonu biliyordu. Mekânsız hocanın dersinde venueId NULL
 * olduğu için her iki yerde de satıcıya hiçbir bildirim gitmiyordu: hoca dersinin satıldığını da
 * iptal edildiğini de öğrenemiyordu. Tanım tek yerde durursa üçüncü bir çağrı yeri eklendiğinde
 * aynı hata tekrar edilemez.
 *
 * Salon'da alan adı `name`, Eğitmen'de `fullName` — çağıran taraf bu farkı bilmek zorunda kalmasın.
 */
export type SaticiIletisim = { email: string; name: string } | null

export function saticiIletisimSec(
  venue: { email?: string | null; name?: string | null } | null | undefined,
  instructor: { email?: string | null; fullName?: string | null } | null | undefined,
): SaticiIletisim {
  // Salon varsa satıcı salondur; mekânsız derste satıcı eğitmenin kendisidir.
  if (venue?.email) return { email: venue.email, name: venue.name || '' }
  if (instructor?.email) return { email: instructor.email, name: instructor.fullName || '' }
  return null
}
