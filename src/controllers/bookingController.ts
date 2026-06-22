import { Request, Response } from 'express'
import prisma from '../utils/prisma'
import crypto from 'crypto'
import { sendVenueBookingNotificationEmail, sendCancellationEmail, sendVenueCancellationEmail, sendBookingConfirmationEmail, sendGroupTagNotificationEmail, sendGroupInviteEmail } from '../utils/email'
import { sendPushNotification } from '../utils/push'
import { completeReferral } from './referralController'

class BookingError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

// Rezervasyon oluştur
export const createBooking = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId
    const { sessionId, notes, groupSize: rawGroupSize, taggedUsernames, useCredit, couponCode } = req.body
    const groupSize = Math.max(1, Math.min(parseInt(rawGroupSize) || 1, 10))
    const rawTags: string[] = Array.isArray(taggedUsernames) ? taggedUsernames.slice(0, groupSize - 1) : []
    // normalize: strip @ prefix, lowercase
    const cleanTags = rawTags.map((u: string) => u.replace(/^@/, '').toLowerCase().trim()).filter(Boolean)

    if (!sessionId) {
      return res.status(400).json({ error: 'Ders seansı gerekli.' })
    }

    let coupon: { id: number; discountType: string; discountValue: number } | null = null
    let couponDiscount = 0
    let creditUsed = 0
    let finalAmount = 0
    let booking: any

    try {
      // Tüm kapasite/kupon/kredi kontrolü ve yazma işlemi tek transaction içinde,
      // seans satırı kilitlenerek aynı anda gelen isteklerin sıraya girmesi sağlanır
      // (iki kişi son boş yere aynı anda tıklarsa kapasite aşılmasın diye).
      booking = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT id FROM "Class_Session" WHERE id = ${sessionId} FOR UPDATE`

        const session = await tx.class_Session.findUnique({
          where: { id: sessionId },
          include: { class: true },
        })

        if (!session) throw new BookingError('Ders seansı bulunamadı.', 404)

        const bookingCount = await tx.booking.count({
          where: { sessionId, status: { in: ['confirmed', 'pending'] } },
        })

        if (session.availableSpots && bookingCount + groupSize > session.availableSpots) {
          const remaining = session.availableSpots - bookingCount
          throw new BookingError(remaining <= 0 ? 'Bu ders seansı dolu.' : `Sadece ${remaining} kontenjan kaldı.`, 400)
        }

        const existing = await tx.booking.findFirst({
          where: { userId, sessionId, status: { in: ['confirmed', 'pending'] } },
        })

        if (existing) throw new BookingError('Bu derse zaten kayıtlısınız.', 400)

        const basePrice = (session.class?.basePrice || 0) * groupSize

        if (couponCode) {
          await tx.$executeRaw`SELECT id FROM "Coupon" WHERE code = ${String(couponCode).toUpperCase()} FOR UPDATE`
          const found = await tx.coupon.findUnique({ where: { code: String(couponCode).toUpperCase() } })
          if (!found || !found.isActive) throw new BookingError('Geçersiz kupon kodu.', 400)
          if (found.venueId !== session.class!.venueId) throw new BookingError('Bu kupon bu salona ait değil.', 400)
          if (found.expiresAt && found.expiresAt < new Date()) throw new BookingError('Kupon süresi dolmuş.', 400)
          if (found.maxUses && found.usedCount >= found.maxUses) throw new BookingError('Kupon kullanım limiti dolmuş.', 400)
          coupon = found
          couponDiscount = found.discountType === 'percent'
            ? basePrice * (found.discountValue / 100)
            : Math.min(found.discountValue, basePrice)
        }

        if (useCredit) {
          const userWithCredit = await tx.user.findUnique({ where: { id: userId }, select: { creditBalance: true } })
          const available = userWithCredit?.creditBalance || 0
          creditUsed = Math.min(available, Math.max(0, basePrice - couponDiscount))
        }
        finalAmount = Math.max(0, basePrice - couponDiscount - creditUsed)

        const created = await tx.booking.create({
          data: {
            userId,
            sessionId,
            bookingType: 'class',
            status: 'confirmed',
            notes: notes || null,
            groupSize,
            baseAmount: basePrice,
            discountAmount: couponDiscount + creditUsed,
            commissionAmount: 0,
            userCommission: 0,
            venueCommission: 0,
            finalAmount,
            venuePayout: finalAmount,
            creditUsed,
            couponId: coupon?.id || null,
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

        if (coupon) {
          await tx.coupon.update({ where: { id: coupon.id }, data: { usedCount: { increment: 1 } } })
        }
        if (creditUsed > 0) {
          await tx.user.update({ where: { id: userId }, data: { creditBalance: { decrement: creditUsed } } })
        }

        return created
      })
    } catch (e: any) {
      if (e instanceof BookingError) return res.status(e.status).json({ error: e.message })
      throw e
    }

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
        const startsAt = new Date(booking.session!.startsAt)
        const date = startsAt.toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' })
        const time = startsAt.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })

        const remainingAfterBooking = await prisma.booking.count({
          where: { sessionId, status: { in: ['confirmed', 'pending'] } },
        })

        await sendVenueBookingNotificationEmail(
          venue.email,
          venue.name,
          user?.fullName || 'Kullanıcı',
          booking.session!.class.title,
          date,
          time,
          booking.session!.availableSpots ?? 0,
          (booking.session!.availableSpots ?? 0) - remainingAfterBooking
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
        const startsAt = new Date(booking.session!.startsAt)
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
        const startsAt = new Date(booking.session!.startsAt)
        const date = startsAt.toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' })
        const time = startsAt.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })
        const venueName = booking.session!.class.venueId
          ? (await prisma.venue.findUnique({ where: { id: booking.session!.class.venueId }, select: { name: true } }))?.name || ''
          : ''

        const categoryName = booking.session!.class.category || booking.session!.class.title

        for (const username of cleanTags) {
          const taggedUser = await prisma.user.findFirst({
            where: { username: { equals: username, mode: 'insensitive' } },
            select: { id: true, email: true, fullName: true, emailReminders: true, pushToken: true }
          })
          if (!taggedUser) continue

          if (taggedUser.email && taggedUser.emailReminders !== false) {
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

          await prisma.notification.create({
            data: {
              userId: taggedUser.id,
              type: 'group_invite',
              message: `${booker?.fullName || 'Bir kullanıcı'} sizi ${categoryName} sporuna davet etti.`,
              relatedUserId: userId,
            },
          })

          if (taggedUser.pushToken) {
            sendPushNotification(
              taggedUser.pushToken,
              'Yeni davet! 🎉',
              `${booker?.fullName || 'Bir kullanıcı'} sizi ${categoryName} sporuna davet etti.`
            ).catch(() => {})
          }
        }
      } catch (tagErr) {
        console.error('Tag notification error:', tagErr)
      }
    }

    // İlk ödeme tamamlandıysa referral'ı tamamla (davet edene kredi ver)
    if (finalAmount > 0) {
      completeReferral(userId).catch(() => {})
    }

    res.status(201).json({ message: 'Rezervasyon başarıyla oluşturuldu!', booking, taggedCount: cleanTags.length, creditUsed })
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
          include: { class: { include: { venue: true } } },
        },
        dropInSlot: {
          include: { venue: true },
        },
        review: true,
      },
      orderBy: { createdAt: 'desc' },
    })

    const safeBookings = bookings.map(b => ({
      ...b,
      session: b.session ? {
        ...b.session,
        class: b.session.class ? {
          ...b.session.class,
          venue: b.session.class.venue ? (({ passwordHash, ...v }) => v)(b.session.class.venue) : null,
        } : null,
      } : null,
      dropInSlot: b.dropInSlot ? {
        ...b.dropInSlot,
        venue: b.dropInSlot.venue ? (({ passwordHash, ...v }) => v)(b.dropInSlot.venue) : null,
      } : null,
    }))

    res.json({ bookings: safeBookings })
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

    let participant: any
    try {
      participant = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT id FROM "DropInSlot" WHERE id = ${slotId} FOR UPDATE`

        const slot = await tx.dropInSlot.findUnique({ where: { id: slotId } })
        if (!slot) throw new BookingError('Slot bulunamadı.', 404)
        if (slot.status !== 'open') throw new BookingError('Bu slot artık açık değil.', 400)
        if (slot.currentPlayers >= slot.totalPlayers) throw new BookingError('Slot dolu.', 400)

        const existing = await tx.dropInParticipant.findFirst({ where: { slotId, userId } })
        if (existing) throw new BookingError('Zaten katılıyorsunuz.', 400)

        const created = await tx.dropInParticipant.create({
          data: {
            slotId,
            userId,
            status: 'confirmed',
            checkInCode: crypto.randomBytes(4).toString('hex').toUpperCase(),
          }
        })

        await tx.dropInSlot.update({
          where: { id: slotId },
          data: { currentPlayers: { increment: 1 } }
        })

        return created
      })
    } catch (e: any) {
      if (e instanceof BookingError) return res.status(e.status).json({ error: e.message })
      throw e
    }

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

