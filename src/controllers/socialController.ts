import { Request, Response } from 'express'
import prisma from '../utils/prisma'
import { sendPushNotification } from '../utils/push'
import { longestDailyStreak, currentDailyStreak, currentWeeklyStreak } from '../utils/streak'
import { cached } from '../utils/cache'
import { seasonInfo } from '../utils/season'
import { parseIntSafe } from '../utils/validate'
import { notifyFields, notifyPush, notifyText } from '../utils/notifyText'
import { Locale } from '../utils/locale'

// Liderlik/sıralama sorgu paramlarını NORMALIZE et. Aksi halde doğrulanmamış ?branch=<rastgele> her istekte
// YENİ cache anahtarı üretip 45sn cache'i baypas ediyor + tüm-kullanıcı taramasını tetikliyordu (DoS + bellek).
// branch yalnız GERÇEK bir kategori adıysa geçer (yoksa yok sayılır → aynı cache anahtarı); neighborhoodId sayısal.
async function normalizeLbParams(req: Request): Promise<{ branch?: string; neighborhoodId?: number }> {
  const cats = await cached('cat-names', 300000, () => prisma.sportCategory.findMany({ select: { name: true } })) as { name: string }[]
  const b = typeof req.query.branch === 'string' ? req.query.branch : undefined
  const branch = b && cats.some(c => c.name === b) ? b : undefined
  const nid = parseIntSafe(req.query.neighborhoodId)
  return { branch, neighborhoodId: nid && nid > 0 ? nid : undefined }
}

export const followUser = async (req: Request, res: Response) => {
  try {
    const followerId = (req as any).userId
    const username = String(req.params.username)
    const target = await prisma.user.findUnique({ where: { username }, select: { id: true, profilePrivacy: true, pushToken: true, locale: true } })
    if (!target) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' })
    if (target.id === followerId) return res.status(400).json({ error: 'Kendinizi takip edemezsiniz.' })

    const existing = await prisma.follow.findUnique({ where: { followerId_followingId: { followerId, followingId: target.id } } })
    if (existing) return res.status(400).json({ error: existing.status === 'pending' ? 'İstek zaten gönderildi.' : 'Zaten takip ediyorsunuz.', status: existing.status })

    // Gizli profil → istek (pending); açık profil → doğrudan kabul (accepted)
    const isPrivate = target.profilePrivacy === 'private'
    const status = isPrivate ? 'pending' : 'accepted'
    await prisma.follow.create({ data: { followerId, followingId: target.id, status } })

    // Hedefe bildirim (uygulama içi + push) — takipçiye/isteğe göre. Metin ALICININ diliyle üretilir.
    const me = await prisma.user.findUnique({ where: { id: followerId }, select: { username: true } })
    const loc = (target.locale || 'tr') as Locale
    const key = isPrivate ? 'follow_request' : 'follow'
    const params = { username: me?.username || '' }
    await prisma.notification.create({ data: { userId: target.id, type: key, ...notifyFields(loc, key, params), relatedUserId: followerId } }).catch(() => {})
    const push = notifyPush(loc, key, params)
    if (target.pushToken && push) sendPushNotification(target.pushToken, push.title, push.body).catch(() => {})

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
    const follower = await prisma.user.findUnique({ where: { username }, select: { id: true, pushToken: true, locale: true } })
    if (!follower) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' })
    const upd = await prisma.follow.updateMany({ where: { followerId: follower.id, followingId: userId, status: 'pending' }, data: { status: 'accepted' } })
    if (upd.count === 0) return res.status(404).json({ error: 'Bekleyen istek yok.' })
    const me = await prisma.user.findUnique({ where: { id: userId }, select: { username: true } })
    const fLoc = (follower.locale || 'tr') as Locale
    const fParams = { username: me?.username || '' }
    await prisma.notification.create({ data: { userId: follower.id, type: 'follow_accept', ...notifyFields(fLoc, 'follow_accept', fParams), relatedUserId: userId } }).catch(() => {})
    const fPush = notifyPush(fLoc, 'follow_accept', fParams)
    if (follower.pushToken && fPush) sendPushNotification(follower.pushToken, fPush.title, fPush.body).catch(() => {})
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
      take: 300, // bekleyen istek listesi sınırsız yüklenmesin (spam istek seli)
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
    const target = await prisma.user.findUnique({ where: { username }, select: { id: true, profilePrivacy: true } })
    if (!target) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' })

    const follow = await prisma.follow.findUnique({ where: { followerId_followingId: { followerId, followingId: target.id } } })
    // GİZLİ PROFİL + yabancı: takipçi/takip SAYAÇLARI da gösterilmez (yalnız kimlik). Buton için takip durumu döner.
    const canView = target.profilePrivacy !== 'private' || followerId === target.id || follow?.status === 'accepted'
    if (!canView) {
      return res.json({ isFollowing: false, followStatus: follow?.status || 'none', followers: null, following: null, isProfilePrivate: true })
    }
    // Sayaçlar SADECE kabul edilmiş (accepted) ilişkileri sayar — pending istekler dahil değil
    // banned:false — sayaçlar getFollowers/getFollowing LİSTELERİYLE tutarlı olmalı (listeler banlıyı eler);
    // aksi halde banlı takipçi sayaçta kalıp "10 takipçi ama listede 9" tutarsızlığı oluşurdu.
    const followers = await prisma.follow.count({ where: { followingId: target.id, status: 'accepted', follower: { banned: false } } })
    const following = await prisma.follow.count({ where: { followerId: target.id, status: 'accepted', following: { banned: false } } })
    return res.json({ isFollowing: follow?.status === 'accepted', followStatus: follow?.status || 'none', followers, following })
  } catch (err) { return res.status(500).json({ error: 'Sunucu hatası.' }) }
}

