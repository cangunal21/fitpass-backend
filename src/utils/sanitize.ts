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

export function stripVenueSensitive<T extends Record<string, any>>(venue: T): Partial<T> {
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

export function stripInstructorSensitive<T extends Record<string, any>>(inst: T | null | undefined): Partial<T> | null {
  if (!inst) return null as any
  const i: any = { ...inst }
  for (const k of INSTRUCTOR_SENSITIVE_FIELDS) delete i[k]
  return i
}
