/*
 * API SÖZLEŞMESİ — BACKEND, WEB VE MOBİLDE BİREBİR AYNI DOSYA
 * ============================================================================================
 * Bu dosya üç repoda da AYNI olmalıdır. `scripts/tip-damgasi.cjs` bunu zorlar: dosya değişip
 * damga güncellenmezse CI kırılır (bkz. TIP_SOZLESMESI_SURUMU).
 *
 * NEDEN VAR: üç denetimin (10/12/13 Ağustos) ortak kökü tek bir şeydi — sunucu ile istemciler
 * arasındaki sözleşme HİÇBİR YERDE YAZILI DEĞİLDİ. İki taraf da `any` konuşuyordu, uyuşmazlık
 * tsc'den geçiyor, kullanıcı ekranı açtığında ortaya çıkıyordu. Bedeli ödenmiş örnekler:
 *
 *   • `availableSpots` TOPLAM KAPASİTE dönüyordu, ÜÇ istemci de "kalan yer" sanıyordu →
 *     dolu ders "10 yer kaldı" diye gösteriliyordu.
 *   • Favoriler `{ venue: {...} }` sarmalayıcısıyla dönüyordu, bir istemci düz salon bekliyordu.
 *   • `finalAmount` sunucudan kaldırıldı, istemci okumaya devam etti → ekranda `undefined`.
 *   • Rezervasyon yanıtında hoca adı yoktu; web'in puanlama modalı hoca bölümünü hiç açamadı.
 *   • Salon detayında `classes` gönderiliyordu, mobil hiç çizmiyordu (keşif akışı çıkmaz sokak).
 *
 * Hepsi aynı sınıf: ALAN ADI/ANLAMI DEĞİŞTİ, DERLEYİCİ GÖRMEDİ.
 *
 * ── KATILIK MODELİ (bilinçli seçim) ─────────────────────────────────────────────────────────
 * Sözleşme "EN AZ bu alanlar, bu tiplerle" demektir; fazlası serbesttir. Sebebi TypeScript'in
 * fazla-alan denetiminin yalnız TAZE NESNE SABİTİNE uygulanmasıdır: `res.json({ sessions: liste })`
 * içinde `liste` bir DEĞİŞKEN olduğu için elemanlarındaki fazla alanlar hata vermez.
 * Sonuç tam istediğimiz kapı:
 *     alan SİLİNİRSE   → build kırılır   (istemcilerin okuduğu alan yok oldu)
 *     alan TİP DEĞİŞTİRİRSE → build kırılır   (string iken number oldu)
 *     alan EKLENİRSE   → serbest        (geriye dönük uyumlu, kimseyi bozmaz)
 *
 * ── `any` UYARISI ───────────────────────────────────────────────────────────────────────────
 * Bu tipler üreticiyi YALNIZ `any`'nin bittiği yerde denetler. Bir controller yanıtı
 * `const safe: any = ...` ile kuruyorsa tsc hiçbir şey göremez (any her şeye atanabilir).
 * O uçlar için `scripts/smoke.ts` içinde ÇALIŞMA ZAMANI uygunluk testi var — hangi uçların
 * derleyiciyle, hangilerinin testle korunduğu aşağıda her tipin başında yazılıdır.
 *
 * ── BU KATMANIN GÖREMEDİĞİ ŞEY (ölçüldü, varsayılmadı) ──────────────────────────────────────
 * Sözleşme "alan VAR MI ve TİPİ doğru mu" der; "DEĞERİ doğru mu" DEMEZ. Somut örnek:
 *
 *   `getVenueById` içinde `classes[].instructor` yayılımla (`...c`) ham Prisma satırından
 *   geliyor ve `stripInstructorSensitive` ile temizleniyor. O temizlik SİLİNSE bile alan
 *   yerinde kalır ve tipe UYAR — çünkü ham satırda da `id` ve `fullName` vardır. Yani
 *   hocanın passwordHash/e-posta/telefonu public'e sızar ve **tsc bunu göremez.**
 *
 *   Bu sınama yapıldı: temizlik kaldırıldı → tsc TEMİZ geçti, smoke KIRILDI
 *   ("venue.classes[].instructor sızdırıyor"). Yani güvenlik özelliğini koruyan şey tip değil,
 *   `scripts/smoke.ts` içindeki gizlilik testleridir. **O testleri silmeyin.**
 *
 * Kural: hassas alan temizliği = TEST işi. Alan adı/şekli sözleşmesi = TİP işi. İkisi
 * birbirinin yerine geçmez.
 * ============================================================================================
 */

