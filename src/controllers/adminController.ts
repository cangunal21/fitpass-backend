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
