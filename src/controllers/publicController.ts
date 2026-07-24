import { Request, Response } from 'express'
import prisma from '../utils/prisma'
import { sendComplaintEmail } from '../utils/email'
import { syncUserTier } from '../utils/tier'
import { cached } from '../utils/cache'
import { parseIntSafe, parseDateSafe } from '../utils/validate'
import { sanitizeReview, hidePrivateReply } from '../utils/reviews'
import { seasonLabelsFromKey } from '../utils/season'

// Venue'de public'e ASLA çıkmaması gereken hassas alanlar (şifre, ödeme/KYC: IBAN, TCKN,
// vergi no, kimlik belgeleri, alt-üye anahtarı, ödeme telefonu...) + onay-öncesi pending görseller.
// Blacklist yerine whitelist zor (ilişkili include'lar var); bu liste TÜM hassas alanları kapsar.
const VENUE_SENSITIVE_FIELDS = [
  'passwordHash', 'email', 'pendingImages', 'pendingCoverImageUrl', 'imagesPendingReview',
  'iban', 'taxOffice', 'taxNumber', 'identityNumber', 'iyzicoSubMerchantKey',
  'subMerchantType', 'legalCompanyTitle', 'contactName', 'contactSurname', 'payoutGsm',
  'ibanMatchConsent', 'subMerchantStatus', 'subMerchantSubmittedAt', 'subMerchantApprovedAt',
  'subMerchantRejection', 'kycDocs',
] as const
function stripVenueSensitive<T extends Record<string, any>>(venue: T): Partial<T> {
  const v: any = { ...venue }
  for (const k of VENUE_SENSITIVE_FIELDS) delete v[k]
  return v
}

