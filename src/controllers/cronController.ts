import { Request, Response } from 'express'
import crypto from 'crypto'
import prisma from '../utils/prisma'
import { sendReminderEmail } from '../utils/email'

// Kaynağa GÖMÜLÜ varsayılan YOK (adminAuth deseni) — commit'lenen 'cron-secret-2024' benzeri default,
// NODE_ENV yanlış/eksik olan bir deploy'da bu side-effect'li ucu herkese açardı. Secret yoksa HER ortamda 503.
const CRON_SECRET = process.env.CRON_SECRET || ''
const CRON_CONFIGURED = CRON_SECRET.length > 0
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return crypto.timingSafeEqual(ab, bb)
}

export const sendReminders = async (req: Request, res: Response) => {
  try {
    // CRON_SECRET set DEĞİLSE HER ortamda reddet (dahili 30-dk job zaten hatırlatmaları gönderiyor → bu uç yedek).
    if (!CRON_CONFIGURED) {
      return res.status(503).json({ error: 'Cron yapılandırılmamış.' })
    }
    const secret = req.headers['x-cron-secret']
    if (typeof secret !== 'string' || !safeEqual(secret, CRON_SECRET)) {
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
        // Atomik sahiplen: reminderSent'i false→true çevirebilen TEK çalışma gönderir
        // (dahili 30-dk job ile aynı anda çalışsa bile çift mail gitmez).
        const claim = await prisma.booking.updateMany({
          where: { id: booking.id, reminderSent: false },
          data: { reminderSent: true },
        })
        if (claim.count === 0) continue

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
