import prisma from '../utils/prisma'
import { sendPushNotification } from '../utils/push'
import { notifyFields, notifyPush } from '../utils/notifyText'
import { Locale } from '../utils/locale'

// Ders bitiminden ~2 saat sonra "dersini puanla" hatırlatması.
// Puanlama hakkı ders BİTER bitmez açılır (reviewController createReview: endsAt); bu job yalnızca
// uygulamayı bu 2 saatte hiç açmayanları dürten HATIRLATMA katmanıdır. reminderJob ile AYNI desen:
// findMany → booking başına ATOMİK claim (ratingPromptSent false→true) → yalnızca sahiplenen çalışma
// bildirir (çoklu instance / interval+cron yarışı yok).
export const sendRatingPrompts = async () => {
  try {
    const now = new Date()
    const twoHoursAgo = new Date(now.getTime() - 120 * 60 * 1000)
    const floor = new Date(now.getTime() - 7 * 86400000) // 7 gün taban: eski birikmiş booking'leri tarama

    const bookings = await prisma.booking.findMany({
      where: {
        status: 'confirmed',
        checkedIn: true,                              // yalnızca derse KATILANA sor (no-show'u rahatsız etme)
        ratingPromptSent: false,
        user: { banned: false },                      // banlı kullanıcıya "puanla" hatırlatması gitmesin
        reviews: { none: { targetType: 'venue' } },   // zaten puanladıysa hatırlatma gönderme
        session: { endsAt: { lte: twoHoursAgo, gte: floor } }, // drop-in (sessionId null) doğal dışlanır
      },
      include: {
        user: { select: { pushToken: true, locale: true } },
        session: { include: { class: { select: { title: true } } } },
      },
    })

    for (const booking of bookings) {
      try {
        // Atomik sahiplen: ratingPromptSent'i false→true çevirebilen TEK çalışma bildirir.
        // reviews:{none} filtresi claim'e de eklendi → findMany ile claim ARASINDA kullanıcı puanladıysa
        // (venue satırı oluştuysa) count=0 döner, gereksiz "puanla" hatırlatması gitmez.
        const claim = await prisma.booking.updateMany({
          where: { id: booking.id, ratingPromptSent: false, reviews: { none: { targetType: 'venue' } } },
          data: { ratingPromptSent: true },
        })
        if (claim.count === 0) continue

        const classTitle = booking.session!.class.title
        const rpLoc = (booking.user?.locale || 'tr') as Locale
        const rpParams = { classTitle }

        // In-app bildirim (best-effort — championJob deseni)
        await prisma.notification.create({
          data: { userId: booking.userId, type: 'rating_prompt', ...notifyFields(rpLoc, 'rating_prompt', rpParams) },
        }).catch(() => {})

        const rpPush = notifyPush(rpLoc, 'rating_prompt', rpParams)
        if (booking.user?.pushToken && rpPush) {
          await sendPushNotification(
            booking.user.pushToken,
            rpPush.title,
            rpPush.body,
            { type: 'rating_prompt', bookingId: booking.id }, // mobil deep-link için data
          )
        }
      } catch (e) {
        console.error(`Rating prompt error for booking ${booking.id}:`, e)
      }
    }

    if (bookings.length > 0) console.log(`⭐ ${bookings.length} puanlama hatırlatması işlendi.`)
  } catch (err) {
    console.error('Rating prompt job error:', err)
  }
}
