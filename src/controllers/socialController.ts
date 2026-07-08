import { Request, Response } from 'express'
import prisma from '../utils/prisma'
import { sendPushNotification } from '../utils/push'
import { longestDailyStreak, currentDailyStreak, currentWeeklyStreak } from '../utils/streak'
import { cached } from '../utils/cache'
import { seasonInfo } from '../utils/season'

export const followUser = async (req: Request, res: Response) => {
  try {
    const followerId = (req as any).userId
    const username = String(req.params.username)
    const target = await prisma.user.findUnique({ where: { username }, select: { id: true, profilePrivacy: true, pushToken: true } })
    if (!target) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' })
    if (target.id === followerId) return res.status(400).json({ error: 'Kendinizi takip edemezsiniz.' })

    const existing = await prisma.follow.findUnique({ where: { followerId_followingId: { followerId, followingId: target.id } } })
    if (existing) return res.status(400).json({ error: existing.status === 'pending' ? 'İstek zaten gönderildi.' : 'Zaten takip ediyorsunuz.', status: existing.status })

    // Gizli profil → istek (pending); açık profil → doğrudan kabul (accepted)
    const isPrivate = target.profilePrivacy === 'private'
    const status = isPrivate ? 'pending' : 'accepted'
    await prisma.follow.create({ data: { followerId, followingId: target.id, status } })

    // Hedefe bildirim (uygulama içi + push) — takipçiye/isteğe göre
    const me = await prisma.user.findUnique({ where: { id: followerId }, select: { username: true } })
    const msg = isPrivate ? `@${me?.username} seni takip etmek istiyor` : `@${me?.username} seni takip etmeye başladı`
    await prisma.notification.create({ data: { userId: target.id, type: isPrivate ? 'follow_request' : 'follow', message: msg, relatedUserId: followerId } }).catch(() => {})
    if (target.pushToken) sendPushNotification(target.pushToken, isPrivate ? 'Yeni takip isteği' : 'Yeni takipçi 👋', msg).catch(() => {})

    return res.json({ message: isPrivate ? 'Takip isteği gönderildi.' : 'Takip edildi.', status })
  } catch (err: any) {
    if (err?.code === 'P2002') return res.status(400).json({ error: 'Zaten takip ediyorsunuz.' })
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// Gelen takip isteğini KABUL et (ben = hedef, username = isteği gönderen)
export const acceptFollowRequest = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId
    const username = String(req.params.username)
    const follower = await prisma.user.findUnique({ where: { username }, select: { id: true, pushToken: true } })
    if (!follower) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' })
    const upd = await prisma.follow.updateMany({ where: { followerId: follower.id, followingId: userId, status: 'pending' }, data: { status: 'accepted' } })
    if (upd.count === 0) return res.status(404).json({ error: 'Bekleyen istek yok.' })
    const me = await prisma.user.findUnique({ where: { id: userId }, select: { username: true } })
    await prisma.notification.create({ data: { userId: follower.id, type: 'follow_accept', message: `@${me?.username} takip isteğini kabul etti`, relatedUserId: userId } }).catch(() => {})
    if (follower.pushToken) sendPushNotification(follower.pushToken, 'Takip isteğin kabul edildi 🎉', `@${me?.username} takip isteğini kabul etti`).catch(() => {})
    return res.json({ message: 'İstek kabul edildi.' })
  } catch (err) { return res.status(500).json({ error: 'Sunucu hatası.' }) }
}

// Gelen takip isteğini REDDET (pending kaydı sil)
export const rejectFollowRequest = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId
    const username = String(req.params.username)
    const follower = await prisma.user.findUnique({ where: { username }, select: { id: true } })
    if (!follower) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' })
    await prisma.follow.deleteMany({ where: { followerId: follower.id, followingId: userId, status: 'pending' } })
    return res.json({ message: 'İstek reddedildi.' })
  } catch (err) { return res.status(500).json({ error: 'Sunucu hatası.' }) }
}

// Bana gelen bekleyen takip istekleri
export const getFollowRequests = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId
    const reqs = await prisma.follow.findMany({
      where: { followingId: userId, status: 'pending' },
      include: { follower: { select: { id: true, username: true, fullName: true, avatarUrl: true, tier: { select: { name: true, colorHex: true, iconUrl: true } } } } },
      orderBy: { createdAt: 'desc' },
    })
    return res.json({ requests: reqs.map(r => r.follower) })
  } catch (err) { return res.status(500).json({ error: 'Sunucu hatası.' }) }
}

