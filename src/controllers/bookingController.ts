import { Request, Response } from 'express'
import prisma from '../utils/prisma'
import { sendVenueBookingNotificationEmail, sendCancellationEmail, sendVenueCancellationEmail, sendBookingConfirmationEmail, sendGroupTagNotificationEmail, sendGroupInviteEmail } from '../utils/email'

// Rezervasyon oluştur
export const createBooking = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId
    const { sessionId, notes, groupSize: rawGroupSize, taggedUsernames } = req.body
    const groupSize = Math.max(1, Math.min(parseInt(rawGroupSize) || 1, 10))
    const rawTags: string[] = Array.isArray(taggedUsernames) ? taggedUsernames.slice(0, groupSize - 1) : []
    // normalize: strip @ prefix, lowercase
    const cleanTags = rawTags.map((u: string) => u.replace(/^@/, '').toLowerCase().trim()).filter(Boolean)

    if (!sessionId) {
      return res.status(400).json({ error: 'Ders seansı gerekli.' })
    }

    // Seans var mı?
    const session = await prisma.class_Session.findUnique({
      where: { id: sessionId },
      include: { class: true },
    })

    if (!session) {
      return res.status(404).json({ error: 'Ders seansı bulunamadı.' })
    }

    // Kapasite dolu mu?
    const bookingCount = await prisma.booking.count({
      where: { sessionId, status: { in: ['confirmed', 'pending'] } },
    })

    if (session.availableSpots && bookingCount + groupSize > session.availableSpots) {
      const remaining = session.availableSpots - bookingCount
      if (remaining <= 0) return res.status(400).json({ error: 'Bu ders seansı dolu.' })
      return res.status(400).json({ error: `Sadece ${remaining} kontenjan kaldı.` })
    }

    // Zaten rezervasyon var mı?
    const existing = await prisma.booking.findFirst({
      where: { userId, sessionId, status: { in: ['confirmed', 'pending'] } },
    })

    if (existing) {
      return res.status(400).json({ error: 'Bu derse zaten kayıtlısınız.' })
    }

    const basePrice = (session.class?.basePrice || 0) * groupSize

    const booking = await prisma.booking.create({
      data: {
        userId,
        sessionId,
        bookingType: 'class',
        status: 'confirmed',
        notes: notes || null,
        groupSize,
        baseAmount: basePrice,
        discountAmount: 0,
        commissionAmount: 0,
        userCommission: 0,
        venueCommission: 0,
        finalAmount: basePrice,
        venuePayout: basePrice,
        bookingNumber: `BK-${crypto.randomUUID()}`,
        checkInCode: crypto.randomBytes(4).toString('hex').toUpperCase(),
        taggedFriends: cleanTags.length ? cleanTags : [],
      },
      include: {
        session: {
          include: { class: true },
        },
      },
    })

    // Salon email bildirimi
    try {
      const venue = await prisma.venue.findUnique({
        where: { id: booking.session!.class.venueId },
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
          booking.session!.class.title,
          date,
          time,
          session.availableSpots ?? 0,
          (session.availableSpots ?? 0) - bookingCount - 1
        )
      }
    } catch (emailErr) {
      console.error('Venue email notification error:', emailErr)
      // Don't fail the booking if email fails
    }

    // Kullanıcıya onay emaili
    try {
      const userForEmail = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, fullName: true } })
      if (userForEmail?.email) {
        const startsAt = new Date(session.startsAt)
        const date = startsAt.toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' })
        const time = startsAt.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })
        await sendBookingConfirmationEmail(userForEmail.email, userForEmail.fullName, booking.session!.class.title, date, time, booking.finalAmount)
      }
    } catch (emailErr) {
      console.error('User confirmation email error:', emailErr)
    }

    // Etiketlenen kullanıcılara bildirim gönder
    if (cleanTags.length > 0) {
      try {
        const booker = await prisma.user.findUnique({ where: { id: userId }, select: { fullName: true } })
        const startsAt = new Date(session.startsAt)
        const date = startsAt.toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' })
        const time = startsAt.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })
        const venueName = booking.session!.class.venueId
          ? (await prisma.venue.findUnique({ where: { id: booking.session!.class.venueId }, select: { name: true } }))?.name || ''
          : ''

        for (const username of cleanTags) {
          const taggedUser = await prisma.user.findFirst({
            where: { username: { equals: username, mode: 'insensitive' } },
            select: { email: true, fullName: true, emailReminders: true }
          })
          if (taggedUser?.email && taggedUser.emailReminders !== false) {
            await sendGroupTagNotificationEmail(
              taggedUser.email,
              taggedUser.fullName,
              booker?.fullName || 'Bir kullanıcı',
              booking.session!.class.title,
              date,
              time,
              venueName
            )
          }
        }
      } catch (tagErr) {
        console.error('Tag notification error:', tagErr)
      }
    }

    res.status(201).json({ message: 'Rezervasyon başarıyla oluşturuldu!', booking, taggedCount: cleanTags.length })
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
        session: {
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

// Drop-in'e katıl
export const joinDropIn = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId
    const slotId = parseInt(req.params.slotId as string)

    const slot = await prisma.dropInSlot.findUnique({ where: { id: slotId } })
    if (!slot) return res.status(404).json({ error: 'Slot bulunamadı.' })
    if (slot.status !== 'open') return res.status(400).json({ error: 'Bu slot artık açık değil.' })
    if (slot.currentPlayers >= slot.totalPlayers) return res.status(400).json({ error: 'Slot dolu.' })

    const existing = await prisma.dropInParticipant.findFirst({ where: { slotId, userId } })
    if (existing) return res.status(400).json({ error: 'Zaten katılıyorsunuz.' })

    const participant = await prisma.dropInParticipant.create({
      data: { slotId, userId, status: 'confirmed' }
    })

    await prisma.dropInSlot.update({
      where: { id: slotId },
      data: { currentPlayers: { increment: 1 } }
    })

    return res.status(201).json({ message: "Drop-in'e katıldınız!", participant })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// Rezervasyon iptal et
export const cancelBooking = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId
    const bookingId = parseInt(req.params.id as string)

    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: { session: { select: { startsAt: true } } },
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

    // İptal politikası: 12 saat içinde iptal yok, 12-24 saat yarım iade, 24 saat üstü tam iade
    const sessionStartsAt = booking.session?.startsAt
    if (sessionStartsAt) {
      const now = new Date()
      const hoursUntilSession = (new Date(sessionStartsAt).getTime() - now.getTime()) / (1000 * 60 * 60)

      if (hoursUntilSession < 12) {
        return res.status(400).json({
          error: 'Derse 12 saatten az kaldığı için iptal yapılamaz.',
          hoursLeft: Math.round(hoursUntilSession * 10) / 10
        })
      }
    }

    // Determine refund type
    const sessionStartsAt2 = booking.session?.startsAt
    const hoursUntil = sessionStartsAt2
      ? (new Date(sessionStartsAt2).getTime() - new Date().getTime()) / (1000 * 60 * 60)
      : 999
    const refundType = hoursUntil >= 24 ? 'full' : 'half'
    const refundAmount = refundType === 'full' ? booking.finalAmount : (booking.finalAmount || 0) / 2

    const updated = await prisma.booking.update({
      where: { id: bookingId },
      data: {
        status: 'cancelled',
        notes: `${booking.notes ? booking.notes + ' | ' : ''}İptal: ${refundType === 'full' ? 'Tam iade' : 'Yarım iade'} (₺${refundAmount})`
      },
    })

    // İptal email bildirimleri
    try {
      const fullBooking = await prisma.booking.findUnique({
        where: { id: bookingId },
        include: {
          user: { select: { fullName: true, email: true } },
          session: { include: { class: { include: { venue: { select: { email: true, name: true } } } } } },
        },
      })

      if (fullBooking) {
        const startsAt = new Date(fullBooking.session!.startsAt)
        const date = startsAt.toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' })
        const time = startsAt.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })
        const classTitle = fullBooking.session!.class.title
        const venue = fullBooking.session!.class.venue

        // Kullanıcıya iptal bildirimi
        if (fullBooking.user?.email) {
          await sendCancellationEmail(fullBooking.user.email, fullBooking.user.fullName, classTitle, date, time)
        }

        // Salona iptal bildirimi
        if (venue?.email) {
          await sendVenueCancellationEmail(venue.email, venue.name, fullBooking.user?.fullName || 'Kullanıcı', classTitle, date, time)
        }
      }
    } catch (emailErr) {
      console.error('Cancellation email error:', emailErr)
    }

    // Waitlist'teki ilk kişiye bildir
    try {
      const { notifyFirstWaitlistUser } = await import('./waitlistController')
      await notifyFirstWaitlistUser(booking.sessionId!)
    } catch (e) {
      console.error('Waitlist notify error:', e)
    }

    res.json({
      message: `Rezervasyon iptal edildi. ${refundType === 'full' ? 'Tam iade' : 'Yarım iade'} (₺${refundAmount}) uygulandı.`,
      booking: updated,
      refundType,
      refundAmount,
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// Salon check-in: kodu doğrula ve check-in yap
export const checkInBooking = async (req: Request, res: Response) => {
  try {
    const venueId = (req as any).venueId
    const { code } = req.body

    if (!code?.trim()) {
      return res.status(400).json({ error: 'Check-in kodu gerekli.' })
    }

    const booking = await prisma.booking.findFirst({
      where: { checkInCode: code.trim().toUpperCase() },
      include: {
        user: { select: { fullName: true, username: true, avatarUrl: true } },
        session: { include: { class: { select: { title: true, venueId: true } } } }
      }
    })

    if (!booking) {
      return res.status(404).json({ error: 'Geçersiz kod. Rezervasyon bulunamadı.' })
    }

    // Bu salona ait mi?
    if (booking.session?.class?.venueId !== venueId) {
      return res.status(403).json({ error: 'Bu rezervasyon salonunuza ait değil.' })
    }

    if (booking.status !== 'confirmed') {
      return res.status(400).json({ error: 'Rezervasyon onaylı değil.' })
    }

    if (booking.checkedIn) {
      return res.json({
        alreadyCheckedIn: true,
        message: 'Bu rezervasyon zaten check-in yapılmış.',
        booking: {
          user: booking.user,
          classTitle: booking.session?.class?.title,
          checkedInAt: booking.checkedInAt,
          groupSize: booking.groupSize,
        }
      })
    }

    await prisma.booking.update({
      where: { id: booking.id },
      data: { checkedIn: true, checkedInAt: new Date() }
    })

    return res.json({
      success: true,
      message: 'Check-in başarılı!',
      booking: {
        user: booking.user,
        classTitle: booking.session?.class?.title,
        groupSize: booking.groupSize,
        checkedInAt: new Date(),
      }
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}
