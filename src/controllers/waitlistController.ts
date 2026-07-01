import { Request, Response } from 'express'
import prisma from '../utils/prisma'
import { sendWaitlistNotificationEmail } from '../utils/email'
import { sendPushNotification } from '../utils/push'

// Bekleme listesine katıl
export const joinWaitlist = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId
    const sessionId = parseInt(req.params.sessionId as string)

    const session = await prisma.class_Session.findUnique({
      where: { id: sessionId },
      include: { class: true }
    })
    if (!session) return res.status(404).json({ error: 'Seans bulunamadı.' })

    // Zaten kayıtlı mı?
    const existingBooking = await prisma.booking.findFirst({
      where: { userId, sessionId, status: { in: ['confirmed', 'pending'] } }
    })
    if (existingBooking) return res.status(400).json({ error: 'Zaten bu derse kayıtlısınız.' })

    // Bekleme listesi yalnızca DOLU seans için. Yer varsa doğrudan rezervasyon yapılmalı
    // (aksi halde kullanıcı yer varken beklemeye takılır ve iptal olmadan bildirim alamaz).
    const occupancy = await prisma.booking.aggregate({
      where: { sessionId, status: { in: ['confirmed', 'pending'] } },
      _sum: { groupSize: true },
    })
    const occupied = occupancy._sum.groupSize || 0
    if (session.availableSpots != null && occupied < session.availableSpots) {
      return res.status(400).json({ error: 'Bu seansta yer var, doğrudan rezervasyon yapabilirsiniz.' })
    }

    // Zaten bekliyor mu?
    const existing = await prisma.waitlist.findUnique({
      where: { userId_sessionId: { userId, sessionId } }
    })
    if (existing) return res.status(400).json({ error: 'Zaten bekleme listesindesisiniz.' })

    const entry = await prisma.waitlist.create({
      data: { userId, sessionId }
    })

    return res.status(201).json({ message: 'Bekleme listesine eklendiz!', entry })
  } catch (err: any) {
    if (err?.code === 'P2002') return res.status(400).json({ error: 'Zaten bekleme listesindesiniz.' })
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// Bekleme listesinden çık
export const leaveWaitlist = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId
    const sessionId = parseInt(req.params.sessionId as string)

    await prisma.waitlist.deleteMany({ where: { userId, sessionId } })
    return res.json({ message: 'Bekleme listesinden çıkıldı.' })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// Seans için bekleme listesi durumu
export const getWaitlistStatus = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId
    const sessionId = parseInt(req.params.sessionId as string)

    const entry = await prisma.waitlist.findUnique({
      where: { userId_sessionId: { userId, sessionId } }
    })
    const count = await prisma.waitlist.count({ where: { sessionId } })

    // Sıradaki GERÇEK yer = kendinden önce (daha erken) katılanların sayısı + 1
    // (önceden yanlışlıkla toplam sayı dönüyordu — 5 kişi varken 2. kişiye de "5" diyordu)
    let position: number | null = null
    if (entry) {
      const ahead = await prisma.waitlist.count({ where: { sessionId, createdAt: { lt: entry.createdAt } } })
      position = ahead + 1
    }

    return res.json({ onWaitlist: !!entry, position, totalWaiting: count })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// İptal olunca waitlist'teki ilk kişiye bildir (bookingController'dan çağrılacak)
export const notifyFirstWaitlistUser = async (sessionId: number) => {
  try {
    const first = await prisma.waitlist.findFirst({
      where: { sessionId, status: 'waiting' },
      orderBy: { createdAt: 'asc' },
      include: {
        user: { select: { email: true, fullName: true, pushToken: true } },
        session: { include: { class: true } }
      }
    })

    if (!first) return

    await prisma.waitlist.update({
      where: { id: first.id },
      data: { status: 'notified', notifiedAt: new Date() }
    })

    const startsAt = new Date(first.session.startsAt)
    const date = startsAt.toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' })
    const time = startsAt.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })
    if (first.user?.email) {
      await sendWaitlistNotificationEmail(first.user.email, first.user.fullName, first.session.class.title, date, time)
    }
    if (first.user?.pushToken) {
      sendPushNotification(first.user.pushToken, 'Yer açıldı! 🎉', `${first.session.class.title} (${date} ${time}) dersinde yer açıldı, hemen kaydol!`).catch(() => {})
    }
  } catch (e) {
    console.error('Waitlist notification error:', e)
  }
}
