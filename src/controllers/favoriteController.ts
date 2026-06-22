import { Request, Response } from 'express'
import prisma from '../utils/prisma'

export const addFavorite = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId
    const venueId = parseInt(req.params.venueId as string)

    const venue = await prisma.venue.findUnique({ where: { id: venueId } })
    if (!venue) return res.status(404).json({ error: 'Salon bulunamadı.' })

    const existing = await prisma.favoriteVenue.findUnique({
      where: { userId_venueId: { userId, venueId } }
    })
    if (existing) return res.status(400).json({ error: 'Zaten favorilerde.' })

    const fav = await prisma.favoriteVenue.create({ data: { userId, venueId } })
    return res.status(201).json({ message: 'Favorilere eklendi!', favorite: fav })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

export const removeFavorite = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId
    const venueId = parseInt(req.params.venueId as string)

    await prisma.favoriteVenue.deleteMany({ where: { userId, venueId } })
    return res.json({ message: 'Favorilerden çıkarıldı.' })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

export const getFavoriteStatus = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId
    const venueId = parseInt(req.params.venueId as string)

    const fav = await prisma.favoriteVenue.findUnique({
      where: { userId_venueId: { userId, venueId } }
    })
    return res.json({ isFavorite: !!fav })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

export const getMyFavorites = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId

    const favs = await prisma.favoriteVenue.findMany({
      where: { userId },
      include: {
        venue: {
          select: {
            id: true, name: true, address: true, avgRating: true,
            totalReviews: true, coverImageUrl: true, isApproved: true,
            sportCategories: { include: { sportCategory: { select: { name: true } } } }
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    })

    return res.json({ favorites: favs.map(f => f.venue) })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

export const getUserFavorites = async (req: Request, res: Response) => {
  try {
    const username = String(req.params.username)

    const user = await prisma.user.findUnique({ where: { username } })
    if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' })

    // Gizlilik kontrolü
    if (user.activityPrivacy === 'private') {
      return res.json({ favorites: [], private: true })
    }

    const favs = await prisma.favoriteVenue.findMany({
      where: { userId: user.id },
      include: {
        venue: {
          select: {
            id: true, name: true, address: true, avgRating: true,
            totalReviews: true, coverImageUrl: true,
            sportCategories: { include: { sportCategory: { select: { name: true } } } }
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    })

    return res.json({ favorites: favs.map(f => f.venue) })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}
