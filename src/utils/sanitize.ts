// Public/çapraz-realm yanıtlarda ASLA sızmaması gereken hassas alanların merkezî temizliği.
// Tek doğruluk kaynağı — hem publicController hem bookingController (ve gerekirse başkaları) buradan kullanır.
// Blacklist (whitelist yerine) çünkü include'lı sorgular çok sayıda ilişkili alan taşır; bu listeler TÜM
// hassas kolonları kapsar. Yeni hassas kolon eklenirse BURAYA eklenmeli.

// Venue: şifre + ödeme/KYC (IBAN, TCKN, vergi no, alt-üye anahtarı, kimlik belgeleri) + onay-öncesi görseller.
export const VENUE_SENSITIVE_FIELDS = [
  'passwordHash', 'email', 'pendingImages', 'pendingCoverImageUrl', 'imagesPendingReview',
  'iban', 'taxOffice', 'taxNumber', 'identityNumber', 'iyzicoSubMerchantKey',
  'subMerchantType', 'legalCompanyTitle', 'contactName', 'contactSurname', 'payoutGsm',
  'ibanMatchConsent', 'subMerchantStatus', 'subMerchantSubmittedAt', 'subMerchantApprovedAt',
  'subMerchantRejection', 'kycDocs',
] as const

// DÖNÜŞ TİPİ `Omit`, `Partial` DEĞİL: fonksiyon yalnızca listedeki kolonları siler, geri
// kalanları OLDUĞU GİBİ bırakır. `Partial<T>` demek "her alan kaybolmuş olabilir" demekti ve
// bu YALAN, üstelik zararlıydı: zorunlu alanlar isteğe bağlıya dönüşünce API sözleşmesi
// (src/types/api.ts) üretici tarafında DOĞRULANAMIYORDU — tsc "bu alan gelmeyebilir" sanıyordu.
export function stripVenueSensitive<T extends Record<string, any>>(
  venue: T,
): Omit<T, (typeof VENUE_SENSITIVE_FIELDS)[number]> {
  const v: any = { ...venue }
  for (const k of VENUE_SENSITIVE_FIELDS) delete v[k]
  return v
}

// Instructor: passwordHash (login credential) + email/phone (PII, login kimliği) + userId (bağlı hesap
// eşlemesi) + inviteStatus (hesap durumu). PUBLIC bağlamda hepsi gizli. NOT: salon sahibinin KENDİ
// hocalarını gördüğü uçlar (getVenueInstructors) email/phone/inviteStatus'ü bilerek gösterir; bu strip
// yalnız public/çapraz-realm gösterim içindir.
export const INSTRUCTOR_SENSITIVE_FIELDS = [
  'passwordHash', 'email', 'phone', 'userId', 'inviteStatus',
] as const

// Dönüş tipi `Omit` — gerekçe için bkz. stripVenueSensitive.
export function stripInstructorSensitive<T extends Record<string, any>>(
  inst: T | null | undefined,
): Omit<T, (typeof INSTRUCTOR_SENSITIVE_FIELDS)[number]> | null {
  if (!inst) return null as any
  const i: any = { ...inst }
  for (const k of INSTRUCTOR_SENSITIVE_FIELDS) delete i[k]
  return i
}

/**
 * AVATAR / GÖRSEL URL DOĞRULAMA.
 *
 * avatarUrl istemciden geliyordu ve yalnızca uzunluğu kırpılıyordu; içeriği hiç denetlenmiyordu.
 * Bu alan liderlik tablosunda, sosyal akışta, takipçi listelerinde, profil sayfasında ve ADMİN
 * PANELİNDE <img src> olarak yükleniyor. Saldırgan-kontrollü bir adres koymak:
 *   • görüntüleyen HERKESİN IP'sini ve User-Agent'ını saldırganın sunucusuna gönderir
 *     (admin dahil — admin panelinde de aynı avatar render ediliyor),
 *   • `javascript:` / `data:` şemalarıyla istemciye göre script çalıştırma yüzeyi açar.
 *
 * Kural: yalnız https ve yalnız BİLİNEN barındırıcılar. Boş/eksik değer serbest (avatar isteğe
 * bağlı). Reddetmek yerine `null` döndürmüyoruz — çağıran 400 dönebilsin diye ayrımı koruyoruz.
 */
const IZINLI_GORSEL_HOSTLARI = [
  'res.cloudinary.com',   // uygulamanın kendi yüklemeleri
  'ui-avatars.com',       // baş harf avatarı üreteci (getInitialsAvatar)
  'lh3.googleusercontent.com', // Google ile giriş geldiğinde profil fotoğrafı
]

export function gorselUrlGecerliMi(url: unknown): boolean {
  if (url === null || url === undefined || url === '') return true // avatar zorunlu değil
  if (typeof url !== 'string') return false
  let u: URL
  try { u = new URL(url) } catch { return false }
  if (u.protocol !== 'https:') return false // http/javascript:/data: reddedilir
  return IZINLI_GORSEL_HOSTLARI.some(h => u.hostname === h || u.hostname.endsWith('.' + h))
}
