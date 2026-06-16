import prisma from '../utils/prisma'
import { sendReminderEmail } from '../utils/email'

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
        user: { select: { email: true, fullName: true, emailReminders: true } },
        session: {
          include: {
            class: { include: { venue: { select: { name: true } } } }
          }
        }
      }
    })

    for (const booking of bookings) {
      try {
        if (!booking.user?.email) continue
        if (booking.user.emailReminders === false) continue
        const startsAt = new Date(booking.session!.startsAt)
        const date = startsAt.toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' })
        const time = startsAt.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })

        await sendReminderEmail(
          booking.user.email,
          booking.user.fullName,
          booking.session!.class.title,
          date,
          time,
          booking.session!.class.venue?.name || ''
        )

        await prisma.booking.update({
          where: { id: booking.id },
          data: { reminderSent: true }
        })

        console.log(`✅ Hatırlatma maili gönderildi: ${booking.user.email}`)
      } catch (e) {
        console.error(`Reminder email error for booking ${booking.id}:`, e)
      }
    }

    if (bookings.length > 0) {
      console.log(`📧 ${bookings.length} hatırlatma maili gönderildi.`)
    }
  } catch (err) {
    console.error('Reminder job error:', err)
  }
}
