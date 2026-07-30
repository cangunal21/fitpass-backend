import { Request, Response } from 'express'
import prisma from '../utils/prisma'
import crypto from 'crypto'
import { sendVenueBookingNotificationEmail, sendCancellationEmail, sendVenueCancellationEmail, sendBookingConfirmationEmail, sendGroupTagNotificationEmail, sendGroupInviteEmail, sendCashbackEmail, sendTransferEmail } from '../utils/email'
import { sendPushNotification } from '../utils/push'
import { completeReferral } from './referralController'
import { resetYearlyPointsIfNeeded } from '../utils/tier'
import { clampStr } from '../utils/validate'
import { stripVenueSensitive } from '../utils/sanitize'
import { trDate, trTime } from "../utils/trFormat"

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
    // normalize: @ temizle + küçült + TEKİLLEŞTİR (aynı kişi 2 kez etiketlenip çift bildirim almasın)
    let cleanTags = [...new Set(rawTags.map((u: string) => u.replace(/^@/, '').toLowerCase().trim()).filter(Boolean))]
    // Kendini etiketleme: kişi kendini davet edemez (kendine "davet edildin" bildirimi gitmesin)
    if (cleanTags.length) {
      const me = await prisma.user.findUnique({ where: { id: userId }, select: { username: true } })
      if (me?.username) cleanTags = cleanTags.filter(u => u !== me.username!.toLowerCase())
    }
    // GAMING ÖNLEME: etiketleri GERÇEK (banlı olmayan) kullanıcılara indirge → var olmayan/banlı
    // kullanıcı ('asdf' gibi) etiketleyip "Takım" rozeti oyunlanamaz. taggedFriends yalnız gerçek
    // kullanıcıları tutar (bildirim döngüsüyle aynı case-insensitive eşleşme).
    if (cleanTags.length) {
      const realUsers = await prisma.user.findMany({
        where: { banned: false, OR: cleanTags.map(u => ({ username: { equals: u, mode: 'insensitive' as const } })) },
        select: { username: true },
      })
      const realSet = new Set(realUsers.map(u => u.username.toLowerCase()))
      cleanTags = cleanTags.filter(u => realSet.has(u))
    }

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
          include: { class: { include: { venue: { select: { isActive: true, isApproved: true } } } } },
        })

        if (!session) throw new BookingError('Ders seansı bulunamadı.', 404)
        // Geçmiş/başlamış seansa rezervasyon yapılamaz — aksi halde geçmiş seansı booklayıp
        // (katılmadan) yorum kilidini (startsAt < now) baypas edip sahte yorum yazılabilirdi.
        if (new Date(session.startsAt) <= new Date()) {
          throw new BookingError('Bu seans başlamış, rezervasyon yapılamaz.', 400)
        }
        // Donmuş/onaysız salonun seansına (eski linkle) rezervasyon yapılamaz
        if (!session.class.venue || !session.class.venue.isActive || !session.class.venue.isApproved) {
          throw new BookingError('Bu salon şu anda rezervasyona kapalı.', 400)
        }
        // Salon KAPATTIĞI ders (isActive=false) ya da kapalı seans hâlâ ayakta olan sessionId'siyle booklanamaz —
        // aksi halde tüm listelerden gizlenen ders eski/enumerate edilmiş linkle rezerve edilir (kapasite yanar + puan kazanılır).
        if (!session.class.isActive) throw new BookingError('Bu ders şu anda rezervasyona kapalı.', 400)
        if (session.status !== 'open') throw new BookingError('Bu seans rezervasyona kapalı.', 400)

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
          // Kişi başı limit: bu kullanıcının bu kuponu kaç aktif (iptal edilmemiş) rezervasyonda kullandığını say.
          // Kupon satırı FOR UPDATE ile kilitli → eşzamanlı ikinci kullanım da bu kontrolde yakalanır.
          if (found.perUserLimit != null) {
            const myUses = await tx.booking.count({ where: { couponId: found.id, userId, status: { not: 'cancelled' } } })
            if (myUses >= found.perUserLimit) throw new BookingError('Bu kuponu daha fazla kullanamazsınız (kişi başı limit doldu).', 400)
          }
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
            notes: clampStr(notes, 500) || null,
            groupSize,
            baseAmount: money(basePrice), // money() ile yuvarla (finalAmount/venuePayout gibi) — grup×ondalık fiyatta float tozu kalmasın
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

        // Rezervasyon yapan kullanıcı bu seansın bekleme listesindeyse çıkar
        // (aksi halde hem "kayıtlı" hem "bekliyor" kalır → şişik sayaç + onWaitlist:true)
        await tx.waitlist.deleteMany({ where: { userId, sessionId } })

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
        const date = trDate(startsAt)
        const time = trTime(startsAt)

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
        const date = trDate(startsAt)
        const time = trTime(startsAt)
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
        const date = trDate(startsAt)
        const time = trTime(startsAt)
        const venueName = booking.session!.class.venueId
          ? (await prisma.venue.findUnique({ where: { id: booking.session!.class.venueId }, select: { name: true } }))?.name || ''
          : ''

        const categoryName = booking.session!.class.category || booking.session!.class.title

        for (const username of cleanTags) {
          const taggedUser = await prisma.user.findFirst({
            where: { username: { equals: username, mode: 'insensitive' }, banned: false },
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
        reviews: true, // salon + hoca ayrı satır (targetType)
      },
      orderBy: { createdAt: 'desc' },
      take: 200, // tüm ömür-boyu booking geçmişi derin include'la tek yanıtta yüklenmesin
    })

    const safeBookings = bookings.map(b => ({
      ...b,
      session: b.session ? {
        ...b.session,
        class: b.session.class ? {
          ...b.session.class,
          // ÖNCEDEN yalnız passwordHash siliniyordu → IBAN/TCKN/vergi no/İyzico alt-üye anahtarı/KYC
          // müşteriye SIZIYORDU. stripVenueSensitive TÜM ödeme/KYC alanlarını temizler.
          venue: b.session.class.venue ? stripVenueSensitive(b.session.class.venue) : null,
        } : null,
      } : null,
      dropInSlot: b.dropInSlot ? {
        ...b.dropInSlot,
        venue: b.dropInSlot.venue ? stripVenueSensitive(b.dropInSlot.venue) : null,
      } : null,
      // Geriye dönük uyum: eski istemci `review` (tekil, salon yorumu) bekliyor + yeni `reviewed` bayrağı
      review: (b as any).reviews?.find((r: any) => r.targetType === 'venue') || null,
      reviewed: ((b as any).reviews?.length || 0) > 0,
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

        const slot = await tx.dropInSlot.findUnique({
          where: { id: slotId },
          include: { venue: { select: { isActive: true, isApproved: true } } },
        })
        if (!slot) throw new BookingError('Slot bulunamadı.', 404)
        if (!slot.venue || !slot.venue.isActive || !slot.venue.isApproved) {
          throw new BookingError('Bu salon şu anda rezervasyona kapalı.', 400)
        }
        if (slot.status !== 'open') throw new BookingError('Bu slot artık açık değil.', 400)
        if (new Date(slot.startsAt) <= new Date()) throw new BookingError('Bu slot başlamış, katılım yapılamaz.', 400)
        // ÖZEL slot: yalnız geçerli davet koduyla katılınır. Aksi halde herkes slotId enumerate edip
        // özel maça (privateCode hiç sorulmadan) girebiliyordu — listeleme gizliyor ama join kontrolü yoktu.
        if (slot.visibility === 'private') {
          const code = String(req.body?.privateCode || req.body?.code || '').trim().toUpperCase()
          if (!slot.privateCode || code !== slot.privateCode.toUpperCase()) {
            throw new BookingError('Bu özel maça katılmak için geçerli davet kodu gerekli.', 403)
          }
        }
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

    // (İade tipi/tutarı artık transaction İÇİNDE, taze satırdan hesaplanıyor — aşağıya bak.)

    // NOT: yukarıdaki `booking` yalnızca ERKEN REDDETME içindir (404/403/zaten-iptal/12-saat).
    // İptal MATEMATİĞİ transaction içindeki TAZE ve KİLİTLİ satırdan türetilir — aşağıya bak.
    const outcome = await prisma.$transaction(async (tx) => {
      // KİLİT SIRASI (tüm kod tabanında aynı olmalı): User → Class_Session → Booking → Coupon.
      // Eskiden burası Booking(CAS) → User → Coupon, purgeBookingsForSessions ise User → Booking
      // sırasıyla kilitliyordu; ters sıra PostgreSQL deadlock'u (40P01) üretiyordu.
      await tx.$executeRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`
      await tx.$executeRaw`SELECT id FROM "Booking" WHERE id = ${bookingId} FOR UPDATE`

      // TAZE OKUMA. Kritik: satır 445'teki okuma transaction DIŞINDA ve kilitsizdi. Araya giren
      // bir transferBooking sessionId/finalAmount/pointsEarned'ı değiştirebiliyor, iptal ise
      // BAYAT değerlerle çalışıp kullanıcının bakiyesinden fazla puan siliyor, yanlış iade tutarı
      // vaat ediyor ve 12-saat kapısını ESKİ seansın saatiyle değerlendiriyordu (politika baypası).
      const fresh = await tx.booking.findUnique({
        where: { id: bookingId },
        include: { session: { select: { startsAt: true } } },
      })
      if (!fresh || fresh.status === 'cancelled') return { kind: 'already' as const }
      if (fresh.userId !== userId) return { kind: 'forbidden' as const }

      // 12-saat kapısı ve iade tutarı TAZE satırdan yeniden hesaplanır.
      const freshHours = fresh.session?.startsAt
        ? (new Date(fresh.session.startsAt).getTime() - Date.now()) / 3600000
        : 999
      if (freshHours < 12) return { kind: 'tooLate' as const, hoursLeft: Math.round(freshHours * 10) / 10 }
      const rType = freshHours >= 24 ? 'full' : 'half'
      const rAmount = rType === 'full' ? fresh.finalAmount : money((fresh.finalAmount || 0) / 2)

      // CAS'i transferBooking:783 ile SİMETRİK yap: yalnız status değil, matematiği besleyen
      // alanları da pinle. Araya giren transfer bunları değiştirdiyse count=0 → hiçbir şey yapma.
      const flip = await tx.booking.updateMany({
        where: {
          id: bookingId,
          status: fresh.status,
          sessionId: fresh.sessionId,
          finalAmount: fresh.finalAmount,
          pointsEarned: fresh.pointsEarned,
          checkedIn: false,
        },
        data: {
          status: 'cancelled',
          notes: `${fresh.notes ? fresh.notes + ' | ' : ''}İptal: ${rType === 'full' ? 'Tam iade' : 'Yarım iade'} (₺${rAmount})`,
        },
      })
      if (flip.count === 0) return { kind: 'conflict' as const }
      const booking = fresh // aşağıdaki geri-alma bloklarının tamamı artık TAZE satırı kullanır
      const refundType = rType
      const refundAmount = rAmount

      // Rezervasyon gerçekleşmediği için kazandığı puanı geri al (yalnızca iptali biz yaptıysak).
      // Bakiyeden FAZLA düşme: yıllık puan sıfırlaması sonrası eski booking iptal edilince
      // bakiye NEGATİFE düşerdi (redemption gelince bedava kredi istismarı). min ile clamp.
      if (booking.pointsEarned > 0) {
        // User satırını FOR UPDATE kilitle → aynı kullanıcının EŞZAMANLI iki iptali serileşir; ikincisi
        // ilkinin düşürdüğü GÜNCEL bakiyeyi okur. Kilitsizken ikisi de stale bakiye okuyup min-clamp'i
        // atlar ve rewardPoints NEGATİFE düşerdi.
        await tx.$executeRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`
        const cur = await tx.user.findUnique({ where: { id: userId }, select: { rewardPoints: true } })
        const dec = Math.min(booking.pointsEarned, cur?.rewardPoints || 0)
        if (dec > 0) {
          await tx.user.update({ where: { id: userId }, data: { rewardPoints: { decrement: dec } } })
          await tx.rewardPoint.create({ data: { userId, points: -dec, source: 'booking_cancelled', bookingId: booking.id } })
        }
      }

      // Kupon kullanımı iptalle geri verilir (aksi halde iptal edilen rezervasyon kuponun
      // maxUses hakkını kalıcı yakar → kupon bir daha kullanılamaz). 0'ın altına inmesin.
      if (booking.couponId) {
        await tx.coupon.updateMany({
          where: { id: booking.couponId, usedCount: { gt: 0 } },
          data: { usedCount: { decrement: 1 } },
        })
      }

      // FARMING ENGELİ (iptal-tarafı): completeReferral ödülü davet edilenin İLK ÜCRETLİ dersinde iki tarafa
      // +100 verir. Bu ders iptal edilip kullanıcının başka (iptal edilmemiş) ücretli booking'i KALMADIYSA ödül
      // artık GMV'ye bağlı değil → iki taraftan da +100 geri alınır ve referral 'pending'e döner (ileride gerçek
      // ücretli derste yeniden hak edilir). Hesap-silmedeki referral_reversed ile simetrik; iptal-tarafı eksikti.
      if ((booking.finalAmount || 0) > 0) {
        const otherPaid = await tx.booking.count({ where: { userId, finalAmount: { gt: 0 }, status: { not: 'cancelled' }, id: { not: bookingId } } })
        if (otherPaid === 0) {
          const ref = await tx.referral.findFirst({ where: { referredId: userId, status: 'completed', referredBonusGranted: true }, select: { id: true, referrerId: true, referredId: true } })
          if (ref) {
            const flip2 = await tx.referral.updateMany({ where: { id: ref.id, status: 'completed' }, data: { status: 'pending', completedAt: null, referredBonusGranted: false } })
            if (flip2.count === 1) {
              const REFERRAL_POINTS = 100 // referralController ile senkron
              for (const uid of [ref.referrerId, ref.referredId]) {
                await tx.$executeRaw`SELECT id FROM "User" WHERE id = ${uid} FOR UPDATE`
                const u = await tx.user.findUnique({ where: { id: uid }, select: { rewardPoints: true } })
                const dec = Math.min(REFERRAL_POINTS, u?.rewardPoints || 0)
                if (dec > 0) {
                  await tx.user.update({ where: { id: uid }, data: { rewardPoints: { decrement: dec } } })
                  await tx.rewardPoint.create({ data: { userId: uid, points: -dec, source: 'referral_reversed_cancel' } })
                }
              }
            }
          }
        }
      }

      return {
        kind: 'ok' as const,
        booking: await tx.booking.findUnique({ where: { id: bookingId } }),
        refundType, refundAmount, sessionId: fresh.sessionId,
      }
    })

    if (outcome.kind === 'already') return res.status(400).json({ error: 'Rezervasyon zaten iptal edilmiş.' })
    if (outcome.kind === 'forbidden') return res.status(403).json({ error: 'Bu rezervasyonu iptal edemezsiniz.' })
    if (outcome.kind === 'tooLate') return res.status(400).json({ error: 'Derse 12 saatten az kaldığı için iptal yapılamaz.', hoursLeft: outcome.hoursLeft })
    // Araya giren bir transfer rezervasyonu değiştirdi → istemci tazeleyip tekrar denemeli.
    if (outcome.kind === 'conflict') return res.status(409).json({ error: 'Rezervasyon bu sırada değişti. Sayfayı yenileyip tekrar deneyin.' })
    const updated = outcome.booking
    const refundType = outcome.refundType
    const refundAmount = outcome.refundAmount

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
        const date = trDate(startsAt)
        const time = trTime(startsAt)
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
      // TAZE sessionId: bayat okumadan gelirse boşalan yer YANLIŞ seansa duyurulur ve gerçek
      // boşluk hiç ilan edilmez.
      await notifyFirstWaitlistUser(outcome.sessionId!)
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
      take: 100, // seans başına 2 sorgu döngüsü var → aday seans sayısını sınırla (N+1 patlamasını kes)
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

    // Transfer de puan YAZAN bir yol (pahalıya geçişte pointsDelta>0). createBooking'deki gibi yıl
    // damgasını önce tazele; aksi halde yeni yılda eklenen puan bir sonraki getMe'de eski bakiyeyle
    // birlikte sıfırlanır ama RewardPoint defter satırı kalır (bakiye/defter çelişkisi).
    await resetYearlyPointsIfNeeded(userId)

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

        // Finansal yeniden hesap — kuponu TİPİYLE yeni baza uygula. ESKİ kod indirimi MUTLAK
        // (oldBase − venuePayout) alıp küçük yeni baza uyguluyordu → YÜZDE kuponu dev mutlak indirime donup
        // salonu eksik ödüyor, kullanıcıyı fazla iade ediyordu (üst üste transferde bedava derse kadar).
        let couponDiscount = 0
        if (booking.couponId) {
          const bc = await tx.coupon.findUnique({ where: { id: booking.couponId }, select: { discountType: true, discountValue: true } })
          if (bc) {
            couponDiscount = bc.discountType === 'percent'
              ? money(newBase * (bc.discountValue / 100))
              : Math.min(bc.discountValue, newBase)
          } else if (oldBase > 0) {
            // kupon satırı silinmiş (nadir) → eski EFEKTİF oranı koru (yüzde-eşdeğeri)
            couponDiscount = money(newBase * (Math.max(0, oldBase - booking.venuePayout) / oldBase))
          }
        }
        const newVenuePayout = money(Math.max(0, newBase - couponDiscount))
        const newFinalAmount = money(Math.max(0, newBase - couponDiscount))
        // İade = ÖDENEN (finalAmount) − yeni borç (newFinalAmount); baz farkı DEĞİL, yoksa kupon
        // (özellikle yüzde) kullanan kullanıcıya fazla iade çıkardı. (ödeme entegrasyonunda karta iade)
        const priceRefund = money(Math.max(0, booking.finalAmount - newFinalAmount))

        // Puanı yeni (daha ucuz olabilen) tutara göre yeniden hesapla. Aksi halde pahalı ders
        // bookla → ucuza transfer et → fazla puanı tut (redemption gelince istismar) + pointsEarned
        // bayat kalır. rewardPoints bakiyesi de farkla eşitlenir.
        const uTier = await tx.user.findUnique({ where: { id: userId }, select: { tier: { select: { pointRate: true } } } })
        const newPoints = newFinalAmount > 0 ? Math.round(newFinalAmount * ((uTier?.tier?.pointRate || 0) / 100)) : 0
        const pointsDelta = newPoints - booking.pointsEarned

        // CAS: yalnızca booking HÂLÂ beklenen durumdaysa (confirmed, kaynak seansta, check-in yok)
        // taşı. booking kilitten önce okundu; eşzamanlı iptal/transfer bu arada durumu değiştirdiyse
        // (count=0) stale veriyle çift işlem yapmadan çakışma döndür (ödeme gelince priceRefund
        // gerçek iadeye dönüşünce çift-iade de böyle önlenir).
        const flip = await tx.booking.updateMany({
          where: { id: bookingId, status: 'confirmed', sessionId: booking.sessionId, checkedIn: false },
          data: {
            sessionId: targetSessionId,
            baseAmount: money(newBase),
            venuePayout: newVenuePayout,
            finalAmount: newFinalAmount,
            discountAmount: couponDiscount,
            pointsEarned: newPoints,
            notes: `${booking.notes ? booking.notes + ' | ' : ''}Transfer edildi${priceRefund > 0 ? ` (₺${priceRefund} iade)` : ''}`,
          },
        })
        if (flip.count === 0) throw new BookingError('Rezervasyon durumu değişti, transfer yapılamadı. Lütfen tekrar deneyin.', 409)

        // Puan farkını bakiyeye yansıt (ucuz derse geçişte fazla puan geri alınır) + audit satırı.
        // NEGATİF fark bakiyeyi NEGATİFE düşürmesin (cancelBooking ile aynı invariant): kilitle + clamp.
        if (pointsDelta !== 0) {
          let applied = pointsDelta
          if (pointsDelta < 0) {
            await tx.$executeRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`
            const cur = await tx.user.findUnique({ where: { id: userId }, select: { rewardPoints: true } })
            applied = -Math.min(-pointsDelta, cur?.rewardPoints || 0)
          }
          if (applied !== 0) {
            await tx.user.update({ where: { id: userId }, data: { rewardPoints: { increment: applied } } })
            await tx.rewardPoint.create({ data: { userId, points: applied, source: 'booking_transfer', bookingId } })
          }
        }
        const updated = await tx.booking.findUnique({
          where: { id: bookingId },
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
        const date = trDate(startsAt)
        const time = trTime(startsAt)
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
        slot: { select: { title: true, venueId: true, startsAt: true, endsAt: true } }
      }
    })

    if (!participant) {
      return res.status(404).json({ error: 'Geçersiz kod. Katılım bulunamadı.' })
    }

    if (participant.slot?.venueId !== venueId) {
      return res.status(403).json({ error: 'Bu katılım salonunuza ait değil.' })
    }

    // ZAMAN PENCERESİ: checkInBooking (satır ~941) ve checkInInstructorBooking bu kapıyı uygularken
    // drop-in'de HİÇ yoktu — kod geçmişte ya da haftalar sonrasında istenildiği an okutulabiliyordu.
    // Salon, gelecekteki katılımları toplu check-in'leyip katılımcıların serisini/rozetini şişirebilir,
    // kullanıcı da gelmediği bir etkinliği sonradan "gitmiş" gösterebilirdi.
    const dSt = participant.slot?.startsAt ? new Date(participant.slot.startsAt).getTime() : null
    const dEn = participant.slot?.endsAt ? new Date(participant.slot.endsAt).getTime() : null
    const dNow = Date.now()
    if (dSt != null && dNow < dSt - 60 * 60000) return res.status(400).json({ error: 'Check-in etkinlik saatine yakın açılır (henüz erken).' })
    if (dEn != null && dNow > dEn + 180 * 60000) return res.status(400).json({ error: 'Check-in süresi doldu.' })

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

    // ATOMİK SAHİPLENME (CAS): checkInBooking ve checkInInstructorBooking bu deseni kullanıyor,
    // burada unutulmuştu. Oku-sonra-yaz olduğu için aynı kod iki kez okutulduğunda İKİ istek de
    // yukarıdaki `participant.checkedIn` kontrolünü geçip ikisine de "Check-in başarılı!" dönüyordu
    // (salon aynı kişiyi iki kez içeri almış sayıyor). count=0 → yarışı kaybettik, zaten yapılmış.
    const claim = await prisma.dropInParticipant.updateMany({
      where: { id: participant.id, checkedIn: false },
      data: { checkedIn: true, checkedInAt: new Date() }
    })
    if (claim.count === 0) {
      const now = await prisma.dropInParticipant.findUnique({ where: { id: participant.id }, select: { checkedInAt: true } })
      return res.json({
        alreadyCheckedIn: true,
        message: 'Bu katılımcı zaten check-in yapmış.',
        participant: { user: participant.user, slotTitle: participant.slot?.title, checkedInAt: now?.checkedInAt }
      })
    }

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

    // ZAMAN PENCERESİ: check-in yalnız ders saati civarında (başlangıç−1sa .. bitiş+3sa). Gelecekteki
    // dersi bugünden check-in'leyip streak/rozet şişirme engellenir; çok geç geriye-dönük check-in de kapalı.
    const st = booking.session?.startsAt ? new Date(booking.session.startsAt).getTime() : null
    const en = booking.session?.endsAt ? new Date(booking.session.endsAt).getTime() : null
    const nowMs = Date.now()
    if (st != null && nowMs < st - 60 * 60000) return res.status(400).json({ error: 'Check-in ders saatine yakın açılır (henüz erken).' })
    if (en != null && nowMs > en + 180 * 60000) return res.status(400).json({ error: 'Check-in süresi doldu.' })

    const already = {
      user: booking.user,
      classTitle: booking.session?.class?.title,
      checkedInAt: booking.checkedInAt,
      groupSize: booking.groupSize,
    }
    if (booking.checkedIn) {
      return res.json({ alreadyCheckedIn: true, message: 'Bu rezervasyon zaten check-in yapılmış.', booking: already })
    }

    // ATOMİK: checkedIn=false→true çevirebilen TEK istek başarılı; eşzamanlı çift-okutma "zaten check-in" alır.
    const claim = await prisma.booking.updateMany({ where: { id: booking.id, checkedIn: false }, data: { checkedIn: true, checkedInAt: new Date() } })
    if (claim.count === 0) {
      return res.json({ alreadyCheckedIn: true, message: 'Bu rezervasyon zaten check-in yapılmış.', booking: already })
    }

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
