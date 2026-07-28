// Anonim yorumlarda yorum sahibinin kimliğini TAM gizler.
// Sadece join'lenmiş `reviewer` objesini null'lamak YETMEZ: scalar `reviewerUserId`
// (ve `bookingId`) yanıtta kalırsa, liderlikteki id↔username eşlemesiyle "anonim"
// yorum deşifre edilebilir. Bu yüzden anonimde bu alanlar da çıkarılır.
export function sanitizeReview<T extends { isAnonymous?: boolean; reviewer?: any }>(r: T): any {
  // İç scalar id'leri (reviewerUserId/bookingId/classId) HER yanıttan çıkar — public review uçları
  // optionalAuth; anonim olmayan yorumda da bu iç kayıt-id'lerinin dışarı sızmasına gerek yok.
  // Anonimde ek olarak join'lenmiş reviewer da null'lanır (kimlik tam gizli).
  const { reviewerUserId, bookingId, classId, reviewer, ...rest } = r as any
  return { ...rest, reviewer: r.isAnonymous ? null : reviewer }
}

// Salon/hoca'nın PRIVATE yanıtını yalnızca yorumu yazan kullanıcıya göster; herkeste (ve anonimde,
// viewerId eşleşmediği için) gizle. `raw` ham review (reviewerUserId erişilebilir), `safe` sanitize
// edilmiş çıktı objesi. Aynı `safe` objesi (mutasyonla) döner.
export function hidePrivateReply(raw: any, safe: any, viewerId?: number): any {
  if (raw?.replyVisibility === 'private' && raw?.reviewerUserId !== viewerId) {
    safe.venueReply = null
    safe.venueRepliedAt = null
    safe.replyVisibility = null
  }
  return safe
}