export const unfollowUser = async (req: Request, res: Response) => {
  try {
    const followerId = (req as any).userId
    const username = String(req.params.username)
    const target = await prisma.user.findUnique({ where: { username }, select: { id: true } })
    if (!target) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' })

    await prisma.follow.deleteMany({ where: { followerId, followingId: target.id } })
    return res.json({ message: 'Takip bırakıldı.' })
  } catch (err) { return res.status(500).json({ error: 'Sunucu hatası.' }) }
}

export const getFollowStatus = async (req: Request, res: Response) => {
  try {
    const followerId = (req as any).userId
    const username = String(req.params.username)
    const target = await prisma.user.findUnique({ where: { username }, select: { id: true } })
    if (!target) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' })

    const follow = await prisma.follow.findUnique({ where: { followerId_followingId: { followerId, followingId: target.id } } })
    // Sayaçlar SADECE kabul edilmiş (accepted) ilişkileri sayar — pending istekler dahil değil
    const followers = await prisma.follow.count({ where: { followingId: target.id, status: 'accepted' } })
    const following = await prisma.follow.count({ where: { followerId: target.id, status: 'accepted' } })
    return res.json({ isFollowing: follow?.status === 'accepted', followStatus: follow?.status || 'none', followers, following })
  } catch (err) { return res.status(500).json({ error: 'Sunucu hatası.' }) }
}

export const getFollowers = async (req: Request, res: Response) => {
  try {
    const username = String(req.params.username)
    const user = await prisma.user.findUnique({ where: { username }, select: { id: true } })
    if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' })

    const follows = await prisma.follow.findMany({
      where: { followingId: user.id, status: 'accepted' },
      include: { follower: { select: { id: true, username: true, fullName: true, avatarUrl: true, tier: { select: { name: true, colorHex: true, iconUrl: true } } } } }
    })
    return res.json({ followers: follows.map(f => f.follower) })
  } catch (err) { return res.status(500).json({ error: 'Sunucu hatası.' }) }
}

export const getFollowing = async (req: Request, res: Response) => {
  try {
    const username = String(req.params.username)
    const user = await prisma.user.findUnique({ where: { username }, select: { id: true } })
    if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' })

    const follows = await prisma.follow.findMany({
      where: { followerId: user.id, status: 'accepted' },
      include: { following: { select: { id: true, username: true, fullName: true, avatarUrl: true, tier: { select: { name: true, colorHex: true, iconUrl: true } } } } }
    })
    return res.json({ following: follows.map(f => f.following) })
  } catch (err) { return res.status(500).json({ error: 'Sunucu hatası.' }) }
}

// Kullanıcı liderlik tablosu
export const getUserLeaderboard = async (req: Request, res: Response) => {
  try {
    const { branch, neighborhoodId } = req.query
    const season = seasonInfo()

    const ranked = await cached(`lb-users:${season.key}:${branch || ''}:${neighborhoodId || ''}`, 45000, async () => {
      // Liderlik her MEVSİM sıfırlanır: sadece bu sezondaki (mevsim başından beri) dersler sayılır
      const seasonStart = season.start
      // activityPrivacy gizli olanları hariç tut
      const users = await prisma.user.findMany({
        where: {
          banned: false,
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
              session: {
                startsAt: { gte: seasonStart },
                ...(branch ? { class: { category: branch as string } } : {}),
              },
            },
            select: { id: true }
          }
        }
      })
      return users
        .map(u => ({ ...u, lessonCount: u.bookings.length, bookings: undefined }))
        .filter(u => u.lessonCount > 0)
        .sort((a, b) => b.lessonCount - a.lessonCount)
        .slice(0, 50)
    })

    return res.json({ leaderboard: ranked, season: { name: season.name, nameEn: season.nameEn, label: season.label, labelEn: season.labelEn, startsAt: season.start } })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// En uzun streak liderliği — üst üste en fazla gün giden sporcular
