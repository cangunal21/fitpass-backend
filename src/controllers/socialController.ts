import { Request, Response } from 'express'
import prisma from '../utils/prisma'

export const followUser = async (req: Request, res: Response) => {
  try {
    const followerId = (req as any).userId
    const { username } = req.params
    const target = await prisma.user.findUnique({ where: { username }, select: { id: true } })
    if (!target) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' })
    if (target.id === followerId) return res.status(400).json({ error: 'Kendinizi takip edemezsiniz.' })

    const existing = await prisma.follow.findUnique({ where: { followerId_followingId: { followerId, followingId: target.id } } })
    if (existing) return res.status(400).json({ error: 'Zaten takip ediyorsunuz.' })

    await prisma.follow.create({ data: { followerId, followingId: target.id, status: 'accepted' } })
    return res.json({ message: 'Takip edildi.' })
  } catch (err) { return res.status(500).json({ error: 'Sunucu hatası.' }) }
}

export const unfollowUser = async (req: Request, res: Response) => {
  try {
    const followerId = (req as any).userId
    const { username } = req.params
    const target = await prisma.user.findUnique({ where: { username }, select: { id: true } })
    if (!target) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' })

    await prisma.follow.deleteMany({ where: { followerId, followingId: target.id } })
    return res.json({ message: 'Takip bırakıldı.' })
  } catch (err) { return res.status(500).json({ error: 'Sunucu hatası.' }) }
}

export const getFollowStatus = async (req: Request, res: Response) => {
  try {
    const followerId = (req as any).userId
    const { username } = req.params
    const target = await prisma.user.findUnique({ where: { username }, select: { id: true } })
    if (!target) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' })

    const follow = await prisma.follow.findUnique({ where: { followerId_followingId: { followerId, followingId: target.id } } })
    const followers = await prisma.follow.count({ where: { followingId: target.id } })
    const following = await prisma.follow.count({ where: { followerId: target.id } })
    return res.json({ isFollowing: !!follow, followers, following })
  } catch (err) { return res.status(500).json({ error: 'Sunucu hatası.' }) }
}

export const getFollowers = async (req: Request, res: Response) => {
  try {
    const { username } = req.params
    const user = await prisma.user.findUnique({ where: { username }, select: { id: true } })
    if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' })

    const follows = await prisma.follow.findMany({
      where: { followingId: user.id },
      include: { follower: { select: { id: true, username: true, fullName: true, avatarUrl: true, tier: { select: { name: true, colorHex: true, iconUrl: true } } } } }
    })
    return res.json({ followers: follows.map(f => f.follower) })
  } catch (err) { return res.status(500).json({ error: 'Sunucu hatası.' }) }
}

export const getFollowing = async (req: Request, res: Response) => {
  try {
    const { username } = req.params
    const user = await prisma.user.findUnique({ where: { username }, select: { id: true } })
    if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' })

    const follows = await prisma.follow.findMany({
      where: { followerId: user.id },
      include: { following: { select: { id: true, username: true, fullName: true, avatarUrl: true, tier: { select: { name: true, colorHex: true, iconUrl: true } } } } }
    })
    return res.json({ following: follows.map(f => f.following) })
  } catch (err) { return res.status(500).json({ error: 'Sunucu hatası.' }) }
}

