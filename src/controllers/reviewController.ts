import { Request, Response } from 'express'
import prisma from '../utils/prisma'
import { clampStr } from '../utils/validate'

// Yorum ekle (auth required)
export const createReview = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId
    const bookingId = parseInt(req.body.bookingId)
    const rating = parseInt(req.body.rating)
    const { comment, isAnonymous } = req.body

    if (!bookingId || isNaN(bookingId) || !rating || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Geçerli bir puan (1-5) ve rezervasyon gerekli.' })
    }

    // Booking kullanıcıya ait mi?
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: { session: { include: { class: true } } }
    })
    if (!booking || booking.userId !== userId) {
      return res.status(403).json({ error: 'Bu rezervasyon size ait değil.' })
    }
    if (booking.status !== 'confirmed') {
      return res.status(400).json({ error: 'Yalnızca tamamlanan rezervasyonlar için yorum yapılabilir.' })
    }

    // Ders henüz gerçekleşmediyse yorum yapılamaz (gitmeden/erken yorum engeli)
    const startsAt = booking.session?.startsAt
    if (startsAt && new Date(startsAt).getTime() > Date.now()) {
      return res.status(400).json({ error: 'Ders henüz gerçekleşmedi. Dersten sonra yorum yapabilirsiniz.' })
    }

    // Zaten yorum var mı?
    const existing = await prisma.review.findUnique({ where: { bookingId } })
    if (existing) {
      return res.status(400).json({ error: 'Bu rezervasyon için zaten yorum yaptınız.' })
    }

    const venueId = booking.session?.class?.venueId

    const review = await prisma.review.create({
      data: {
        bookingId,
        reviewerUserId: userId,
        targetType: 'venue',
        venueId: venueId || null,
        rating,
        comment: clampStr(comment, 1000) || null,
        isAnonymous: isAnonymous ?? true,
      }
    })

    // Venue avgRating güncelle
    if (venueId) {
      const reviews = await prisma.review.findMany({ where: { venueId }, select: { rating: true } })
      const avg = reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length
      await prisma.venue.update({
        where: { id: venueId },
        data: { avgRating: Math.round(avg * 10) / 10, totalReviews: reviews.length }
      })
    }

    return res.status(201).json({ message: 'Yorumunuz eklendi!', review })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// Salon yanıtı (venue auth)
export const replyToReview = async (req: Request, res: Response) => {
  try {
    const venueId = (req as any).venueId
    const reviewId = parseInt(req.params.id as string)
    const { reply } = req.body

    if (!reply?.trim()) return res.status(400).json({ error: 'Yanıt boş olamaz.' })
    if (reply.length > 1000) return res.status(400).json({ error: 'Yanıt en fazla 1000 karakter olabilir.' })

    const review = await prisma.review.findUnique({ where: { id: reviewId } })
    if (!review || review.venueId !== venueId) {
      return res.status(403).json({ error: 'Bu yoruma yanıt verme yetkiniz yok.' })
    }

    const updated = await prisma.review.update({
      where: { id: reviewId },
      data: { venueReply: reply.trim(), venueRepliedAt: new Date() }
    })

    return res.json({ message: 'Yanıtınız kaydedildi.', review: updated })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// Salon yanıtını sil (venue auth)
export const deleteReviewReply = async (req: Request, res: Response) => {
  try {
    const venueId = (req as any).venueId
    const reviewId = parseInt(req.params.id as string)

    const review = await prisma.review.findUnique({ where: { id: reviewId } })
    if (!review || review.venueId !== venueId) {
      return res.status(403).json({ error: 'Yetki yok.' })
    }

    await prisma.review.update({
      where: { id: reviewId },
      data: { venueReply: null, venueRepliedAt: null }
    })

    return res.json({ message: 'Yanıt silindi.' })
  } catch (err) {
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// Salon yorumlarını getir (public)
export const getVenueReviews = async (req: Request, res: Response) => {
  try {
    const venueId = parseInt(req.params.venueId as string)

    const reviews = await prisma.review.findMany({
      where: { venueId },
      include: {
        reviewer: { select: { fullName: true, username: true, avatarUrl: true } }
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    })

    const safeReviews = reviews.map(r => r.isAnonymous ? { ...r, reviewer: null } : r)

    return res.json({ reviews: safeReviews })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}
