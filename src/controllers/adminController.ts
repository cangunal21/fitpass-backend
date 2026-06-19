import { Request, Response } from 'express'
import prisma from '../utils/prisma'
import { sendVenueApprovedEmail } from '../utils/email'

// İstatistikler
export const getStats = async (req: Request, res: Response) => {
  try {
    const [userCount, venueCount, bookingCount, pendingVenues] = await Promise.all([
      prisma.user.count(),
      prisma.venue.count(),
      prisma.booking.count(),
      prisma.venue.count({ where: { isApproved: false } }),
    ])

    return res.json({ stats: { userCount, venueCount, bookingCount, pendingVenues } })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// Tüm salonlar
export const getAllVenues = async (req: Request, res: Response) => {
  try {
    const venues = await prisma.venue.findMany({
      select: {
        id: true, name: true, email: true, phone: true, address: true,
        isApproved: true, avgRating: true, totalReviews: true, createdAt: true,
        _count: { select: { classes: true } }
      },
      orderBy: { createdAt: 'desc' }
    })
    return res.json({ venues })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// Salon onayla / reddet
export const approveVenue = async (req: Request, res: Response) => {
  try {
    const venueId = parseInt(req.params.id as string)
    const { approve } = req.body

    const venue = await prisma.venue.update({
      where: { id: venueId },
      data: { isApproved: approve },
    })

    if (approve) {
      try {
        const venueWithEmail = await prisma.venue.findUnique({ where: { id: venueId }, select: { email: true, name: true } })
        if (venueWithEmail?.email) {
          await sendVenueApprovedEmail(venueWithEmail.email, venueWithEmail.name)
        }
      } catch (e) {
        console.error('Venue approval email error:', e)
      }
    }

    return res.json({ message: approve ? 'Salon onaylandı.' : 'Salon reddedildi.', venue })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// Tüm kullanıcılar
export const getAllUsers = async (req: Request, res: Response) => {
  try {
    const users = await prisma.user.findMany({
      select: {
        id: true, username: true, email: true, fullName: true,
        totalLessonsCompleted: true, rewardPoints: true, createdAt: true,
        _count: { select: { bookings: true } }
      },
      orderBy: { createdAt: 'desc' }
    })
    return res.json({ users })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// Tüm rezervasyonlar
export const getAllBookings = async (req: Request, res: Response) => {
  try {
    const bookings = await prisma.booking.findMany({
      include: {
        user: { select: { fullName: true, email: true } },
        session: {
          include: { class: { include: { venue: { select: { name: true } } } } }
        }
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    })
    return res.json({ bookings })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// Salon dondur/aktif et
export const suspendVenue = async (req: Request, res: Response) => {
  try {
    const venueId = parseInt(req.params.id as string)
    const { suspend } = req.body

    const venue = await prisma.venue.update({
      where: { id: venueId },
      data: { isSuspended: suspend, isActive: !suspend },
    })
    return res.json({ message: suspend ? 'Salon donduruldu.' : 'Salon aktif edildi.', venue })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// Salon sil
export const deleteVenue = async (req: Request, res: Response) => {
  try {
    const venueId = parseInt(req.params.id as string)
    await prisma.venue.delete({ where: { id: venueId } })
    return res.json({ message: 'Salon silindi.' })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// Kullanıcı banla/aktif et
export const banUser = async (req: Request, res: Response) => {
  try {
    const userId = parseInt(req.params.id as string)
    const { ban } = req.body

    const user = await prisma.user.update({
      where: { id: userId },
      data: { emailReminders: ban ? false : true },
    })
    return res.json({ message: ban ? 'Kullanıcı banlandı.' : 'Kullanıcı aktif edildi.', user })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// Tüm kuponlar (admin)
export const getAllCoupons = async (req: Request, res: Response) => {
  try {
    const coupons = await prisma.coupon.findMany({
      include: { venue: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
    })
    return res.json({ coupons })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// Kupon sil (admin)
export const adminDeleteCoupon = async (req: Request, res: Response) => {
  try {
    const couponId = parseInt(req.params.id as string)
    await prisma.coupon.delete({ where: { id: couponId } })
    return res.json({ message: 'Kupon silindi.' })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// Tüm kategoriler (admin)
export const getCategories = async (req: Request, res: Response) => {
  try {
    const categories = await prisma.sportCategory.findMany({ orderBy: { name: 'asc' } })
    return res.json({ categories })
  } catch (err) {
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// Kategori ekle (admin)
export const createCategory = async (req: Request, res: Response) => {
  try {
    const { name, colorHex, iconUrl } = req.body
    if (!name) return res.status(400).json({ error: 'Kategori adı zorunludur.' })
    const existing = await prisma.sportCategory.findFirst({ where: { name: { equals: name, mode: 'insensitive' } } })
    if (existing) return res.status(400).json({ error: 'Bu kategori zaten mevcut.' })
    const category = await prisma.sportCategory.create({ data: { name, colorHex, iconUrl } })
    return res.json({ category })
  } catch (err) {
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// Kategori sil (admin)
export const deleteCategory = async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id as string)
    await prisma.sportCategory.delete({ where: { id } })
    return res.json({ message: 'Kategori silindi.' })
  } catch (err) {
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// Kategori güncelle (admin)
export const updateCategory = async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id as string)
    const { name, colorHex } = req.body
    if (!name) return res.status(400).json({ error: 'Kategori adı zorunludur.' })
    const category = await prisma.sportCategory.update({
      where: { id },
      data: { name, colorHex: colorHex || null },
    })
    return res.json({ category })
  } catch (err) {
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}