// Filtre: branch (spor kategorisi) + neighborhoodId (ilçe; yoksa şehir geneli)
export const getStreakLeaderboard = async (req: Request, res: Response) => {
  try {
    const { branch, neighborhoodId } = req.query
    const now = new Date()
    const season = seasonInfo(now)

    const ranked = await cached(`lb-streak:${season.key}:${branch || ''}:${neighborhoodId || ''}`, 45000, async () => {
    const users = await prisma.user.findMany({
      where: {
        banned: false,
        activityPrivacy: { not: 'private' },
        ...(neighborhoodId ? { neighborhoodId: parseInt(neighborhoodId as string) } : {}),
      },
      select: {
        id: true,
        username: true,
        fullName: true,
        avatarUrl: true,
        neighborhood: { select: { name: true } },
        tier: { select: { name: true, colorHex: true, iconUrl: true } },
        bookings: {
          where: {
            status: 'confirmed',
            checkedIn: true, // seri = GERÇEKTEN gidilmiş (kullanıcının kendi takvimiyle tutarlı)
            session: {
              startsAt: { gte: season.start, lt: now }, // seri de her mevsim sıfırlanır
              ...(branch ? { class: { category: branch as string } } : {}),
            },
          },
          select: { session: { select: { startsAt: true } } },
        },
        dropInParticipants: {
          where: {
            status: 'confirmed',
            checkedIn: true,
            slot: {
              startsAt: { gte: season.start, lt: now },
              ...(branch ? { sportCategory: { name: branch as string } } : {}),
            },
          },
          select: { slot: { select: { startsAt: true } } },
        },
      },
    })

    return users
      .map(u => {
        const dates: Date[] = [
          ...u.bookings.map(b => b.session?.startsAt).filter(Boolean) as Date[],
          ...u.dropInParticipants.map(d => d.slot?.startsAt).filter(Boolean) as Date[],
        ]
        const streak = longestDailyStreak(dates)
        return {
          id: u.id,
          username: u.username,
          fullName: u.fullName,
          avatarUrl: u.avatarUrl,
          neighborhood: u.neighborhood,
          tier: u.tier,
          streak,
        }
      })
      .filter(u => u.streak >= 2) // en az 2 gün üst üste
      .sort((a, b) => b.streak - a.streak)
      .slice(0, 50)
    })

    return res.json({ leaderboard: ranked, season: { name: season.name, nameEn: season.nameEn, label: season.label, labelEn: season.labelEn, startsAt: season.start } })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// Kullanıcının aktivite takvimi — SADECE check-in YAPILMIŞ (gerçekten gidilmiş) aktiviteler.
// Her aktivite için { date: 'YYYY-MM-DD' (Europe/Istanbul), category }. Ayrıca güncel günlük + haftalık seri.
// (Aktivite takvime rezervasyonda değil, salon check-in'inde düşer.)
export const getMyCalendar = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId
    // Yerel (İstanbul) güne göre grupla — startsAt UTC saklanır.
    const ymd = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'Europe/Istanbul' })

    const [bookings, dropins] = await Promise.all([
      prisma.booking.findMany({
        where: { userId, checkedIn: true, bookingType: 'class' },
        select: { session: { select: { startsAt: true, class: { select: { category: true, title: true } } } } },
      }),
      prisma.dropInParticipant.findMany({
        where: { userId, checkedIn: true },
        select: { slot: { select: { startsAt: true, title: true, sportCategory: { select: { name: true } } } } },
      }),
    ])

    const dates: Date[] = []
    const activities: { date: string; category: string | null; title: string }[] = []
    for (const b of bookings) if (b.session) {
      dates.push(b.session.startsAt)
      activities.push({ date: ymd(b.session.startsAt), category: b.session.class.category || null, title: b.session.class.title })
    }
    for (const d of dropins) if (d.slot) {
      dates.push(d.slot.startsAt)
      activities.push({ date: ymd(d.slot.startsAt), category: d.slot.sportCategory?.name || null, title: d.slot.title })
    }

    return res.json({
      activities,
      dailyStreak: currentDailyStreak(dates),
      weeklyStreak: currentWeeklyStreak(dates),
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// Salon liderlik tablosu
export const getVenueLeaderboard = async (req: Request, res: Response) => {
  try {
    const { branch, neighborhoodId } = req.query

    const venues = await cached(`lb-venue:${branch || ''}:${neighborhoodId || ''}`, 45000, () => prisma.venue.findMany({
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
    }))

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
        banned: false,
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
        user: { activityPrivacy: { not: 'private' }, banned: false }
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

    // Etiketlenen arkadaşların gerçek isim/kullanıcı adı bilgisini topluca çöz
    const allTaggedUsernames = Array.from(new Set(
      bookings.flatMap(b => (Array.isArray(b.taggedFriends) ? (b.taggedFriends as string[]) : []))
        .map(u => String(u).replace(/^@/, '').toLowerCase())
    ))
    const taggedUsers = allTaggedUsernames.length > 0
      ? await prisma.user.findMany({
          where: { username: { in: allTaggedUsernames, mode: 'insensitive' } },
          select: { username: true, fullName: true },
        })
      : []
    const taggedMap = new Map(taggedUsers.map(u => [u.username.toLowerCase(), u]))

    // Drop-in katılımları
    const dropIns = await prisma.dropInParticipant.findMany({
      where: {
        userId: { in: followingIds },
        status: 'confirmed',
        joinedAt: { gte: since },
        user: { activityPrivacy: { not: 'private' }, banned: false }
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

    // Kazanılan rozetler
    const userBadges = await prisma.userBadge.findMany({
      where: {
        userId: { in: followingIds },
        earnedAt: { gte: since },
        user: { activityPrivacy: { not: 'private' }, banned: false },
      },
      include: {
        user: { select: { id: true, username: true, fullName: true, avatarUrl: true } },
        badge: { select: { key: true, name: true, iconUrl: true } },
        sportCategory: { select: { name: true } },
      },
      orderBy: { earnedAt: 'desc' },
      take: 30,
    })

    // Birleştir ve sırala
    const feed = [
      ...bookings.map(b => {
        const tags = (Array.isArray(b.taggedFriends) ? (b.taggedFriends as string[]) : [])
          .map(u => {
            const key = String(u).replace(/^@/, '').toLowerCase()
            const found = taggedMap.get(key)
            return found ? { username: found.username, fullName: found.fullName } : { username: key, fullName: key }
          })
        return {
          id: `b-${b.id}`,
          type: 'booking' as const,
          user: b.user,
          title: b.session?.class?.title || 'Ders',
          category: b.session?.class?.sportCategory?.name || '',
          categoryColor: b.session?.class?.sportCategory?.colorHex || '#4F46E5',
          venueName: b.session?.class?.venue?.name || '',
          venueId: b.session?.class?.venue?.id || null,
          taggedFriends: tags,
          date: b.createdAt,
        }
      }),
      ...dropIns.map(d => ({
        id: `d-${d.id}`,
        type: 'dropin' as const,
        user: d.user,
        title: d.slot?.title || 'Drop-in',
        category: d.slot?.sportCategory?.name || '',
        categoryColor: d.slot?.sportCategory?.colorHex || '#4F46E5',
        venueName: d.slot?.venue?.name || '',
        venueId: d.slot?.venue?.id || null,
        taggedFriends: [] as { username: string; fullName: string }[],
        date: d.joinedAt,
      })),
      ...userBadges.map(ub => ({
        id: `bg-${ub.id}`,
        type: 'badge' as const,
        user: ub.user,
        badgeName: ub.badge?.key === 'sport_master_40' && ub.sportCategory?.name ? `${ub.sportCategory.name} ustası` : (ub.badge?.name || 'Rozet'),
        badgeKey: ub.badge?.key || null,
        badgeIcon: ub.badge?.iconUrl || 'Award',
        sportName: ub.sportCategory?.name || null,
        date: ub.earnedAt,
      }))
    ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()).slice(0, 30)

    const feedKeys = feed.map(f => f.id)
    const [likeCounts, myLikes, commentCounts] = await Promise.all([
      prisma.activityLike.groupBy({ by: ['feedKey'], where: { feedKey: { in: feedKeys } }, _count: { feedKey: true } }),
      prisma.activityLike.findMany({ where: { feedKey: { in: feedKeys }, userId }, select: { feedKey: true } }),
      prisma.activityComment.groupBy({ by: ['feedKey'], where: { feedKey: { in: feedKeys } }, _count: { feedKey: true } }),
    ])
    const likeCountMap = new Map(likeCounts.map(l => [l.feedKey, l._count.feedKey]))
    const commentCountMap = new Map(commentCounts.map(c => [c.feedKey, c._count.feedKey]))
    const myLikedSet = new Set(myLikes.map(l => l.feedKey))

    const feedWithStats = feed.map(f => ({
      ...f,
      likeCount: likeCountMap.get(f.id) || 0,
      commentCount: commentCountMap.get(f.id) || 0,
      likedByMe: myLikedSet.has(f.id),
    }))

    return res.json({ feed: feedWithStats })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// feedKey -> aktivite sahibi + gizlilik; aktivite yoksa null.
// Var olmayan/gizli aktiviteye like/yorum yapılmasını (orphan satır, sahte sayaç, gizli kullanıcıya
// istenmeyen bildirim/push) engellemek için kullanılır. 'bg' (rozet) dahil tüm feed türlerini tanır.
const resolveFeedActivity = async (feedKey: string): Promise<{ ownerId: number; privacy: string } | null> => {
  const dash = feedKey.indexOf('-')
  if (dash < 0) return null
  const prefix = feedKey.slice(0, dash)
  const id = parseInt(feedKey.slice(dash + 1), 10)
  if (!id || Number.isNaN(id)) return null
  if (prefix === 'b') {
    const b = await prisma.booking.findUnique({ where: { id }, select: { user: { select: { id: true, activityPrivacy: true } } } })
    return b?.user ? { ownerId: b.user.id, privacy: b.user.activityPrivacy } : null
  }
  if (prefix === 'd') {
    const d = await prisma.dropInParticipant.findUnique({ where: { id }, select: { user: { select: { id: true, activityPrivacy: true } } } })
    return d?.user ? { ownerId: d.user.id, privacy: d.user.activityPrivacy } : null
  }
  if (prefix === 'bg') {
    const bg = await prisma.userBadge.findUnique({ where: { id }, select: { user: { select: { id: true, activityPrivacy: true } } } })
    return bg?.user ? { ownerId: bg.user.id, privacy: bg.user.activityPrivacy } : null
  }
  return null
}

// POST /api/social/feed/:feedKey/like
export const likeActivity = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId
    const feedKey = String(req.params.feedKey)

    // Aktivite gerçekten var mı + erişebilir miyim (gizli değilse/kendiminse)
    const activity = await resolveFeedActivity(feedKey)
    if (!activity) return res.status(404).json({ error: 'Aktivite bulunamadı.' })
    if (activity.privacy === 'private' && activity.ownerId !== userId) {
      return res.status(403).json({ error: 'Bu aktiviteye erişiminiz yok.' })
    }

    const existing = await prisma.activityLike.findUnique({ where: { feedKey_userId: { feedKey, userId } } })
    if (existing) return res.status(400).json({ error: 'Zaten beğendiniz.' })

    await prisma.activityLike.create({ data: { feedKey, userId } })

    // Bildirim best-effort: hata like'ı 500'e çevirmesin (like zaten commit oldu)
    const ownerId = activity.ownerId
    if (ownerId && ownerId !== userId) {
      try {
        const liker = await prisma.user.findUnique({ where: { id: userId }, select: { fullName: true } })
        await prisma.notification.create({
          data: {
            userId: ownerId,
            type: 'like',
            message: `${liker?.fullName || 'Bir kullanıcı'} aktiviteni beğendi.`,
            relatedUserId: userId,
          },
        })
        const owner = await prisma.user.findUnique({ where: { id: ownerId }, select: { pushToken: true } })
        if (owner?.pushToken) {
          sendPushNotification(owner.pushToken, 'Yeni beğeni ❤️', `${liker?.fullName || 'Bir kullanıcı'} aktiviteni beğendi.`).catch(() => {})
        }
      } catch (notifyErr) {
        console.error('like notify error:', notifyErr)
      }
    }

    return res.json({ message: 'Beğenildi.' })
  } catch (err: any) {
    if (err?.code === 'P2002') return res.status(400).json({ error: 'Zaten beğendiniz.' })
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// DELETE /api/social/feed/:feedKey/like
export const unlikeActivity = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId
    const feedKey = String(req.params.feedKey)
    await prisma.activityLike.deleteMany({ where: { feedKey, userId } })
    return res.json({ message: 'Beğeni kaldırıldı.' })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// GET /api/social/feed/:feedKey/comments
export const getActivityComments = async (req: Request, res: Response) => {
  try {
    const feedKey = String(req.params.feedKey)
    const all = await prisma.activityComment.findMany({
      where: { feedKey },
      include: { user: { select: { username: true, fullName: true, avatarUrl: true } } },
      orderBy: { createdAt: 'asc' },
    })
    const topLevel = all.filter(c => !c.parentId)
    const repliesByParent = new Map<number, typeof all>()
    for (const c of all) {
      if (c.parentId) {
        if (!repliesByParent.has(c.parentId)) repliesByParent.set(c.parentId, [])
        repliesByParent.get(c.parentId)!.push(c)
      }
    }
    const comments = topLevel.map(c => ({ ...c, replies: repliesByParent.get(c.id) || [] }))
    return res.json({ comments })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// POST /api/social/feed/:feedKey/comments
export const addActivityComment = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId
    const feedKey = String(req.params.feedKey)
    const { content, parentId } = req.body
    if (!content || !String(content).trim()) return res.status(400).json({ error: 'Yorum boş olamaz.' })

    // Aktivite gerçekten var mı + erişebilir miyim (gizli değilse/kendiminse)
    const activity = await resolveFeedActivity(feedKey)
    if (!activity) return res.status(404).json({ error: 'Aktivite bulunamadı.' })
    if (activity.privacy === 'private' && activity.ownerId !== userId) {
      return res.status(403).json({ error: 'Bu aktiviteye erişiminiz yok.' })
    }

    let parentComment = null
    const pid = parseInt(parentId, 10)
    if (parentId && !Number.isNaN(pid)) {
      parentComment = await prisma.activityComment.findUnique({ where: { id: pid } })
      if (!parentComment || parentComment.feedKey !== feedKey) {
        return res.status(400).json({ error: 'Geçersiz yorum.' })
      }
    }

    const comment = await prisma.activityComment.create({
      data: { feedKey, userId, content: String(content).trim().slice(0, 500), parentId: parentComment?.id || null },
      include: { user: { select: { username: true, fullName: true, avatarUrl: true } } },
    })

    // Bildirim best-effort: hata yorumu 500'e çevirmesin (yorum zaten commit oldu)
    try {
    const commenter = await prisma.user.findUnique({ where: { id: userId }, select: { fullName: true } })

    if (parentComment && parentComment.userId !== userId) {
      // Yoruma cevap verildi — yorumu yazana bildirim
      await prisma.notification.create({
        data: {
          userId: parentComment.userId,
          type: 'comment',
          message: `${commenter?.fullName || 'Bir kullanıcı'} yorumuna cevap verdi: "${comment.content.slice(0, 80)}"`,
          relatedUserId: userId,
        },
      })
      const parentUser = await prisma.user.findUnique({ where: { id: parentComment.userId }, select: { pushToken: true } })
      if (parentUser?.pushToken) {
        sendPushNotification(parentUser.pushToken, 'Yeni cevap 💬', `${commenter?.fullName || 'Bir kullanıcı'} yorumuna cevap verdi.`).catch(() => {})
      }
    } else if (!parentComment) {
      // Yeni üst seviye yorum — aktivite sahibine bildirim
      const ownerId = activity.ownerId
      if (ownerId && ownerId !== userId) {
        await prisma.notification.create({
          data: {
            userId: ownerId,
            type: 'comment',
            message: `${commenter?.fullName || 'Bir kullanıcı'} aktivitene yorum yaptı: "${comment.content.slice(0, 80)}"`,
            relatedUserId: userId,
          },
        })
        const owner = await prisma.user.findUnique({ where: { id: ownerId }, select: { pushToken: true } })
        if (owner?.pushToken) {
          sendPushNotification(owner.pushToken, 'Yeni yorum 💬', `${commenter?.fullName || 'Bir kullanıcı'} aktivitene yorum yaptı.`).catch(() => {})
        }
      }
    }
    } catch (notifyErr) {
      console.error('comment notify error:', notifyErr)
    }

    return res.status(201).json({ comment })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// GET /api/social/notifications
export const getNotifications = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId
    const notifications = await prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    })
    const unreadCount = await prisma.notification.count({ where: { userId, isRead: false } })
    return res.json({ notifications, unreadCount })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// PUT /api/social/notifications/read
export const markNotificationsRead = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId
    await prisma.notification.updateMany({ where: { userId, isRead: false }, data: { isRead: true } })
    return res.json({ message: 'Bildirimler okundu olarak işaretlendi.' })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}