// Gizli hesabın içeriğini (takipçi/takip listeleri) yalnızca SAHİBİ veya ONAYLI TAKİPÇİ görebilir
async function canViewProfile(viewerId: number | undefined, target: { id: number; profilePrivacy: string | null }): Promise<boolean> {
  if (target.profilePrivacy !== 'private') return true
  if (!viewerId) return false
  if (viewerId === target.id) return true
  const f = await prisma.follow.findUnique({ where: { followerId_followingId: { followerId: viewerId, followingId: target.id } }, select: { status: true } })
  return f?.status === 'accepted'
}

export const getFollowers = async (req: Request, res: Response) => {
  try {
    const username = String(req.params.username)
    const user = await prisma.user.findUnique({ where: { username }, select: { id: true, profilePrivacy: true } })
    if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' })
    if (!(await canViewProfile((req as any).userId, user))) return res.json({ followers: [], isProfilePrivate: true })

    const follows = await prisma.follow.findMany({
      // banlı hesap listede görünmesin (searchUsers/getUserActivities ile aynı kural)
      where: { followingId: user.id, status: 'accepted', follower: { banned: false } },
      include: { follower: { select: { id: true, username: true, fullName: true, avatarUrl: true, tier: { select: { name: true, colorHex: true, iconUrl: true } } } } },
      // SESSİZ KESME ÖNLEME: LIMIT+1 çekip fazlalık varsa `hasMore` bildiririz (ek COUNT sorgusu
      // açmadan). Eskiden yanıtta hiçbir sinyal yoktu → liste 500'de kesilse istemci bunu ASLA
      // öğrenemiyordu (kullanıcı "takipçilerim eksik" der, hiçbir yerde iz olmazdı).
      take: 501,
    })
    const fHasMore = follows.length > 500
    return res.json({ followers: follows.slice(0, 500).map(f => f.follower), hasMore: fHasMore, limit: 500 })
  } catch (err) { return res.status(500).json({ error: 'Sunucu hatası.' }) }
}

