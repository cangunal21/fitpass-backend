import { Request, Response } from 'express'
import prisma from '../utils/prisma'
import crypto from 'crypto'
import { sendVenueBookingNotificationEmail, sendCancellationEmail, sendVenueCancellationEmail, sendBookingConfirmationEmail, sendGroupTagNotificationEmail, sendGroupInviteEmail, sendCashbackEmail, sendTransferEmail } from '../utils/email'
import { sendPushNotification } from '../utils/push'
import { completeReferral } from './referralController'
import { resetYearlyPointsIfNeeded } from '../utils/tier'

class BookingError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

// Parayı kuruş hassasiyetinde yuvarla — ikili kayan-nokta sapmasını (0.1+0.2 vb.) önler.
// (Ödeme entegrasyonu eklenince tüm para alanları Int-kuruş'a taşınmalı.)
const money = (x: number) => Math.round(x * 100) / 100

// Rezervasyon oluştur
export const createBooking = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId
    const { sessionId: rawSessionId, notes, groupSize: rawGroupSize, taggedUsernames, couponCode } = req.body
    const sessionId = parseInt(rawSessionId)
    const groupSize = Math.max(1, Math.min(parseInt(rawGroupSize) || 1, 10))
    const rawTags: string[] = Array.isArray(taggedUsernames) ? taggedUsernames.slice(0, groupSize - 1) : []
    // normalize: strip @ prefix, lowercase
    const cleanTags = rawTags.map((u: string) => u.replace(/^@/, '').toLowerCase().trim()).filter(Boolean)

    if (!sessionId || isNaN(sessionId)) {
      return res.status(400).json({ error: 'Geçerli bir ders seansı gerekli.' })
    }

    let coupon: { id: number; discountType: string; discountValue: number } | null = null
    let couponDiscount = 0
    let finalAmount = 0
    let booking: any

    // Puanlar yıllık sıfırlanır; kazandırmadan önce yıl damgasını güncelle
    await resetYearlyPointsIfNeeded(userId)

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

        // Kapasite = onaylı/bekleyen rezervasyonların groupSize TOPLAMI
        // (satır sayısı değil — bir rezervasyon birden çok kişilik olabilir, grup rezervasyonunda overbooking olmasın diye)
        const occupancy = await tx.booking.aggregate({
          where: { sessionId, status: { in: ['confirmed', 'pending'] } },
          _sum: { groupSize: true },
        })
        const occupied = occupancy._sum.groupSize || 0

        if (session.availableSpots != null && occupied + groupSize > session.availableSpots) {
          const remaining = session.availableSpots - occupied
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
            ? money(basePrice * (found.discountValue / 100))
            : Math.min(found.discountValue, basePrice)
        }

        const userWithTier = await tx.user.findUnique({
          where: { id: userId },
          select: { tier: { select: { pointRate: true } } },
        })

        finalAmount = money(Math.max(0, basePrice - couponDiscount))

        // Salon her zaman tam hak edişini alır; sadece salonun kendi kuponu payoutu etkiler.
        const venuePayout = money(Math.max(0, basePrice - couponDiscount))

        // Ödenen tutar üzerinden, kullanıcının tier'ına göre PUAN kazandırılır (ödüllerde kullanılır, indirim değil)
        const pointRate = userWithTier?.tier?.pointRate || 0
        const pointsEarned = finalAmount > 0 ? Math.round(finalAmount * (pointRate / 100)) : 0

        const created = await tx.booking.create({
          data: {
            userId,
            sessionId,
            bookingType: 'class',
            status: 'confirmed',
            notes: notes || null,
            groupSize,
            baseAmount: basePrice,
            discountAmount: couponDiscount,
            commissionAmount: 0,
            userCommission: 0,
            venueCommission: 0,
            finalAmount,
            venuePayout,
            pointsEarned,
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
        if (pointsEarned > 0) {
          await tx.user.update({
            where: { id: userId },
            data: { rewardPoints: { increment: pointsEarned } },
          })
          await tx.rewardPoint.create({
            data: { userId, points: pointsEarned, source: 'booking', bookingId: created.id },
          })
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

        const occ = await prisma.booking.aggregate({
          where: { sessionId, status: { in: ['confirmed', 'pending'] } },
          _sum: { groupSize: true },
        })
        const occupiedSpots = occ._sum.groupSize || 0

        await sendVenueBookingNotificationEmail(
          venue.email,
          venue.name,
          user?.fullName || 'Kullanıcı',
          booking.session!.class.title,
          date,
          time,
          booking.session!.availableSpots ?? 0,
          (booking.session!.availableSpots ?? 0) - occupiedSpots
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

    // Puan kazanıldıysa bilgilendirme (e-posta + push)
    if (booking.pointsEarned > 0) {
      try {
        const u = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, fullName: true, rewardPoints: true, pushToken: true } })
        if (u?.email) {
          await sendCashbackEmail(u.email, u.fullName, booking.pointsEarned, booking.session!.class.title, u.rewardPoints)
        }
        if (u?.pushToken) {
          sendPushNotification(u.pushToken, 'Puan kazandın! 🎉', `${booking.session!.class.title} rezervasyonundan ${booking.pointsEarned} puan kazandın.`).catch(() => {})
        }
      } catch (cbErr) {
        console.error('Cashback notify error:', cbErr)
      }
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

    res.status(201).json({ message: 'Rezervasyon başarıyla oluşturuldu!', booking, taggedCount: cleanTags.length, pointsEarned: booking.pointsEarned })
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
    if (isNaN(slotId)) return res.status(400).json({ error: 'Geçersiz slot.' })

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
    const refundAmount = refundType === 'full' ? booking.finalAmount : money((booking.finalAmount || 0) / 2)

    const updated = await prisma.$transaction(async (tx) => {
      const result = await tx.booking.update({
        where: { id: bookingId },
        data: {
          status: 'cancelled',
          notes: `${booking.notes ? booking.notes + ' | ' : ''}İptal: ${refundType === 'full' ? 'Tam iade' : 'Yarım iade'} (₺${refundAmount})`
        },
      })

      // Rezervasyon gerçekleşmediği için kazandığı puanı geri al
      if (booking.pointsEarned > 0) {
        await tx.user.update({
          where: { id: userId },
          data: { rewardPoints: { decrement: booking.pointsEarned } },
        })
        await tx.rewardPoint.create({
          data: { userId, points: -booking.pointsEarned, source: 'booking_cancelled', bookingId: booking.id },
        })
      }

      return result
    })

    // İptal email bildirimleri
    try {
      const fullBooking = await prisma.booking.findUnique({
        where: { id: bookingId },
        include: {
          user: { select: { fullName: true, email: true, pushToken: true } },
          session: { include: { class: { include: { venue: { select: { email: true, name: true } } } } } },
        },
      })

      if (fullBooking) {
        const startsAt = new Date(fullBooking.session!.startsAt)
        const date = startsAt.toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' })
        const time = startsAt.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })
        const classTitle = fullBooking.session!.class.title
        const venue = fullBooking.session!.class.venue

        // Kullanıcıya iptal bildirimi (e-posta + push)
        if (fullBooking.user?.email) {
          await sendCancellationEmail(fullBooking.user.email, fullBooking.user.fullName, classTitle, date, time)
        }
        if (fullBooking.user?.pushToken) {
          sendPushNotification(fullBooking.user.pushToken, 'Rezervasyon iptal edildi', `${classTitle} · ${date} ${time} iptal edildi. ${refundType === 'full' ? 'Tam' : 'Yarım'} iade uygulandı.`).catch(() => {})
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

// Bir rezervasyon için uygun transfer hedeflerini getir
// Kural: aynı salon, gelecekte, açık, fiyatı aynı veya daha ucuz, kapasitenin %50+'si boş ve grup sığıyor
export const getTransferOptions = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId
    const bookingId = parseInt(req.params.id as string)

    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: { session: { include: { class: true } } },
    })
    if (!booking || booking.userId !== userId) return res.status(404).json({ error: 'Rezervasyon bulunamadı.' })
    if (booking.bookingType !== 'class' || !booking.session) return res.status(400).json({ error: 'Bu rezervasyon transfer edilemez.' })
    if (booking.status !== 'confirmed') return res.status(400).json({ error: 'Sadece aktif rezervasyonlar transfer edilebilir.' })

    const venueId = booking.session.class.venueId
    const oldBasePrice = booking.session.class.basePrice
    const groupSize = booking.groupSize

    // Aynı salonun gelecekteki açık seansları (aynı/daha ucuz fiyat)
    const sessions = await prisma.class_Session.findMany({
      where: {
        status: 'open',
        startsAt: { gt: new Date() },
        id: { not: booking.sessionId! },
        class: { venueId, isActive: true, basePrice: { lte: oldBasePrice } },
      },
      include: { class: { select: { title: true, basePrice: true, capacity: true } } },
      orderBy: { startsAt: 'asc' },
    })

    // Her seans için doluluk hesapla (groupSize toplamı) ve %50 + grup sığma filtresini uygula
    const options = []
    for (const s of sessions) {
      const occ = await prisma.booking.aggregate({
        where: { sessionId: s.id, status: { in: ['confirmed', 'pending'] } },
        _sum: { groupSize: true },
      })
      const occupied = occ._sum.groupSize || 0
      const capacity = s.availableSpots || 0
      const available = capacity - occupied
      const alreadyIn = await prisma.booking.findFirst({
        where: { sessionId: s.id, userId, status: { in: ['confirmed', 'pending'] } },
      })
      if (alreadyIn) continue
      if (capacity > 0 && available >= Math.ceil(capacity * 0.5) && available >= groupSize) {
        options.push({
          sessionId: s.id,
          title: s.class.title,
          basePrice: s.class.basePrice,
          startsAt: s.startsAt,
          endsAt: s.endsAt,
          available,
          capacity,
          priceRefund: Math.max(0, (oldBasePrice - s.class.basePrice) * groupSize),
        })
      }
    }

    return res.json({ options })
  } catch (err) {
    console.error('getTransferOptions error:', err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// Rezervasyonu başka bir seansa transfer et (aynı salon, aynı/ucuz, %50+ boş)
export const transferBooking = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId
    const bookingId = parseInt(req.params.id as string)
    const { targetSessionId } = req.body
    if (!targetSessionId) return res.status(400).json({ error: 'Hedef seans gerekli.' })

    let result: any
    try {
      result = await prisma.$transaction(async (tx) => {
        const booking = await tx.booking.findUnique({
          where: { id: bookingId },
          include: { session: { include: { class: true } } },
        })
        if (!booking || booking.userId !== userId) throw new BookingError('Rezervasyon bulunamadı.', 404)
        if (booking.bookingType !== 'class' || !booking.session) throw new BookingError('Bu rezervasyon transfer edilemez.', 400)
        if (booking.status !== 'confirmed') throw new BookingError('Sadece aktif rezervasyonlar transfer edilebilir.', 400)
        if (booking.checkedIn) throw new BookingError('Check-in yapılmış rezervasyon transfer edilemez.', 400)
        if (booking.sessionId === targetSessionId) throw new BookingError('Zaten bu seanstasınız.', 400)
        if (new Date(booking.session.startsAt) <= new Date()) throw new BookingError('Başlamış ders transfer edilemez.', 400)

        // İki seansı da kilitle (deadlock önlemek için id sırasına göre)
        const ids = [booking.sessionId!, targetSessionId].sort((a, b) => a - b)
        await tx.$executeRaw`SELECT id FROM "Class_Session" WHERE id IN (${ids[0]}, ${ids[1]}) ORDER BY id FOR UPDATE`

        const target = await tx.class_Session.findUnique({
          where: { id: targetSessionId },
          include: { class: true },
        })
        if (!target) throw new BookingError('Hedef seans bulunamadı.', 404)
        if (target.status !== 'open') throw new BookingError('Hedef seans açık değil.', 400)
        if (new Date(target.startsAt) <= new Date()) throw new BookingError('Geçmiş bir seansa transfer yapılamaz.', 400)

        // Aynı salon kontrolü
        if (target.class.venueId !== booking.session.class.venueId) {
          throw new BookingError('Sadece aynı salon içinde transfer yapılabilir.', 400)
        }

        const groupSize = booking.groupSize
        const oldBase = booking.baseAmount
        const newBase = target.class.basePrice * groupSize

        // Aynı veya daha ucuz olmalı
        if (newBase > oldBase) {
          throw new BookingError('Sadece aynı veya daha uygun fiyatlı derslere transfer yapabilirsiniz.', 400)
        }

        // Zaten hedefte kayıtlı mı?
        const alreadyIn = await tx.booking.findFirst({
          where: { sessionId: targetSessionId, userId, status: { in: ['confirmed', 'pending'] } },
        })
        if (alreadyIn) throw new BookingError('Bu seansta zaten rezervasyonunuz var.', 400)

        // Hedef kapasite: %50+ boş ve grup sığmalı
        const occ = await tx.booking.aggregate({
          where: { sessionId: targetSessionId, status: { in: ['confirmed', 'pending'] } },
          _sum: { groupSize: true },
        })
        const occupied = occ._sum.groupSize || 0
        const capacity = target.availableSpots || 0
        const available = capacity - occupied
        if (capacity <= 0 || available < Math.ceil(capacity * 0.5)) {
          throw new BookingError('Hedef dersin en az yarısı dolu, transfer yapılamıyor.', 400)
        }
        if (available < groupSize) {
          throw new BookingError('Hedef derste yeterli yer yok.', 400)
        }

        // Finansal yeniden hesap (salon kuponu korunur)
        const couponDiscount = money(Math.max(0, oldBase - booking.venuePayout))
        const newVenuePayout = money(Math.max(0, newBase - couponDiscount))
        const newFinalAmount = money(Math.max(0, newBase - couponDiscount))
        const priceRefund = money(Math.max(0, oldBase - newBase)) // daha ucuz derse geçişte iade edilecek fark (ödeme entegrasyonunda karta iade)

        const updated = await tx.booking.update({
          where: { id: bookingId },
          data: {
            sessionId: targetSessionId,
            baseAmount: newBase,
            venuePayout: newVenuePayout,
            finalAmount: newFinalAmount,
            discountAmount: couponDiscount,
            notes: `${booking.notes ? booking.notes + ' | ' : ''}Transfer edildi${priceRefund > 0 ? ` (₺${priceRefund} iade)` : ''}`,
          },
          include: { session: { include: { class: true } } },
        })

        return { updated, priceRefund }
      })
    } catch (e: any) {
      if (e instanceof BookingError) return res.status(e.status).json({ error: e.message })
      throw e
    }

    // Bilgilendirme (e-posta + push) (yeni ders + varsa kredi iadesi)
    try {
      const u = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, fullName: true, pushToken: true } })
      const sess = result.updated.session
      if (sess) {
        const startsAt = new Date(sess.startsAt)
        const date = startsAt.toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' })
        const time = startsAt.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })
        if (u?.email) await sendTransferEmail(u.email, u.fullName, sess.class.title, date, time, result.priceRefund)
        if (u?.pushToken) {
          const refundTxt = result.priceRefund > 0 ? ` ₺${result.priceRefund} kredi iade edildi.` : ''
          sendPushNotification(u.pushToken, 'Dersin değiştirildi 🔄', `${sess.class.title} · ${date} ${time}.${refundTxt}`).catch(() => {})
        }
      }
    } catch (mailErr) {
      console.error('Transfer notify error:', mailErr)
    }

    return res.json({
      message: result.priceRefund > 0
        ? `Rezervasyon transfer edildi. ₺${result.priceRefund} fiyat farkı kredinize iade edildi.`
        : 'Rezervasyon başarıyla transfer edildi.',
      booking: result.updated,
      priceRefund: result.priceRefund,
    })
  } catch (err) {
    console.error('transferBooking error:', err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
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