// Bu satır dosyanın geri kalanının SHA-256 ön ekidir. Sözleşmeyi değiştirdiysen:
//   1) diğer İKİ repodaki kopyayı da güncelle,  2) üç kopyada da damgayı yenile
//   (`node scripts/tip-damgasi.cjs` doğrusunu yazar).
export const TIP_SOZLESMESI_SURUMU = '2112ddf925aca'

// ── ORTAK ───────────────────────────────────────────────────────────────────────────────────

/** Tüm hata yanıtlarının ortak gövdesi. `code` makine-okunur ayrım için (ör. EMAIL_NOT_VERIFIED). */
export interface ApiError {
  error: string
  code?: string
}

/**
 * Sayfalı liste yanıtlarının ortak alanları.
 * `hasMore` KESİLME SİNYALİdir: katalog limiti aşınca istemci sessizce eksik liste
 * gösteriyordu, sinyal yoktu.
 */
export interface Pagination {
  total?: number
  page?: number
  pageSize?: number
  hasMore: boolean
  limit?: number
}

/**
 * İSTEMCİ TARAFI SARMALAYICI — sunucu tipini doğrudan kullanma, bunu kullan.
 *
 * `request()` ağ hatası/zaman aşımı durumunda gövdeyi okuyamaz ve `{ error }` döndürür;
 * veri alanları O ZAMAN GELMEZ. Yanıtı düz `SessionListResponse` diye tiplemek bu hâli
 * gizler ve `data.sessions.map(...)` üretimde çöker (kullanıcı uçağa binip ağı kaybettiğinde
 * beyaz ekran). `Partial` sığdır: üst düzey alanı korumak ZORUNDASIN, ama koruduktan sonra
 * elemanlar tam tipli gelir.
 */
export type ApiResult<T> = Partial<T> & Partial<ApiError>

// ── SEANS ───────────────────────────────────────────────────────────────────────────────────

/**
 * Bir seansın listede görünen hâli. **Üretici derleyiciyle denetleniyor**
 * (`publicController.getSessions` — elle kurulan nesne sabiti).
 */
export interface SessionSummary {
  id: number
  title: string
  /** İngilizce başlık; çeviri işi henüz doldurmadıysa `null`. İstemci `title`'a düşer. */
  titleEn: string | null
  venueId: number
  venueName: string
  venueAddress: string | null
  instructorId: number | null
  /** Hoca adı — yoksa `null`. Rezervasyon ve puanlama akışları buna bakar. */
  instructorName: string | null
  /** Spor dalı adı; kategori atanmamışsa boş dizge (asla `null` değil). */
  category: string
  categoryColor: string | null
  /** ISO 8601, UTC. İstemci İstanbul saatine `trTime` ile çevirir — ham `toLocale*` KULLANMA. */
  startsAt: string
  durationMinutes: number
  basePrice: number

  /**
   * KALAN YER — sunucuda hesaplanır (kapasite − doluluk). Gösterilecek sayı BUDUR.
   * `Class_Session.capacity` rezervasyonla azalmaz; istemci kendi çıkarma işlemini YAPMAMALI.
   */
  spotsLeft: number

  /**
   * @deprecated `spotsLeft` kullan. Eskiden TOPLAM KAPASİTE dönüyordu ve üç istemci de bunu
   * "kalan yer" sanıyordu — dolu ders "10 yer kaldı" diye gösteriliyordu. Artık `spotsLeft`
   * ile aynı değeri taşıyor; istemcilerin tamamı geçtikten sonra kaldırılacak.
   */
  availableSpots: number

  /** Seansın TOPLAM kapasitesi (ders varsayılanı değil — seans kapasitesi düzenlenebilir). */
  capacity: number

  neighborhood: string | null
  neighborhoodId: number | null

