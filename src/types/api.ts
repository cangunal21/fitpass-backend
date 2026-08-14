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
 * ============================================================================================
 */

// Bu satır dosyanın geri kalanının SHA-256 ön ekidir. Sözleşmeyi değiştirdiysen:
//   1) diğer İKİ repodaki kopyayı da güncelle,  2) üç kopyada da damgayı yenile
//   (`node scripts/tip-damgasi.cjs` doğrusunu yazar).
export const TIP_SOZLESMESI_SURUMU = '0f830c51b03fc'

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
