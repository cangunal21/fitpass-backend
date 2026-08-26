/**
 * FİNANSAL KAYIT ARŞİVİ — silme öncesi anonimleştirerek sakla.
 *
 * Gizlilik Politikası 11.3: "vergi ve ticaret mevzuatı gereği tutulması zorunlu işlem ve fatura
 * kayıtları ... kimliğinizle bağlantısı koparılarak (anonimleştirilerek) yalnızca ilgili yasal
 * süre boyunca saklanır, süre sonunda imha edilir."
 *
 * İki yerde de aynı kusur vardı ve ikisi de bu fonksiyonu çağırıyor:
 *   - authController.deleteAccount   → payment/commissionHistory/booking HARD DELETE
 *   - venueController.purgeBookingsForSessions → booking HARD DELETE
 * Salon bir seansı sildiğinde kullanıcıya "ödemen iade edilecektir" bildirimi gidiyor ama
 * geriye o borcu gösteren TEK BİR KAYIT kalmıyordu.
 *
 * ARŞİV KİŞİYİ DEĞİL İŞLEMİ TUTAR: userId, ad, e-posta yazılmaz; User'a FK yoktur.
 */
import prisma from './prisma'

/** TTK m.82 — ticari defter ve belgeler 10 yıl saklanır. */
export const SAKLAMA_YILI = 10

type ArsivBooking = {
  bookingNumber: string | null
  baseAmount: number | null
  commissionAmount: number | null
  userCommission: number | null
  venueCommission: number | null
  finalAmount: number | null
  venuePayout: number | null
  groupSize: number | null
  refundType?: string | null
  refundAmount?: number | null
  createdAt?: Date | null
  session?: {
    startsAt: Date | null
    class?: { venueId: number | null; instructorId: number | null } | null
  } | null
  payment?: { status: string | null } | null
}

export type ArsivSebebi = 'hesap_silindi' | 'seans_silindi'

/**
 * Silinmek üzere olan rezervasyonları arşivler. Transaction içinde çağrılmalı: arşiv yazılmadan
 * satır silinirse kayıt kalıcı olarak kaybolur, ikisi aynı transaction'da olmalı.
 *
 * @returns yazılan satır sayısı
 */
export async function finansalArsivle(
  tx: Pick<typeof prisma, 'finansalKayit'>,
  bookings: ArsivBooking[],
  reason: ArsivSebebi,
): Promise<number> {
  const satirlar = bookings
    // Parasal içeriği olmayan kaydın vergi/ticaret mevzuatı bakımından saklanacak bir yanı yok.
    // Hepsini arşivlemek, veri minimizasyonunu ters yönden ihlal ederdi.
    .filter(b => (b.finalAmount || 0) > 0 || (b.venuePayout || 0) > 0 || !!b.payment)
    .map(b => {
      const occurredAt = b.session?.startsAt || b.createdAt || new Date()
      const purgeAfter = new Date(occurredAt)
      purgeAfter.setFullYear(purgeAfter.getFullYear() + SAKLAMA_YILI)
      return {
        bookingNumber: b.bookingNumber || '',
        occurredAt,
        baseAmount: b.baseAmount || 0,
        commissionAmount: b.commissionAmount || 0,
        userCommission: b.userCommission || 0,
        venueCommission: b.venueCommission || 0,
        finalAmount: b.finalAmount || 0,
        venuePayout: b.venuePayout || 0,
        groupSize: b.groupSize || 1,
        venueId: b.session?.class?.venueId ?? null,
        instructorId: b.session?.class?.instructorId ?? null,
        // Ödeme açılmadan önce Payment satırı yok → null. Arşiv, para hareketi OLMAYAN bir
        // işlemi olmuş gibi göstermemeli.
        paymentStatus: b.payment?.status ?? null,
        refundType: b.refundType ?? null,
        refundAmount: b.refundAmount ?? null,
        reason,
        purgeAfter,
      }
    })

  if (!satirlar.length) return 0
  await tx.finansalKayit.createMany({ data: satirlar })
  return satirlar.length
}

/**
 * Saklama süresi dolmuş kayıtları imha eder. Metin "süre sonunda imha edilir" diyor; süresiz
 * saklamak da vaadin ihlalidir. Cron'dan çağrılır.
 */
export async function suresiDolanlariImhaEt(): Promise<number> {
  const r = await prisma.finansalKayit.deleteMany({ where: { purgeAfter: { lte: new Date() } } })
  return r.count
}