  /**
   * SÖZLEŞMEYE DAHİL DEĞİL — `nearby` sıralamasının sunucu içi iskelesi, yanıta yan ürün
   * olarak sızıyor. `/api/public/sessions` gönderir, `/api/public/for-you` GÖNDERMEZ
   * (o sorgu mahalleden yalnız id+name seçiyor). Bugün hiçbir istemci okumuyor; okuyacaksan
   * `undefined` ihtimalini ele almak ZORUNDASIN — bu yüzden isteğe bağlı.
   */
  neighborhoodLat?: number | null
  neighborhoodLng?: number | null

  rating: number
  totalReviews: number
}

/**
 * Seans detay sayfasının gövdesi. Listeye ek olarak açıklama, bitiş saati, durum ve
 * hoca profil alanlarını taşır. **Üretici derleyiciyle denetleniyor**
 * (`publicController.getSessionById`).
 */
export interface SessionDetail
  extends Omit<SessionSummary, 'neighborhoodId' | 'neighborhoodLat' | 'neighborhoodLng'> {
  description: string | null
  /** ISO 8601, UTC. */
  endsAt: string
  /** `'open' | 'cancelled' | ...` — sunucu serbest dizge tutuyor, istemci bilinmeyeni yok saymalı. */
  status: string
  instructorVerified: boolean
  instructorBio: string | null
  instructorAvatarUrl: string | null
}

export interface SessionListResponse extends Pagination {
  sessions: SessionSummary[]
  hasMore: boolean
}

export interface SessionDetailResponse {
  session: SessionDetail
}

/** `/api/public/for-you` — kişiselleştirilmiş seanslar; sayfalama YOK, sabit üst sınır. */
export interface ForYouResponse {
  sessions: SessionSummary[]
}

// ── YORUM / PUAN ────────────────────────────────────────────────────────────────────────────

/**
 * Salon yorumları + puan özeti. **Üretici derleyiciyle denetleniyor**
 * (`reviewController.getVenueReviews`).
 *
 * `avgRating` ve `totalReviews` TÜM yorumlardan (aggregate) hesaplanır; `reviews` listesi ise
 * `take: 50` ile SINIRLIDIR. Bu yüzden istemci özetini listeden hesaplamamalı — 80 yorumlu
 * salonda sapardı.
 */
export interface VenueReviewsResponse {
  reviews: unknown[]
  /** 0–5, tek ondalık. Hiç yorum yoksa 0. */
  avgRating: number
  totalReviews: number

  /**
   * Yıldız dağılımı — her yıldız için yorum SAYISI (yüzde değil). Yorum almamış yıldız da
   * 0 ile gelir, istemci eksik anahtar aramasın.
   *
   * NEDEN SUNUCUDAN: web'de bu dağılım SABİT KODLUYDU (5★ %75, 4★ %18, gerisi %5) ve
   * `avgRating` ne olursa olsun aynı çubuklar çiziliyordu — puanı 2.1 olan salon bile
   * "yorumların %75'i 5 yıldız" gösteriyordu. Kullanıcı rezervasyon kararını buna bakarak
   * verdiği için bu yalnız bir kusur değil, YANILTICI VERİYDİ.
   */
  ratingBreakdown: Record<'1' | '2' | '3' | '4' | '5', number>
}

// ── FAVORİLER ───────────────────────────────────────────────────────────────────────────────

/**
 * Favori salon listesi. **Üretici derleyiciyle denetleniyor**
 * (`favoriteController.getMyFavorites` / `getUserFavorites`).
 *
 * Yanıt DÜZ salon nesnesi taşır — `{ venue: {...} }` sarmalayıcısı YOKTUR. (Bir dönem sarmalıydı,
 * bir istemci düzünü bekliyordu; smoke bu davranışı ayrıca kilitliyor.)
 */
export interface FavoritesResponse {
  favorites: unknown[]

  /**
   * BAŞKASININ profiline bakılırken, o kullanıcı profilini/aktivitesini gizlemişse `true` gelir
   * ve `favorites` BOŞ döner. İstemci bunu okumazsa "gizli" ile "favorisi yok" aynı ekrana
   * düşer — web'de tam olarak bu oluyordu. Kendi profilinde bu alan hiç gelmez.
   */
  private?: boolean
}

