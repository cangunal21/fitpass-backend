import prisma from '../utils/prisma'
import { sendReminderEmail } from '../utils/email'
import { sendPushNotification } from '../utils/push'

export const sendRemindersJob = async () => {
  try {
    const now = new Date()
    const from = new Date(now.getTime() + 105 * 60 * 1000) // +1s45dk
    const to = new Date(now.getTime() + 135 * 60 * 1000)   // +2s15dk

    const bookings = await prisma.booking.findMany({
      where: {
        status: 'confirmed',
        reminderSent: false,
        session: { startsAt: { gte: from, lte: to } }
      },
      include: {
        user: { select: { email: true, fullName: true, emailReminders: true, pushToken: true } },
        session: {
          include: {
            class: { include: { venue: { select: { name: true } } } }
          }
        }
      }
    })

    for (const booking of bookings) {
      try {
        // Atomik sahiplen: reminderSent'i false→true çevirebilen TEK çalışma gönderir.
        // (Çoklu instance ya da dahili job + HTTP cron aynı anda çalışırsa aynı booking'e
        // 2 mail/push gitmesin — findMany ile update arasındaki yarış penceresini kapatır.)
        const claim = await prisma.booking.updateMany({
          where: { id: booking.id, reminderSent: false },
          data: { reminderSent: true },
        })
        if (claim.count === 0) continue

        const startsAt = new Date(booking.session!.startsAt)
        const date = startsAt.toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' })
        const time = startsAt.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })
        const venueName = booking.session!.class.venue?.name || ''
        const classTitle = booking.session!.class.title

        if (booking.user?.email && booking.user.emailReminders !== false) {
          await sendReminderEmail(booking.user.email, booking.user.fullName, classTitle, date, time, venueName)
          console.log(`✅ Hatırlatma maili gönderildi: ${booking.user.email}`)
        }

        if (booking.user?.pushToken) {
          await sendPushNotification(
            booking.user.pushToken,
            'Dersine 2 saat kaldı! ⏰',
            `${classTitle} dersi bugün ${time}'de ${venueName} adresinde başlıyor.`
          )
          console.log(`📱 Push bildirimi gönderildi: ${booking.user.fullName}`)
        }
        // reminderSent zaten yukarıda atomik sahiplenmede işaretlendi.
      } catch (e) {
        console.error(`Reminder error for booking ${booking.id}:`, e)
      }
    }

    if (bookings.length > 0) {
      console.log(`📧 ${bookings.length} hatırlatma maili gönderildi.`)
    }
  } catch (err) {
    console.error('Reminder job error:', err)
  }
}