// Drop-in check-in
export const checkInDropIn = async (req: Request, res: Response) => {
  try {
    const venueId = (req as any).venueId
    const { code } = req.body

    if (!code?.trim()) {
      return res.status(400).json({ error: 'Check-in kodu gerekli.' })
    }

    const participant = await prisma.dropInParticipant.findFirst({
      where: { checkInCode: code.trim().toUpperCase() },
      include: {
        user: { select: { fullName: true, username: true, avatarUrl: true } },
        slot: { select: { title: true, venueId: true, startsAt: true } }
      }
    })

    if (!participant) {
      return res.status(404).json({ error: 'Geçersiz kod. Katılım bulunamadı.' })
    }

    if (participant.slot?.venueId !== venueId) {
      return res.status(403).json({ error: 'Bu katılım salonunuza ait değil.' })
    }

    if (participant.status !== 'confirmed') {
      return res.status(400).json({ error: 'Katılım onaylı değil.' })
    }

    if (participant.checkedIn) {
      return res.json({
        alreadyCheckedIn: true,
        message: 'Bu katılımcı zaten check-in yapmış.',
        participant: { user: participant.user, slotTitle: participant.slot?.title, checkedInAt: participant.checkedInAt }
      })
    }

    await prisma.dropInParticipant.update({
      where: { id: participant.id },
      data: { checkedIn: true, checkedInAt: new Date() }
    })

    return res.json({
      success: true,
      message: 'Check-in başarılı!',
      participant: { user: participant.user, slotTitle: participant.slot?.title, checkedInAt: new Date() }
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
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
