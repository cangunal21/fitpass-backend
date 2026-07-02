import { Request, Response } from 'express'
import prisma from '../utils/prisma'
import { sendReminderEmail } from '../utils/email'

const CRON_SECRET = process.env.CRON_SECRET || 'cron-secret-2024'

export const sendReminders = async (req: Request, res: Response) => {
  try {
    // Prod'da CRON_SECRET set edilmemişse zayıf varsayılan geçerli olur → uç tahmin edilebilir.
    // Bu durumda ucu tamamen devre dışı bırak (dahili 30-dk job zaten hatırlatmaları gönderiyor).
    if (process.env.NODE_ENV === 'production' && !process.env.CRON_SECRET) {
      return res.status(503).json({ error: 'Cron yapılandırılmamış.' })
    }
    const secret = req.headers['x-cron-secret']
    if (secret !== CRON_SECRET) {
      return res.status(401).json({ error: 'Yetkisiz.' })
    }

    const now = new Date()
    // Sessions starting between 1h45m and 2h15m from now (30-minute window to avoid double-sending)
    const from = new Date(now.getTime() + 105 * 60 * 1000) // +1h45m
    const to = new Date(now.getTime() + 135 * 60 * 1000)   // +2h15m

    const bookings = await prisma.booking.findMany({
      where: {
        status: 'confirmed',
        reminderSent: false,
        session: {
          startsAt: { gte: from, lte: to }
        }
      },
      include: {
        user: { select: { email: true, fullName: true } },
        session: {
          include: {
            class: {
              include: { venue: { select: { name: true } } }
            }
          }
        }
      }
    })

    let sent = 0
    for (const booking of bookings) {
      try {
        if (!booking.user?.email) continue
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
        sent++
      } catch (e) {
        console.error(`Reminder email error for booking ${booking.id}:`, e)
      }
    }

    return res.json({ message: `${sent} hatırlatma maili gönderildi.`, sent })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}