// ── BEKLEME LİSTESİ ─────────────────────────────────────────────────────────────────────────

/**
 * Bir seans için kullanıcının bekleme listesi durumu. **Üretici derleyiciyle denetleniyor**
 * (`waitlistController.getWaitlistStatus`).
 */
export interface WaitlistStatusResponse {
  onWaitlist: boolean

  /**
   * Sıradaki GERÇEK yer (1 = en önde). Listede değilsen `null`.
   *
   * TUZAK: bir dönem burada TOPLAM sayı dönüyordu — 5 kişi varken 2. kişiye de "5" diyordu.
   * Artık "kendinden önce katılanlar + 1". `totalWaiting` ile KARIŞTIRMA.
   */
  position: number | null

  /** Listedeki toplam kişi sayısı — sıradaki yerin DEĞİL. */
  totalWaiting: number
}

/** Bekleme listesine katılma/çıkma yanıtı. */
export interface WaitlistActionResponse {
  /**
   * Sunucunun ürettiği bilgi metni. İSTEMCİ BUNU GÖSTERMEMELİ: sabit Türkçe, İngilizce
   * arayüzde de Türkçe çıkar. İstemciler kendi i18n metinlerini kullanır; bu alan yalnız
   * günlük/hata ayıklama içindir.
   */
  message?: string
  /** Katılma yanıtında oluşan kayıt (201). */
  entry?: unknown
}

// ── SALON ───────────────────────────────────────────────────────────────────────────────────

/**
 * Salonun public listede/kartlarda görünen hâli. **Üretici derleyiciyle denetleniyor**
 * (`publicController.getVenues`).
 *
 * DİKKAT — bu yanıt Prisma satırının YAYILMIŞ hâlidir: `stripVenueSensitive` yalnız hassas
 * kolonları siler, geri kalan HER kolon istemciye gider. Sözleşme "en az bu alanlar" der;
 * yeni bir kolon eklendiğinde otomatik olarak public'e çıkar. **Hassas bir kolon eklerken
 * `VENUE_SENSITIVE_FIELDS` listesine de eklemek ZORUNLUDUR** — 14 Ağustos'ta
 * `passwordChangedAt` ve `ownerUserId` tam bu yüzden kimlik doğrulamasız uçtan sızıyordu.
 */
export interface VenueSummary {
  id: number
  name: string
  address: string | null
  /** Kapak görseli — onaylanmamışsa `null`. Onay bekleyen görseller ayrı alanda ve public'e ÇIKMAZ. */
  coverImageUrl: string | null
  /** "Mavi tik" — salonun DOĞRULANMIŞ olması. `isApproved` ile KARIŞTIRMA: bu uç zaten yalnız
   *  onaylı salon döndürüyor, yani `isApproved` yanıtta HER ZAMAN true ve hiçbir salonu ayırt etmez. */
  isVerified: boolean
  /** 0–5. **0 "puan yok" demektir, "sıfır puan aldı" DEĞİL** — `totalReviews` ile birlikte oku. */
  avgRating: number
  totalReviews: number
  neighborhoodId: number | null
  cityId: number | null
  /** ISO 8601. Venue'de `updatedAt` YOKTUR — site haritası bu yüzden `createdAt` kullanır. */
  createdAt: string
}

export interface VenueListResponse extends Pagination {
  venues: VenueSummary[]
  hasMore: boolean
  limit?: number
}

/** Salon detayındaki bir dersin YAKLAŞAN seansı (yalnız `status: 'open'` ve gelecekte olanlar). */
export interface VenueClassSession {
  /**
   * SEANS id'si — ders id'si DEĞİL. Ders kartından rezervasyona giderken hedef BUDUR
   * (`/ders/[id]` ve mobil `ClassDetail` seans id'siyle çalışır). Ders id'sine yönlendirmek
   * "çalışıyor gibi" görünüp yanlış kaydı açar; web'de kart bir dönem HİÇ tıklanamıyordu.
   */
  id: number
  /** ISO 8601, UTC. */
  startsAt: string
  /** ISO 8601, UTC. Geçmiş/yaklaşan ayrımı ve check-in penceresi BUNA bakmalı, `startsAt`'e değil. */
  endsAt: string
  /** KALAN yer — sunucuda hesaplanır. Gösterilecek sayı budur. */
  spotsLeft: number
  /** @deprecated `spotsLeft` kullan. Bkz. SessionSummary.availableSpots. */
  availableSpots: number
  /** Seansın TOPLAM kapasitesi — rezervasyonla AZALMAZ. */
  capacity: number
}