// GET /api/public/sessions
export const getSessions = async (req: Request, res: Response) => {
  try {
    const { category, date, dateFrom, dateTo, venueId, neighborhoodId, cityId, search, sort, userNeighborhoodId, page, limit } = req.query
    const pageNum = Math.max(1, parseIntSafe(page) || 1)
    const pageSize = Math.min(50, Math.max(1, parseIntSafe(limit) || 24))
    // "Bana yakın": mesafe bellekte hesaplanır. DB startsAt'a göre sayfalarsa yalnızca sayfa-içi
    // sıralanır (en yakın salon geç seansdaysa 1. sayfada çıkmaz). Bu yüzden nearby'de tüm eşleşen
    // seansları (üst sınırla) çekip GLOBAL mesafeye göre sıralayıp SONRA sayfalıyoruz.
    const isNearby = sort === 'nearby' && !!parseIntSafe(userNeighborhoodId)

    const where: any = {
      status: 'open',
    }

    const dFrom = parseDateSafe(dateFrom)
    const dTo = parseDateSafe(dateTo)
    const dExact = parseDateSafe(date)
    if (dFrom || dTo) {
      where.startsAt = {}
      if (dFrom) where.startsAt.gte = dFrom
      if (dTo) where.startsAt.lt = dTo
    } else if (dExact) {
      const nextDay = new Date(dExact)
      nextDay.setDate(nextDay.getDate() + 1)
      where.startsAt = { gte: dExact, lt: nextDay }
    } else {
      where.startsAt = { gte: new Date() }
    }

    // Build class filter
    // Pasife alınan ders listede çıkmasın (getForYou/getVenueById ile tutarlı)
    const classWhere: any = { isActive: true }
    // Kategori, Class.category metin alanıyla filtrelenir (sportCategoryId null olabilir)
    if (category) classWhere.category = { equals: category as string, mode: 'insensitive' }
    const vId = parseIntSafe(venueId)
    if (vId) classWhere.venueId = vId
    const nId = parseIntSafe(neighborhoodId)
    const cId = parseIntSafe(cityId)
    // Salon onaylı + aktif olmalı — askıya alınan/henüz onaylanmamış salonun dersleri listede çıkmasın
    classWhere.venue = { isApproved: true, isActive: true, ...(nId ? { neighborhoodId: nId } : {}), ...(cId ? { cityId: cId } : {}) }
    if (search) {
      classWhere.OR = [
        { title: { contains: search as string, mode: 'insensitive' } },
        { venue: { name: { contains: search as string, mode: 'insensitive' } } },
        { venue: { neighborhood: { name: { contains: search as string, mode: 'insensitive' } } } },
        { venue: { address: { contains: search as string, mode: 'insensitive' } } },
        { sportCategory: { name: { contains: search as string, mode: 'insensitive' } } },
      ]
    }
    if (Object.keys(classWhere).length > 0) where.class = classWhere

    const orderBy: any = sort === 'rating'
      ? [{ class: { venue: { avgRating: 'desc' } } }]
      : [{ startsAt: 'asc' }]

    const [sessions, total] = await Promise.all([
      prisma.class_Session.findMany({
        where,
        include: {
          class: {
            include: {
              sportCategory: true,
              venue: {
                include: { neighborhood: { select: { id: true, name: true, latitude: true, longitude: true } } },
              },
              instructor: true,
            },
          },
        },
        orderBy,
        skip: isNearby ? 0 : (pageNum - 1) * pageSize,
        take: isNearby ? 500 : pageSize,
      }),
      prisma.class_Session.count({ where }),
    ])

    let formattedSessions = sessions.map((s) => ({
      id: s.id,
      title: s.class.title,
      titleEn: s.class.titleEn ?? null,
      venueId: s.class.venueId,
      venueName: s.class.venue.name,
      venueAddress: s.class.venue.address,
      instructorId: s.class.instructorId ?? null,
      instructorName: s.class.instructor?.fullName ?? null,
      category: s.class.sportCategory?.name ?? s.class.category ?? '',
      categoryColor: s.class.sportCategory?.colorHex ?? null,
      startsAt: s.startsAt.toISOString(),
      durationMinutes: s.class.durationMinutes,
      basePrice: s.class.basePrice,
      availableSpots: s.availableSpots,
      capacity: s.class.capacity,
      neighborhood: s.class.venue.neighborhood?.name ?? null,
      neighborhoodId: s.class.venue.neighborhoodId ?? null,
      neighborhoodLat: (s.class.venue.neighborhood as any)?.latitude ?? null,
      neighborhoodLng: (s.class.venue.neighborhood as any)?.longitude ?? null,
      rating: s.class.venue.avgRating,
      totalReviews: s.class.venue.totalReviews,
    }))

    // Nearby sort
    const userNbId = parseIntSafe(userNeighborhoodId)
    if (sort === 'nearby' && userNbId) {
      const userNeighborhood = await prisma.neighborhood.findUnique({
        where: { id: userNbId },
        select: { latitude: true, longitude: true },
      })
      if (userNeighborhood?.latitude && userNeighborhood?.longitude) {
        const dist = (lat1: number, lon1: number, lat2: number, lon2: number) => {
          const R = 6371
          const dLat = (lat2 - lat1) * Math.PI / 180
          const dLon = (lon2 - lon1) * Math.PI / 180
          const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2
          return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
        }
        formattedSessions = formattedSessions.sort((a: any, b: any) => {
          const dA = (a.neighborhoodLat && a.neighborhoodLng)
            ? dist(userNeighborhood.latitude!, userNeighborhood.longitude!, a.neighborhoodLat, a.neighborhoodLng)
            : Infinity
          const dB = (b.neighborhoodLat && b.neighborhoodLng)
            ? dist(userNeighborhood.latitude!, userNeighborhood.longitude!, b.neighborhoodLat, b.neighborhoodLng)
            : Infinity
          return dA - dB
        })
      } else {
        // Fallback: match by neighborhoodId
        formattedSessions = formattedSessions.sort((a: any, b: any) => {
          const aMatch = a.neighborhoodId === userNbId ? 0 : 1
          const bMatch = b.neighborhoodId === userNbId ? 0 : 1
          return aMatch - bMatch
        })
      }
    }

    // Nearby: global mesafe sıralamasından sonra istenen sayfayı dilimle
    if (isNearby) formattedSessions = formattedSessions.slice((pageNum - 1) * pageSize, pageNum * pageSize)

    return res.json({
      sessions: formattedSessions,
      total,
      page: pageNum,
      pageSize,
      hasMore: pageNum * pageSize < total,
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// GET /api/public/for-you — kullanıcının tercihlerine göre kişiselleştirilmiş seanslar
export const getForYouSessions = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId
    if (!userId) return res.json({ sessions: [] })

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { preferredSports: true, preferredNeighborhoods: true },
    })
    const sports = (Array.isArray(user?.preferredSports) ? user!.preferredSports : []) as string[]
    const nbIds = (Array.isArray(user?.preferredNeighborhoods) ? user!.preferredNeighborhoods : []) as number[]
    if (sports.length === 0 && nbIds.length === 0) return res.json({ sessions: [] })

    const orClauses: any[] = []
    if (sports.length > 0) orClauses.push({ category: { in: sports } })
    if (nbIds.length > 0) orClauses.push({ venue: { neighborhoodId: { in: nbIds } } })

    const sessions = await prisma.class_Session.findMany({
      where: {
        status: 'open',
        startsAt: { gte: new Date() },
        class: { isActive: true, venue: { isApproved: true, isActive: true }, OR: orClauses },
      },
      include: {
        class: { include: { sportCategory: true, venue: { include: { neighborhood: { select: { id: true, name: true } } } }, instructor: true } },
      },
      // Ders başına yalnızca EN YAKIN seans — aynı dersin çok seansı "Senin İçin"i domine etmesin
      distinct: ['classId'],
      orderBy: { startsAt: 'asc' },
      take: 40,
    })

    // İlgi skoruna göre sırala: hem spor hem mahalle eşleşeni öne al
    const scored = sessions.map(s => {
      const cat = s.class.sportCategory?.name ?? s.class.category ?? ''
      const sportMatch = sports.includes(cat)
      const nbMatch = s.class.venue.neighborhoodId != null && nbIds.includes(s.class.venue.neighborhoodId)
      return {
        score: (sportMatch ? 1 : 0) + (nbMatch ? 1 : 0),
        session: {
          id: s.id,
          title: s.class.title,
          titleEn: s.class.titleEn ?? null,
          venueId: s.class.venueId,
          venueName: s.class.venue.name,
          venueAddress: s.class.venue.address,
          instructorId: s.class.instructorId ?? null,
          instructorName: s.class.instructor?.fullName ?? null,
          category: cat,
          categoryColor: s.class.sportCategory?.colorHex ?? null,
          startsAt: s.startsAt.toISOString(),
          durationMinutes: s.class.durationMinutes,
          basePrice: s.class.basePrice,
          availableSpots: s.availableSpots,
          capacity: s.class.capacity,
          neighborhood: s.class.venue.neighborhood?.name ?? null,
          neighborhoodId: s.class.venue.neighborhoodId ?? null,
          rating: s.class.venue.avgRating,
          totalReviews: s.class.venue.totalReviews,
        },
      }
    })
    scored.sort((a, b) => b.score - a.score || new Date(a.session.startsAt).getTime() - new Date(b.session.startsAt).getTime())

    return res.json({ sessions: scored.slice(0, 12).map(x => x.session) })
  } catch (err) {
    console.error('getForYouSessions error:', err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// GET /api/public/sessions/:id
export const getSessionById = async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id as string)
    if (isNaN(id)) return res.status(404).json({ error: 'Seans bulunamadı.' })

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

    // Donmuş/onaysız salonun seansı public detayda da görünmesin
    if (!s || !s.class.venue?.isActive || !s.class.venue?.isApproved) {
      return res.status(404).json({ error: 'Seans bulunamadı.' })
    }

    return res.json({
      session: {
        id: s.id,
        title: s.class.title,
        titleEn: s.class.titleEn ?? null,
        description: s.class.description,
        venueId: s.class.venueId,
        venueName: s.class.venue.name,
        venueAddress: s.class.venue.address,
        instructorId: s.class.instructorId ?? null,
        instructorName: s.class.instructor?.fullName ?? null,
        instructorVerified: s.class.instructor?.verified ?? false,
        instructorBio: s.class.instructor?.bio ?? null,
        instructorAvatarUrl: s.class.instructor?.avatarUrl ?? null,
        category: s.class.sportCategory?.name ?? s.class.category ?? '',
        categoryColor: s.class.sportCategory?.colorHex ?? null,
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
      where: { isApproved: true, isActive: true },
      include: {
        sportCategories: { include: { sportCategory: true } },
        neighborhood: true,
        _count: { select: { classes: true } },
      },
      orderBy: { createdAt: 'desc' },
    })

    return res.json({ venues: venues.map(stripVenueSensitive) })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// GET /api/public/venues/:id
export const getVenueById = async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id as string)
    if (isNaN(id)) return res.status(404).json({ error: 'Salon bulunamadı.' })

    // Sadece onaylı + aktif salon public detay sayfasında görünür (donmuş/onaysız → 404)
    const venue = await prisma.venue.findFirst({
      where: { id, isApproved: true, isActive: true },
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

    return res.json({ venue: stripVenueSensitive(venue) })
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
    const id = parseIntSafe(req.params.id)
    if (!id) return res.status(404).json({ error: 'Slot bulunamadı.' })
    const slot = await prisma.dropInSlot.findUnique({
      where: { id },
      select: {
        // privateCode ve bookedBy KASITEN yok — gizli slotun kodu public'e sızmamalı
        id: true, venueId: true, sportCategoryId: true, title: true, startsAt: true, endsAt: true,
        format: true, totalPlayers: true, currentPlayers: true, totalPrice: true, pricePerPerson: true,
        status: true, visibility: true, createdAt: true,
        venue: { select: { id: true, name: true, address: true } },
        sportCategory: { select: { name: true, colorHex: true, iconUrl: true } },
        participants: {
          where: { status: 'confirmed' },
          select: {
            id: true,
            team: true,
            user: { select: { id: true, username: true, fullName: true, avatarUrl: true } }
          }
        },
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
    const categories = await cached('categories', 300000, () => prisma.sportCategory.findMany({
      orderBy: { name: 'asc' },
    }))

    return res.json({ categories })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// GET /api/public/cities — il listesi (alfabetik)
export const getCities = async (req: Request, res: Response) => {
  try {
    const cities = await cached('cities', 300000, () => prisma.city.findMany({
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }))
    return res.json({ cities })
  } catch (err) {
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// GET /api/public/neighborhoods?cityId=X — cityId verilirse o ilin ilçeleri, yoksa İstanbul (geriye uyum)
export const getNeighborhoods = async (req: Request, res: Response) => {
  try {
    const cid = parseInt(String(req.query.cityId))
    const hasCity = !!cid && !isNaN(cid)
    const where = hasCity ? { cityId: cid } : { city: { name: 'İstanbul' } }
    const key = hasCity ? `neighborhoods:${cid}` : 'neighborhoods:istanbul'
    const neighborhoods = await cached(key, 300000, () => prisma.neighborhood.findMany({
      where,
      select: { id: true, name: true, cityId: true },
      orderBy: { name: 'asc' },
    }))
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
    const username = String(req.params.username)

    const userForTier = await prisma.user.findUnique({ where: { username }, select: { id: true } })
    if (userForTier) {
      try {
        await syncUserTier(userForTier.id)
      } catch (e) {
        console.error('Tier sync error:', e)
      }
    }

    const user = await prisma.user.findUnique({
      where: { username },
      select: {
        id: true, username: true, fullName: true, avatarUrl: true,
        activityPrivacy: true, profilePrivacy: true, banned: true,
        neighborhood: { select: { name: true } },
        tier: { select: { name: true, pointRate: true, colorHex: true, iconUrl: true } },
        totalLessonsCompleted: true,
        recordStreak: true,
        preferredSports: true,
        badges: {
          select: {
            id: true,
            earnedAt: true,
            rank: true,
            seasonKey: true,
            scopeType: true,
            scopeId: true,
            badge: { select: { key: true, name: true, description: true, iconUrl: true } },
            sportCategory: { select: { name: true } },
          },
          orderBy: { earnedAt: 'desc' },
        },
      }
    })

    if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' })
    // Banlı kullanıcının public profili görünmesin
    if (user.banned) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' })
    delete (user as any).banned

    // GİZLİ HESAP (profilePrivacy=private): içeriği yalnızca SAHİBİ veya ONAYLI TAKİPÇİ görür.
    // Diğerlerine sadece temel kimlik (isim/avatar/tier/ilçe) + "gizli" işareti döner.
    const viewerId = (req as any).userId
    const isOwner = !!viewerId && viewerId === user.id
    let isAcceptedFollower = false
    if (viewerId && !isOwner) {
      const f = await prisma.follow.findUnique({
        where: { followerId_followingId: { followerId: viewerId, followingId: user.id } },
        select: { status: true },
      })
      isAcceptedFollower = f?.status === 'accepted'
    }
    if (user.profilePrivacy === 'private' && !isOwner && !isAcceptedFollower) {
      return res.json({
        user: { id: user.id, username: user.username, fullName: user.fullName, avatarUrl: user.avatarUrl, tier: user.tier, neighborhood: user.neighborhood, profilePrivacy: 'private' },
        isProfilePrivate: true,
        activities: null,
      })
    }

    // Sezon şampiyonu rozetlerine kapsam adı (il/ilçe) + sezon etiketi (TR/EN)
    const champs = (user.badges as any[]).filter(b => b.badge?.key === 'season_champion')
    if (champs.length) {
      const nbIds = [...new Set(champs.filter(c => c.scopeType === 'district').map(c => c.scopeId))] as number[]
      const cityIds = [...new Set(champs.filter(c => c.scopeType === 'city').map(c => c.scopeId))] as number[]
      const [nbs, cities] = await Promise.all([
        nbIds.length ? prisma.neighborhood.findMany({ where: { id: { in: nbIds } }, select: { id: true, name: true } }) : Promise.resolve([]),
        cityIds.length ? prisma.city.findMany({ where: { id: { in: cityIds } }, select: { id: true, name: true } }) : Promise.resolve([]),
      ])
      const nbMap = new Map(nbs.map(n => [n.id, n.name]))
      const cityMap = new Map(cities.map(c => [c.id, c.name]))
      for (const c of champs) {
        c.scopeName = c.scopeType === 'district' ? (nbMap.get(c.scopeId) || '') : (cityMap.get(c.scopeId) || '')
        const s = seasonLabelsFromKey(c.seasonKey)
        c.seasonLabel = s.label
        c.seasonLabelEn = s.labelEn
      }
    }

    // If private, return user info only (no activities)
    if (user.activityPrivacy === 'private') {
      return res.json({ user, activities: null, isPrivate: true })
    }

    // Fetch bookings — YALNIZCA gösterim alanları (checkInCode/finansal alanlar public'e SIZMAMALI)
    const bookings = await prisma.booking.findMany({
      where: { userId: user.id, status: 'confirmed' },
      select: {
        id: true,
        createdAt: true,
        status: true,
        groupSize: true,
        session: {
          select: {
            startsAt: true,
            class: {
              select: {
                title: true, titleEn: true, category: true,
                sportCategory: { select: { name: true, iconUrl: true, colorHex: true } },
                venue: { select: { id: true, name: true } },
              }
            }
          }
        }
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    })

    // Fetch drop-in participations — yalnızca gösterim alanları
    const dropIns = await prisma.dropInParticipant.findMany({
      where: { userId: user.id, status: 'confirmed' },
      select: {
        id: true,
        joinedAt: true,
        status: true,
        slot: {
          select: {
            startsAt: true, title: true,
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


export const submitComplaint = async (req: Request, res: Response) => {
  try {
    const { name, email, subject, message } = req.body
    if (!name || !email || !subject || !message) {
      return res.status(400).json({ error: 'Tüm alanlar zorunludur.' })
    }
    if (message.length > 2000) {
      return res.status(400).json({ error: 'Mesaj en fazla 2000 karakter olabilir.' })
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Geçerli bir email adresi girin.' })
    }
    // 1. Kalıcı kayıt — e-posta gitmese/atlansa bile şikayet kaybolmaz (admin panelinden görülür)
    await prisma.complaint.create({
      data: {
        name: String(name).slice(0, 200),
        email: String(email).slice(0, 200),
        subject: String(subject).slice(0, 200),
        message: String(message).slice(0, 2000),
      },
    })
    // 2. E-posta bildirimi best-effort (gönderim hatası şikayeti/isteği DÜŞÜRMEZ)
    sendComplaintEmail(name, email, subject, message).catch(err => console.error('Complaint email error:', err))
    return res.json({ message: 'Şikayetiniz iletildi. En kısa sürede dönüş yapacağız.' })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// Kullanıcı arama (etiketleme için autocomplete)
export const searchUsers = async (req: Request, res: Response) => {
  try {
    const q = (req.query.q as string || '').trim().replace(/^@/, '')
    if (!q || q.length < 2) return res.json({ users: [] })

    const users = await prisma.user.findMany({
      where: {
        banned: false, // banlı hesap public aramada görünmesin
        OR: [
          { username: { contains: q, mode: 'insensitive' } },
          { fullName: { contains: q, mode: 'insensitive' } },
        ]
      },
      select: { username: true, fullName: true, avatarUrl: true },
      take: 8,
    })

    return res.json({ users })
  } catch (err) {
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

export const getInstructorById = async (req: Request, res: Response) => {
  try {
    const instructorId = parseInt(String(req.params.id), 10)
    const instructor = await prisma.instructor.findUnique({
      where: { id: instructorId },
      include: {
        venue: {
          select: { id: true, name: true, neighborhood: { select: { name: true } } }
        },
        classes: {
          where: { isActive: true },
          include: {
            sportCategory: { select: { name: true, colorHex: true } },
            sessions: {
              where: { startsAt: { gte: new Date() }, status: 'open' },
              orderBy: { startsAt: 'asc' },
              take: 1,
              select: { id: true, startsAt: true, availableSpots: true }
            }
          }
        },
        reviews: {
          where: { targetType: 'instructor' },
          orderBy: { createdAt: 'desc' },
          take: 20,
          include: { reviewer: { select: { fullName: true, avatarUrl: true } } }
        }
      }
    })

    if (!instructor) return res.status(404).json({ error: 'Eğitmen bulunamadı.' })

    const avgRating = instructor.reviews.length > 0
      ? instructor.reviews.reduce((s, r) => s + r.rating, 0) / instructor.reviews.length
      : 0

    // optionalAuth: private hoca yanıtı yalnız yorumu yazana görünür
    const viewerId = (req as any).userId as number | undefined
    const safeReviews = instructor.reviews.map(r => hidePrivateReply(r, sanitizeReview(r), viewerId))

    return res.json({
      instructor: {
        ...instructor,
        reviews: safeReviews,
        avgRating: Math.round(avgRating * 10) / 10,
        totalReviews: instructor.reviews.length
      }
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}
