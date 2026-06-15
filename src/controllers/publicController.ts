import { Request, Response } from 'express'
import prisma from '../utils/prisma'

// GET /api/public/sessions
export const getSessions = async (req: Request, res: Response) => {
  try {
    const { category, date, venueId, neighborhoodId, search } = req.query

    const where: any = {
      status: 'open',
      startsAt: { gte: new Date() },
    }

    if (date) {
      const d = new Date(date as string)
      const nextDay = new Date(d)
      nextDay.setDate(nextDay.getDate() + 1)
      where.startsAt = { gte: d, lt: nextDay }
    }

    // Build class filter
    const classWhere: any = {}
    if (category) classWhere.sportCategory = { name: { equals: category as string, mode: 'insensitive' } }
    if (venueId) classWhere.venueId = parseInt(venueId as string)
    if (search) classWhere.title = { contains: search as string, mode: 'insensitive' }
    if (neighborhoodId) classWhere.venue = { neighborhoodId: parseInt(neighborhoodId as string) }
    if (Object.keys(classWhere).length > 0) where.class = classWhere

    const sessions = await prisma.class_Session.findMany({
      where,
      include: {
        class: {
          include: {
            sportCategory: true,
            venue: {
              include: { neighborhood: true },
            },
            instructor: true,
          },
        },
      },
      orderBy: { startsAt: 'asc' },
      take: 50,
    })

    const result = sessions.map((s) => ({
      id: s.id,
      title: s.class.title,
      venueId: s.class.venueId,
      venueName: s.class.venue.name,
      venueAddress: s.class.venue.address,
      instructorId: s.class.instructorId ?? null,
      instructorName: s.class.instructor?.fullName ?? null,
      category: s.class.sportCategory.name,
      categoryColor: s.class.sportCategory.colorHex ?? null,
      startsAt: s.startsAt.toISOString(),
      durationMinutes: s.class.durationMinutes,
      basePrice: s.class.basePrice,
      availableSpots: s.availableSpots,
      capacity: s.class.capacity,
      neighborhood: s.class.venue.neighborhood?.name ?? null,
      neighborhoodId: s.class.venue.neighborhoodId ?? null,
      rating: s.class.venue.avgRating,
      totalReviews: s.class.venue.totalReviews,
    }))

    return res.json({ sessions: result })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// GET /api/public/sessions/:id
export const getSessionById = async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id as string)

    const s = await prisma.class_Session.findUnique({
      where: { id },
      include: {
        class: {
          include: {
            sportCategory: true,
            venue: {
              include: { neighborhood: true },
            },
            instructor: true,
          },
        },
      },
    })

    if (!s) return res.status(404).json({ error: 'Seans bulunamadı.' })

    return res.json({
      session: {
        id: s.id,
        title: s.class.title,
        description: s.class.description,
        venueId: s.class.venueId,
        venueName: s.class.venue.name,
        venueAddress: s.class.venue.address,
        instructorId: s.class.instructorId ?? null,
        instructorName: s.class.instructor?.fullName ?? null,
        instructorBio: s.class.instructor?.bio ?? null,
        instructorAvatarUrl: s.class.instructor?.avatarUrl ?? null,
        category: s.class.sportCategory.name,
        categoryColor: s.class.sportCategory.colorHex ?? null,
        startsAt: s.startsAt.toISOString(),
        endsAt: s.endsAt.toISOString(),
        durationMinutes: s.class.durationMinutes,
        basePrice: s.class.basePrice,
        availableSpots: s.availableSpots,
        capacity: s.class.capacity,
        status: s.status,
        neighborhood: s.class.venue.neighborhood?.name ?? null,
        rating: s.class.venue.avgRating,
        totalReviews: s.class.venue.totalReviews,
      },
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// GET /api/public/venues
export const getVenues = async (req: Request, res: Response) => {
  try {
    const venues = await prisma.venue.findMany({
      where: { isVerified: true, isActive: true },
      include: {
        sportCategories: { include: { sportCategory: true } },
        neighborhood: true,
        _count: { select: { classes: true } },
      },
      orderBy: { createdAt: 'desc' },
    })

    return res.json({ venues })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// GET /api/public/venues/:id
export const getVenueById = async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id as string)

    const venue = await prisma.venue.findUnique({
      where: { id },
      include: {
        neighborhood: true,
        sportCategories: { include: { sportCategory: true } },
        instructors: {
          where: { isActive: true },
        },
        classes: {
          where: { isActive: true },
          include: {
            sportCategory: true,
            instructor: true,
            sessions: {
              where: {
                status: 'open',
                startsAt: { gt: new Date() },
              },
              orderBy: { startsAt: 'asc' },
            },
          },
        },
      },
    })

    if (!venue) return res.status(404).json({ error: 'Salon bulunamadı.' })

    return res.json({ venue })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// GET /api/public/dropin
export const getDropInSlots = async (req: Request, res: Response) => {
  try {
    const slots = await prisma.dropInSlot.findMany({
      where: { status: 'open', visibility: 'open', startsAt: { gte: new Date() } },
      include: {
        venue: { select: { id: true, name: true, address: true } },
        sportCategory: { select: { name: true, colorHex: true, iconUrl: true } },
        participants: { select: { id: true } },
      },
      orderBy: { startsAt: 'asc' },
    })
    return res.json({ slots })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// GET /api/public/dropin/:id
export const getDropInSlotById = async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id as string)
    const slot = await prisma.dropInSlot.findUnique({
      where: { id },
      include: {
        venue: { select: { id: true, name: true, address: true } },
        sportCategory: { select: { name: true, colorHex: true, iconUrl: true } },
        participants: { select: { id: true, userId: true } },
      }
    })
    if (!slot) return res.status(404).json({ error: 'Slot bulunamadı.' })
    return res.json({ slot })
  } catch (err) {
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// GET /api/public/categories
export const getCategories = async (req: Request, res: Response) => {
  try {
    const categories = await prisma.sportCategory.findMany({
      orderBy: { name: 'asc' },
    })

    return res.json({ categories })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// GET /api/public/neighborhoods
export const getNeighborhoods = async (req: Request, res: Response) => {
  try {
    const neighborhoods = await prisma.neighborhood.findMany({
      where: { city: { name: 'İstanbul' } },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    })
    return res.json({ neighborhoods })
  } catch (err) {
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// GET /api/public/venues-list
export const getVenuesList = async (req: Request, res: Response) => {
  try {
    const venues = await prisma.venue.findMany({
      where: { isApproved: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    })
    return res.json({ venues })
  } catch (err) {
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// GET /api/public/users/:username
export const getUserActivities = async (req: Request, res: Response) => {
  try {
    const { username } = req.params

    const user = await prisma.user.findUnique({
      where: { username },
      select: {
        id: true, username: true, fullName: true, avatarUrl: true,
        activityPrivacy: true,
        neighborhood: { select: { name: true } },
        tier: { select: { name: true, discountPercent: true, colorHex: true, iconUrl: true } },
        totalLessonsCompleted: true,
        badges: { include: { badge: true } },
      }
    })

    if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' })

    // If private, return user info only (no activities)
    if (user.activityPrivacy === 'private') {
      return res.json({ user, activities: null, isPrivate: true })
    }

    // Fetch bookings
    const bookings = await prisma.booking.findMany({
      where: { userId: user.id, status: 'confirmed' },
      include: {
        session: {
          include: {
            class: {
              include: { venue: { select: { id: true, name: true } } }
            }
          }
        }
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    })

    // Fetch drop-in participations
    const dropIns = await prisma.dropInParticipant.findMany({
      where: { userId: user.id, status: 'confirmed' },
      include: {
        slot: {
          include: {
            venue: { select: { id: true, name: true } },
            sportCategory: { select: { name: true, iconUrl: true, colorHex: true } },
          }
        }
      },
      orderBy: { joinedAt: 'desc' },
      take: 20,
    })

    return res.json({ user, bookings, dropInParticipations: dropIns, isPrivate: false })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}
