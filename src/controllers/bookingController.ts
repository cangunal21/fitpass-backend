import { Request, Response } from 'express'
import prisma from '../utils/prisma'
import { sendVenueBookingNotificationEmail } from '../utils/email'

// Rezervasyon oluştur
export const createBooking = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId
    const { classSessionId, notes } = req.body

    if (!classSessionId) {
      return res.status(400).json({ error: 'Ders seansı gerekli.' })
    }

    // Seans var mı?
    const session = await prisma.class_Session.findUnique({
      where: { id: classSessionId },
      include: { class: true },
    })

    if (!session) {
      return res.status(404).json({ error: 'Ders seansı bulunamadı.' })
    }

    // Kapasite dolu mu?
    const bookingCount = await prisma.booking.count({
      where: { classSessionId, status: { in: ['confirmed', 'pending'] } },
    })

    if (session.capacity && bookingCount >= session.capacity) {
      return res.status(400).json({ error: 'Bu ders seansı dolu.' })
    }

    // Zaten rezervasyon var mı?
    const existing = await prisma.booking.findFirst({
      where: { userId, classSessionId, status: { in: ['confirmed', 'pending'] } },
    })

    if (existing) {
      return res.status(400).json({ error: 'Bu derse zaten kayıtlısınız.' })
    }

    const booking = await prisma.booking.create({
      data: {
        userId,
        classSessionId,
        status: 'confirmed',
        notes: notes || null,
        totalPrice: session.price,
      },
      include: {
        classSession: {
          include: { class: true },
        },
      },
    })

    // Salon email bildirimi
    try {
      const venue = await prisma.venue.findUnique({
        where: { id: booking.classSession.class.venueId },
        select: { email: true, name: true },
      })

      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { fullName: true },
      })

      if (venue?.email) {
        const startsAt = new Date(session.startsAt)
        const date = startsAt.toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' })
        const time = startsAt.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })

        await sendVenueBookingNotificationEmail(
          venue.email,
          venue.name,
          user?.fullName || 'Kullanıcı',
          booking.classSession.class.title,
          date,
          time,
          session.capacity ?? 0,
          (session.capacity ?? 0) - bookingCount - 1
        )
      }
    } catch (emailErr) {
      console.error('Venue email notification error:', emailErr)
      // Don't fail the booking if email fails
    }

    res.status(201).json({ message: 'Rezervasyon başarıyla oluşturuldu!', booking })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// Kullanıcının rezervasyonlarını getir
export const getMyBookings = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId

    const bookings = await prisma.booking.findMany({
      where: { userId },
      include: {
        classSession: {
          include: { class: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    })

    res.json({ bookings })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// Rezervasyon iptal et
export const cancelBooking = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId
    const bookingId = parseInt(req.params.id as string)

    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: { classSession: true },
    })

    if (!booking) {
      return res.status(404).json({ error: 'Rezervasyon bulunamadı.' })
    }

    if (booking.userId !== userId) {
      return res.status(403).json({ error: 'Bu rezervasyonu iptal edemezsiniz.' })
    }

    if (booking.status === 'cancelled') {
      return res.status(400).json({ error: 'Rezervasyon zaten iptal edilmiş.' })
    }

    const updated = await prisma.booking.update({
      where: { id: bookingId },
      data: { status: 'cancelled' },
    })

    res.json({ message: 'Rezervasyon iptal edildi.', booking: updated })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Sunucu hatası.' })
  }
}