// Kullanıcı liderlik tablosu
export const getUserLeaderboard = async (req: Request, res: Response) => {
  try {
    const { branch, neighborhoodId } = req.query

    // activityPrivacy gizli olanları hariç tut
    const users = await prisma.user.findMany({
      where: {
        activityPrivacy: { not: 'private' },
        ...(neighborhoodId ? { neighborhoodId: parseInt(neighborhoodId as string) } : {}),
      },
      select: {
        id: true,
        username: true,
        avatarUrl: true,
        neighborhoodId: true,
        neighborhood: { select: { name: true } },
        tier: { select: { name: true, colorHex: true, iconUrl: true } },
        bookings: {
          where: {
            status: 'confirmed',
            ...(branch ? {
              session: {
                class: { category: branch as string }
              }
            } : {})
          },
          select: { id: true }
        }
      }
    })

    const ranked = users
      .map(u => ({ ...u, lessonCount: u.bookings.length, bookings: undefined }))
      .filter(u => u.lessonCount > 0)
      .sort((a, b) => b.lessonCount - a.lessonCount)
      .slice(0, 50)

    return res.json({ leaderboard: ranked })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// Salon liderlik tablosu
export const getVenueLeaderboard = async (req: Request, res: Response) => {
  try {
    const { branch, neighborhoodId } = req.query

    const venues = await prisma.venue.findMany({
      where: {
        isApproved: true,
        ...(neighborhoodId ? { neighborhoodId: parseInt(neighborhoodId as string) } : {}),
        ...(branch ? {
          sportCategories: {
            some: { sportCategory: { name: branch as string } }
          }
        } : {})
      },
      select: {
        id: true,
        name: true,
        avgRating: true,
        totalReviews: true,
        coverImageUrl: true,
        neighborhood: { select: { name: true } },
        sportCategories: {
          include: { sportCategory: { select: { name: true } } }
        }
      },
      orderBy: { avgRating: 'desc' },
      take: 50
    })

    return res.json({ leaderboard: venues })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// Tanıyor olabileceğin kişiler (aynı ilçe veya aynı branş)
export const getSuggestions = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId

    const me = await prisma.user.findUnique({
      where: { id: userId },
      select: { neighborhoodId: true, bookings: { select: { session: { include: { class: { select: { category: true } } } } }, take: 10 } }
    })

    // Takip ettiklerimi bul
    const following = await prisma.follow.findMany({
      where: { followerId: userId },
      select: { followingId: true }
    })
    const followingIds = following.map(f => f.followingId)

    const suggestions = await prisma.user.findMany({
      where: {
        id: { not: userId, notIn: followingIds },
        activityPrivacy: { not: 'private' },
        OR: [
          { neighborhoodId: me?.neighborhoodId || 0 },
        ]
      },
      select: {
        id: true, username: true, avatarUrl: true,
        neighborhood: { select: { name: true } },
        tier: { select: { name: true, colorHex: true } },
        _count: { select: { bookings: true } }
      },
      take: 10
    })

    return res.json({ suggestions })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// GET /api/social/feed — takip edilenlerin aktiviteleri
export const getFeed = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId

    // Takip edilenlerin ID'leri
    const follows = await prisma.follow.findMany({
      where: { followerId: userId },
      select: { followingId: true }
    })
    const followingIds = follows.map(f => f.followingId)

    if (followingIds.length === 0) return res.json({ feed: [] })

    // Takip edilenlerin rezervasyonları (son 7 gün, activity privacy public)
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)

    const bookings = await prisma.booking.findMany({
      where: {
        userId: { in: followingIds },
        status: 'confirmed',
        createdAt: { gte: since },
        user: { activityPrivacy: { not: 'private' } }
      },
      include: {
        user: { select: { id: true, username: true, fullName: true, avatarUrl: true } },
        session: {
          include: {
            class: {
              include: {
                venue: { select: { id: true, name: true } },
                sportCategory: { select: { name: true, colorHex: true } }
              }
            }
          }
        }
      },
      orderBy: { createdAt: 'desc' },
      take: 30
    })

    // Drop-in katılımları
    const dropIns = await prisma.dropInParticipant.findMany({
      where: {
        userId: { in: followingIds },
        status: 'confirmed',
        joinedAt: { gte: since },
        user: { activityPrivacy: { not: 'private' } }
      },
      include: {
        user: { select: { id: true, username: true, fullName: true, avatarUrl: true } },
        slot: {
          include: {
            venue: { select: { id: true, name: true } },
            sportCategory: { select: { name: true, colorHex: true } }
          }
        }
      },
      orderBy: { joinedAt: 'desc' },
      take: 30
    })

    // Birleştir ve sırala
    const feed = [
      ...bookings.map(b => ({
        id: `b-${b.id}`,
        type: 'booking' as const,
        user: b.user,
        title: b.session?.class?.title || 'Ders',
        category: b.session?.class?.sportCategory?.name || '',
        categoryColor: b.session?.class?.sportCategory?.colorHex || '#4F46E5',
        venueName: b.session?.class?.venue?.name || '',
        venueId: b.session?.class?.venue?.id || null,
        date: b.createdAt,
      })),
      ...dropIns.map(d => ({
        id: `d-${d.id}`,
        type: 'dropin' as const,
        user: d.user,
        title: d.slot?.title || 'Drop-in',
        category: d.slot?.sportCategory?.name || '',
        categoryColor: d.slot?.sportCategory?.colorHex || '#4F46E5',
        venueName: d.slot?.venue?.name || '',
        venueId: d.slot?.venue?.id || null,
        date: d.joinedAt,
      }))
    ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()).slice(0, 30)

    return res.json({ feed })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}
