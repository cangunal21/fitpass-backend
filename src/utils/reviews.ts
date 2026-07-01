// Anonim yorumlarda yorum sahibinin kimliğini TAM gizler.
// Sadece join'lenmiş `reviewer` objesini null'lamak YETMEZ: scalar `reviewerUserId`
// (ve `bookingId`) yanıtta kalırsa, liderlikteki id↔username eşlemesiyle "anonim"
// yorum deşifre edilebilir. Bu yüzden anonimde bu alanlar da çıkarılır.
export function sanitizeReview<T extends { isAnonymous?: boolean; reviewer?: any }>(r: T): any {
  if (!r.isAnonymous) return r
  const { reviewerUserId, bookingId, reviewer, ...rest } = r as any
  return { ...rest, reviewer: null }
}