/** Salon detayında listelenen bir ders (yalnız `isActive` olanlar). */
export interface VenueClass {
  /** DERS id'si — rezervasyon hedefi DEĞİL (bkz. VenueClassSession.id). */
  id: number
  title: string
  titleEn: string | null
  description: string | null
  durationMinutes: number
  basePrice: number

  /** Spor dalı. Atanmamışsa `null` — istemci kategori adından renk/ikon türetmeye düşer. */
  sportCategory: { name: string; colorHex: string | null; iconUrl: string | null } | null

  /**
   * Dersin hocası. Atanmamışsa `null`.
   *
   * PII TEMİZLENMİŞTİR: `stripInstructorSensitive` passwordHash/email/phone/userId/inviteStatus
   * alanlarını siler. Bu uç KİMLİK DOĞRULAMASIZ — iç içe eğitmen objeleri bir dönem TAM SATIR
   * taşıyordu ve hocanın e-postası/telefonu public'e sızıyordu.
   */
  instructor: { id: number; fullName: string } | null

  /** Yaklaşan seanslar, en yakından uzağa. Boş olabilir: dersin açık seansı yoksa. */
  sessions: VenueClassSession[]
}

/**
 * Salon detay sayfasının gövdesi. **Üretici derleyiciyle denetleniyor**
 * (`publicController.getVenueById`).
 *
 * Bu uç YALNIZ onaylı + aktif salon döndürür (donmuş/onaysız → 404). Yani `isApproved`
 * yanıtta HER ZAMAN true'dur ve hiçbir salonu ayırt etmez — rozet için `isVerified` kullan.
 */
export interface VenueDetail extends VenueSummary {
  description: string | null
  /** Onaydan geçmiş galeri görselleri. Onay bekleyenler AYRI alanda ve public'e ÇIKMAZ. */
  images: unknown
  classes: VenueClass[]
  instructors: unknown[]
}

export interface VenueDetailResponse {
  venue: VenueDetail
}

// ── REZERVASYONLAR ──────────────────────────────────────────────────────────────────────────

/**
 * Kullanıcının kendi rezervasyonu. **Üretici derleyiciyle denetleniyor**
 * (`bookingController.getMyBookings`).
 *
 * NE GELMEZ: komisyon kırılımı ve salonun net hak edişi (`commissionAmount`, `venueCommission`,
 * `userCommission`, `venuePayout`) BİLEREK ayıklanır — bunlar platformun iş modeli verisi,
 * müşteriyi ilgilendirmez. Bir dönem tamamı yanıtta dönüyordu.
 *
 * SESSİZ KESME: bu liste `take: 200` ile sınırlı (tüm ömür-boyu geçmiş derin include'la tek
 * yanıtta yüklenmesin diye). İstemci "tüm geçmiş" varsaymamalı.
 */
export interface BookingSummary {
  id: number
  status: string
  bookingType: string
  /** ISO 8601. Rezervasyonun OLUŞTURULMA anı — dersin tarihi DEĞİL. */
  createdAt: string

  /**
   * Ders rezervasyonuysa dolu, drop-in ise `null`. **İkisinden BİRİ doludur** — istemci
   * `session?.startsAt ?? dropInSlot?.startsAt` gibi yedekli okumalı. Web bir dönem yalnız
   * `session` dalını çiziyordu ve drop-in kayıtları başlıksız/tarihsiz görünüyordu.
   */
  session: unknown | null
  /** Drop-in rezervasyonuysa dolu, ders ise `null`. Bkz. `session`. */
  dropInSlot: unknown | null

  /** Salon yorumu (varsa). Geriye dönük uyum için tekil. */
  review: unknown | null
  /** Salon VEYA hoca puanı verilmiş mi. `review === null` iken bile true olabilir (yalnız hoca puanlanmışsa). */
  reviewed: boolean
}

export interface MyBookingsResponse {
  bookings: BookingSummary[]
}