export const getFollowing = async (req: Request, res: Response) => {
  try {
    const username = String(req.params.username)
    const user = await prisma.user.findUnique({ where: { username }, select: { id: true, profilePrivacy: true } })
    if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' })
    if (!(await canViewProfile((req as any).userId, user))) return res.json({ following: [], isProfilePrivate: true })

    const follows = await prisma.follow.findMany({
      // banlı hesap listede görünmesin (searchUsers/getUserActivities ile aynı kural)
      where: { followerId: user.id, status: 'accepted', following: { banned: false } },
      include: { following: { select: { id: true, username: true, fullName: true, avatarUrl: true, tier: { select: { name: true, colorHex: true, iconUrl: true } } } } },
      take: 501, // LIMIT+1 → sessiz kesme yerine hasMore sinyali (yukarıdaki takipçi ucuyla aynı desen)
    })
    const gHasMore = follows.length > 500
    return res.json({ following: follows.slice(0, 500).map(f => f.following), hasMore: gHasMore, limit: 500 })
  } catch (err) { return res.status(500).json({ error: 'Sunucu hatası.' }) }
}

// Kullanıcı liderlik tablosu
export const getUserLeaderboard = async (req: Request, res: Response) => {
  try {
    const { branch, neighborhoodId } = await normalizeLbParams(req)
    const season = seasonInfo()

    const ranked = await cached(`lb-users:${season.key}:${branch || ''}:${neighborhoodId || ''}`, 45000, async () => {
      // Liderlik her MEVSİM sıfırlanır: sadece bu sezondaki (mevsim başından beri) dersler sayılır
      const seasonStart = season.start
      const now = new Date()
      // Sıralama HERKESE açık (Instagram mantığı): profili/aktivitesi gizli olsa da username+avatarla görünür,
      // tıklanıp takip isteği atılabilir. Yalnız BANLI hariç. Gizlilik yalnız profil-detayında/aktivitede uygulanır.
      // Yalnızca bu sezon EN AZ 1 nitelikli (checkedIn, geçmiş, branş) aktivitesi olan kullanıcıları yükle.
      // Aksi halde TÜM kullanıcı tabanı (çoğu 0 dersli) belleğe çekilip JS'te filtrelenirdi → ölçekte ağır.
      const bookingFilter = {
        status: 'confirmed' as const,
        checkedIn: true,
        session: {
          startsAt: { gte: seasonStart, lt: now },
          ...(branch ? { class: { sportCategory: { name: branch as string } } } : {}), // KANONIK FK (championJob ile ayni); serbest-metin class.category case-sensitive drift uretiyordu
        },
      }
      // GAMING ÖNLEME: liderlik yalnızca GERÇEKTEN gidilen (checkedIn) + geçmiş aktiviteleri sayar.
      // Drop-in katılımları da SAYILIR: streak liderliği (getStreakLeaderboard) zaten drop-in'i sayıyordu;
      // ders liderliği saymayınca ikisi çelişiyordu → aynı nitelikli filtreyle drop-in de eklendi.
      const dropinFilter = {
        status: 'confirmed' as const,
        checkedIn: true,
        slot: {
          startsAt: { gte: seasonStart, lt: now },
          ...(branch ? { sportCategory: { name: branch as string } } : {}),
        },
      }
      const users = await prisma.user.findMany({
        where: {
          banned: false,
          ...(neighborhoodId ? { neighborhoodId } : {}),
          OR: [
            { bookings: { some: bookingFilter } },
            { dropInParticipants: { some: dropinFilter } },
          ],
        },
        select: {
          id: true,
          username: true,
          avatarUrl: true,
          neighborhoodId: true,
          neighborhood: { select: { name: true } },
          tier: { select: { name: true, colorHex: true, iconUrl: true } },
          bookings: { where: bookingFilter, select: { id: true } },
          dropInParticipants: { where: dropinFilter, select: { id: true } },
        }
      })
      return users
        .map(u => ({ ...u, lessonCount: u.bookings.length + u.dropInParticipants.length, bookings: undefined, dropInParticipants: undefined }))
        .filter(u => u.lessonCount > 0)
        .sort((a, b) => (b.lessonCount - a.lessonCount) || (a.id - b.id)) // esitlikte deterministik: kucuk id once
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
    const { branch, neighborhoodId } = await normalizeLbParams(req)
    const now = new Date()
    const season = seasonInfo(now)

    const ranked = await cached(`lb-streak:${season.key}:${branch || ''}:${neighborhoodId || ''}`, 45000, async () => {
    const users = await prisma.user.findMany({
      where: {
        // Streak sıralaması da HERKESE açık (yalnız banlı hariç) — liderlikle aynı Instagram mantığı.
        banned: false,
        ...(neighborhoodId ? { neighborhoodId } : {}),
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
              ...(branch ? { class: { sportCategory: { name: branch as string } } } : {}), // KANONIK FK (championJob ile ayni); serbest-metin class.category case-sensitive drift uretiyordu
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
      .sort((a, b) => (b.streak - a.streak) || (a.id - b.id)) // esitlikte deterministik ikincil anahtar
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
    const now = new Date()

    // Yalnız GEÇMİŞ (startsAt <= now) + check-in yapılmış aktiviteler seriyi/takvimi besler. Check-in
    // penceresi seans başlangıcından 1 saat ÖNCE açıldığı için, henüz başlamamış bir seansta check-in
    // yapılmış olabilir → startsAt filtresi olmadan gelecekteki bir gün seriye/güncel-streak'e sayılıp
    // dailyStreak/weeklyStreak'i yapay şişirirdi. (startsAt<now, leaderboard/champion ile tutarlı.)
    const [bookings, dropins] = await Promise.all([
      prisma.booking.findMany({
        where: { userId, checkedIn: true, bookingType: 'class', session: { startsAt: { lte: now } } },
        select: { session: { select: { startsAt: true, class: { select: { category: true, title: true } } } } },
      }),
      prisma.dropInParticipant.findMany({
        where: { userId, checkedIn: true, slot: { startsAt: { lte: now } } },
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
    const { branch, neighborhoodId } = await normalizeLbParams(req)

    const venues = await cached(`lb-venue:${branch || ''}:${neighborhoodId || ''}`, 45000, async () => {
      const rows = await prisma.venue.findMany({
        where: {
          isApproved: true,
          ...(neighborhoodId ? { neighborhoodId } : {}),
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
      })
      // MİN-GÜVEN SIRALAMA (Wilson %95 alt sınırı): ham avgRating DESC ile 1 yorumlu 5.0'lık bir salon,
      // 200 yorumlu 4.8'lik köklü salonu geçiyordu (istatistiksel gürültü). Puanı [0,1]'e normalize edip
      // (p = (r-1)/4) yorum sayısına göre Wilson alt güven sınırını hesaplarız: AZ yorum = GENİŞ belirsizlik
      // = DÜŞÜK alt sınır → tek parlak yorumla zirveye çıkılamaz, köklü/çok-yorumlu salon öne geçer (Evan
      // Miller, "How Not To Sort By Average Rating"). NOT: Bayesian nokta-tahmini bunu çözmez — ortalamanın
      // ÜSTÜNDEKİ az-yorumlu salon, ortalamaya çekilse bile ortalama-seviyeli çok-yorumluyu geçebilir; alt
      // sınır belirsizliği cezalandırdığı için doğru araçtır. Yorumsuz (n=0) salon liderlikte YER ALMAZ.
      const z = 1.96, z2 = z * z
      const wilson = (r: number, n: number) => {
        if (n <= 0) return 0
        const p = Math.min(1, Math.max(0, (r - 1) / 4)) // 1..5 yıldız → 0..1 oran
        const denom = 1 + z2 / n
        const center = p + z2 / (2 * n)
        const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)
        return (center - margin) / denom
      }
      const rated = rows.filter(v => (v.totalReviews || 0) > 0)
      if (rated.length === 0) return []
      return rated
        .map(v => ({ v, s: wilson(v.avgRating || 0, v.totalReviews || 0) }))
        .sort((a, b) => (b.s - a.s) || ((b.v.totalReviews || 0) - (a.v.totalReviews || 0)) || (a.v.id - b.v.id)) // eşitlikte çok-yorumlu, sonra küçük id
        .slice(0, 50)
        .map(x => x.v)
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
      where: { followerId: userId, status: 'accepted' }, // sadece KABUL edilmiş takipler
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
          // Yalnız gizli-değil + banlı-değil kullanıcılar çözülür; private/banlı etiketlenenler
          // feed'de HİÇ gösterilmez (gerçek ad + ders katılımı sızmasın — feed owner filtresiyle aynı).
          where: { username: { in: allTaggedUsernames, mode: 'insensitive' }, activityPrivacy: { not: 'private' }, banned: false },
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
          .map(u => taggedMap.get(String(u).replace(/^@/, '').toLowerCase()))
          // Çözülemeyen (private/banlı/olmayan) etiket feed'de gösterilmez — ham username bile sızmaz
          .filter((f): f is { username: string; fullName: string } => !!f)
          .map(f => ({ username: f.username, fullName: f.fullName }))
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
  // banned kontrolü: banlı sahibin aktivitesi feed'den zaten eleniyor ama feedKey enumerasyonuyla
  // like/comment edilip banlı sahibe bildirim/push gidebiliyordu → banlı sahibe null dön (etkileşim 404).
  if (prefix === 'b') {
    const b = await prisma.booking.findUnique({ where: { id }, select: { user: { select: { id: true, activityPrivacy: true, banned: true } } } })
    return b?.user && !b.user.banned ? { ownerId: b.user.id, privacy: b.user.activityPrivacy } : null
  }
  if (prefix === 'd') {
    const d = await prisma.dropInParticipant.findUnique({ where: { id }, select: { user: { select: { id: true, activityPrivacy: true, banned: true } } } })
    return d?.user && !d.user.banned ? { ownerId: d.user.id, privacy: d.user.activityPrivacy } : null
  }
  if (prefix === 'bg') {
    const bg = await prisma.userBadge.findUnique({ where: { id }, select: { user: { select: { id: true, activityPrivacy: true, banned: true } } } })
    return bg?.user && !bg.user.banned ? { ownerId: bg.user.id, privacy: bg.user.activityPrivacy } : null
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
    // Gizli aktivite: 403 DEĞİL 404 — "var ama gizli" ile "hiç yok" ayırt edilmemeli (existence-oracle).
    if (activity.privacy === 'private' && activity.ownerId !== userId) {
      return res.status(404).json({ error: 'Aktivite bulunamadı.' })
    }

    const existing = await prisma.activityLike.findUnique({ where: { feedKey_userId: { feedKey, userId } } })
    if (existing) return res.status(400).json({ error: 'Zaten beğendiniz.' })

    await prisma.activityLike.create({ data: { feedKey, userId } })

    // Bildirim best-effort: hata like'ı 500'e çevirmesin (like zaten commit oldu)
    const ownerId = activity.ownerId
    if (ownerId && ownerId !== userId) {
      try {
        // Bildirim seli önlemi: aynı beğenen→sahip çifti için son 1 saatte 'like' bildirimi varsa tekrar
        // oluşturma/push atma. like→unlike→like döngüsü existing-like guard'ını her turda geçtiğinden,
        // dedup olmadan Notification tablosu şişer + sahibin cihazına push seli gider (feedLimiter yalnızca yavaşlatır).
        const recentLike = await prisma.notification.findFirst({
          where: { userId: ownerId, type: 'like', relatedUserId: userId, createdAt: { gte: new Date(Date.now() - 60 * 60 * 1000) } },
          select: { id: true },
        })
        if (!recentLike) {
          const liker = await prisma.user.findUnique({ where: { id: userId }, select: { fullName: true } })
          const owner = await prisma.user.findUnique({ where: { id: ownerId }, select: { pushToken: true, locale: true } })
          const oLoc = (owner?.locale || 'tr') as Locale
          // Ad boşsa anonim etiketi de ALICININ diliyle ("Bir kullanıcı" / "Someone")
          const lParams = { name: liker?.fullName || notifyText(oLoc, 'anonymous_user') }
          await prisma.notification.create({
            data: { userId: ownerId, type: 'like', ...notifyFields(oLoc, 'like', lParams), relatedUserId: userId },
          })
          const lPush = notifyPush(oLoc, 'like', lParams)
          if (owner?.pushToken && lPush) {
            sendPushNotification(owner.pushToken, lPush.title, lPush.body).catch(() => {})
          }
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
    // Gizlilik: gizli aktivitenin yorumları yalnızca sahibine görünür (like/comment yazma ile aynı guard)
    const viewerId = (req as any).userId
    const activity = await resolveFeedActivity(feedKey)
    if (!activity) return res.status(404).json({ error: 'Aktivite bulunamadı.' })
    if (activity.privacy === 'private' && activity.ownerId !== viewerId) {
      return res.status(404).json({ error: 'Aktivite bulunamadı.' })
    }
    const all = await prisma.activityComment.findMany({
      where: { feedKey },
      include: { user: { select: { username: true, fullName: true, avatarUrl: true } } },
      orderBy: { createdAt: 'asc' },
      take: 500, // tek aktivitedeki yorumlar sınırsız yüklenip her okumada JS'te ağaç kurulmasın
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
    // Gizli aktivite: 403 DEĞİL 404 — "var ama gizli" ile "hiç yok" ayırt edilmemeli (existence-oracle).
    if (activity.privacy === 'private' && activity.ownerId !== userId) {
      return res.status(404).json({ error: 'Aktivite bulunamadı.' })
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
      // Yoruma cevap verildi — yorumu yazana bildirim. type 'comment' KALIR (istemci yönlendirmesi
      // buna bakıyor); ayrışma metin anahtarında: comment_reply vs comment.
      const parentUser = await prisma.user.findUnique({ where: { id: parentComment.userId }, select: { pushToken: true, locale: true } })
      const pLoc = (parentUser?.locale || 'tr') as Locale
      const pParams = { name: commenter?.fullName || notifyText(pLoc, 'anonymous_user'), excerpt: comment.content.slice(0, 80) }
      await prisma.notification.create({
        data: { userId: parentComment.userId, type: 'comment', ...notifyFields(pLoc, 'comment_reply', pParams), relatedUserId: userId },
      })
      const pPush = notifyPush(pLoc, 'comment_reply', pParams)
      if (parentUser?.pushToken && pPush) {
        sendPushNotification(parentUser.pushToken, pPush.title, pPush.body).catch(() => {})
      }
    } else if (!parentComment) {
      // Yeni üst seviye yorum — aktivite sahibine bildirim
      const ownerId = activity.ownerId
      if (ownerId && ownerId !== userId) {
        const owner = await prisma.user.findUnique({ where: { id: ownerId }, select: { pushToken: true, locale: true } })
        const cLoc = (owner?.locale || 'tr') as Locale
        const cParams = { name: commenter?.fullName || notifyText(cLoc, 'anonymous_user'), excerpt: comment.content.slice(0, 80) }
        await prisma.notification.create({
          data: { userId: ownerId, type: 'comment', ...notifyFields(cLoc, 'comment', cParams), relatedUserId: userId },
        })
        const cPush = notifyPush(cLoc, 'comment', cParams)
        if (owner?.pushToken && cPush) {
          sendPushNotification(owner.pushToken, cPush.title, cPush.body).catch(() => {})
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
    // İlgili kullanıcıyı ekle (bildirimden profile gidilebilsin + avatar)
    const relIds = [...new Set(notifications.map(n => n.relatedUserId).filter(Boolean))] as number[]
    const relUsers = relIds.length
      ? await prisma.user.findMany({ where: { id: { in: relIds }, banned: false }, select: { id: true, username: true, fullName: true, avatarUrl: true } })
      : []
    const uMap = new Map(relUsers.map(u => [u.id, u]))
    // follow_request bildirimi hâlâ bekliyor mu? (kabul/ret sonrası buton gösterme)
    const pendingReqFollowerIds = new Set(
      (await prisma.follow.findMany({ where: { followingId: userId, status: 'pending' }, select: { followerId: true } })).map(f => f.followerId)
    )
    const enriched = notifications.map(n => ({
      ...n,
      relatedUser: n.relatedUserId ? uMap.get(n.relatedUserId) || null : null,
      requestPending: n.type === 'follow_request' && n.relatedUserId ? pendingReqFollowerIds.has(n.relatedUserId) : false,
    }))
    const unreadCount = await prisma.notification.count({ where: { userId, isRead: false } })
    return res.json({ notifications: enriched, unreadCount })
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
