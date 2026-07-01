// Kullanıcı içeriğini (yorum + feed yorumu) toplu temizleme yardımcıları.
// Hem ban (banUser) hem hesap silme (deleteAccount) tarafından paylaşılır ki
// yorum silme + salon/eğitmen puan ortalamalarının yeniden hesaplanması tek yerde olsun.

// Bir kullanıcının TÜM yorumlarını (Review) siler ve etkilenen salon + eğitmenlerin
// avgRating/totalReviews değerlerini kalan yorumlara göre yeniden hesaplar.
// (Aksi halde silinen yorum salon ortalamasında "hayalet" olarak kalırdı.)
export async function purgeUserReviews(tx: any, userId: number): Promise<number> {
  const reviews = await tx.review.findMany({
    where: { reviewerUserId: userId },
    select: { id: true, venueId: true, instructorId: true },
  })
  if (reviews.length === 0) return 0

  const venueIds = [...new Set(reviews.map((r: any) => r.venueId).filter((v: any): v is number => !!v))]
  const instructorIds = [...new Set(reviews.map((r: any) => r.instructorId).filter((v: any): v is number => !!v))]

  await tx.review.deleteMany({ where: { reviewerUserId: userId } })

  for (const vId of venueIds) {
    const rest = await tx.review.findMany({ where: { venueId: vId }, select: { rating: true } })
    const avg = rest.length ? rest.reduce((s: number, r: any) => s + r.rating, 0) / rest.length : 0
    await tx.venue.update({ where: { id: vId }, data: { avgRating: Math.round(avg * 10) / 10, totalReviews: rest.length } })
  }
  for (const iId of instructorIds) {
    const rest = await tx.review.findMany({ where: { instructorId: iId }, select: { rating: true } })
    const avg = rest.length ? rest.reduce((s: number, r: any) => s + r.rating, 0) / rest.length : 0
    await tx.instructor.update({ where: { id: iId }, data: { avgRating: Math.round(avg * 10) / 10, totalReviews: rest.length } })
  }
  return reviews.length
}

// Bir kullanıcının feed yorumlarını (ActivityComment) siler. Yorumlar self-FK ile
// (parent/replies) bağlı olduğundan, silinecek yorumlara yanıt olarak gelen kayıtların
// parentId'si önce null'lanır (FK kırılmasın).
export async function purgeUserComments(tx: any, userId: number): Promise<void> {
  const myComments = await tx.activityComment.findMany({ where: { userId }, select: { id: true } })
  const myCommentIds = myComments.map((c: any) => c.id)
  if (myCommentIds.length) {
    await tx.activityComment.updateMany({ where: { parentId: { in: myCommentIds } }, data: { parentId: null } })
  }
  await tx.activityComment.deleteMany({ where: { userId } })
}
