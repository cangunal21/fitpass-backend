import { Request, Response } from 'express'
import prisma from '../utils/prisma'
import { sendComplaintEmail } from '../utils/email'
import { syncUserTier } from '../utils/tier'
import { cached } from '../utils/cache'
import { parseIntSafe, parseDateSafe } from '../utils/validate'
import { sanitizeReview, hidePrivateReply } from '../utils/reviews'
import { seasonLabelsFromKey } from '../utils/season'
import { stripVenueSensitive, stripInstructorSensitive } from '../utils/sanitize'
import { trInstant, trAddDays } from '../utils/trFormat'
import { getOccupancyMap, getOccupancy, spotsLeftOf } from '../utils/occupancy'
// SATICI KAPISI — salonlu ve mekânsız hoca dersini birlikte kapsar; kapıyı elle yazma.
import { classLiveWhere, deliveryWhere, parseDeliveryMode, sellerBlocked, sellerCardFields, IN_PERSON_ONLY, instructorLiveWhere } from '../utils/seller'
// API SÖZLEŞMESİ — üç repoda birebir aynı dosya. Yanıt tipini imzaya yazmak, sunucunun
// gerçekten o şekli döndürdüğünü tsc'ye DOĞRULATIR (alan silinir/tipi değişirse build kırılır).
import type { SessionListResponse, SessionDetailResponse, ForYouResponse, VenueListResponse, VenueDetailResponse, ApiError } from '../types/api'

// GET /api/public/sessions
export const getSessions = async (req: Request, res: Response<SessionListResponse | ApiError>) => {
  try {
    const { category, date, dateFrom, dateTo, venueId, neighborhoodId, cityId, search, sort, userNeighborhoodId, page, limit, mode } = req.query
    const pageNum = Math.max(1, parseIntSafe(page) || 1)
    const pageSize = Math.min(50, Math.max(1, parseIntSafe(limit) || 24))
    // "Bana yakın": mesafe bellekte hesaplanır. DB startsAt'a göre sayfalarsa yalnızca sayfa-içi
    // sıralanır (en yakın salon geç seansdaysa 1. sayfada çıkmaz). Bu yüzden nearby'de tüm eşleşen
    // seansları (üst sınırla) çekip GLOBAL mesafeye göre sıralayıp SONRA sayfalıyoruz.
    const isNearby = sort === 'nearby' && !!parseIntSafe(userNeighborhoodId)
    // Query paramları dizi gelebilir (?search=a&search=b) → Prisma string beklerken 500 olurdu.
    // String'e indir; aramayı 80 karaktere cap'le (searchUsers ile tutarlı, DoS/uzun-girdi önlemi).
    const categoryStr = typeof category === 'string' ? category : undefined
    const searchStr = typeof search === 'string' ? search.trim().slice(0, 80) : undefined

    const where: any = {
      status: 'open',
    }

    const dFrom = parseDateSafe(dateFrom)
    const dTo = parseDateSafe(dateTo)
    const dExact = parseDateSafe(date)
    const now = new Date()
    // Saatsiz 'YYYY-MM-DD' girdisi İSTANBUL gününü ifade eder. parseDateSafe bunu UTC gece yarısı
    // yapıyordu → pencere İstanbul'da 03:00–03:00'a kayıyor, gece seansları yanlış güne düşüyordu
    // (İstanbul 5 Ağu 01:00 dersi "4 Ağustos" filtresinde çıkıyor, "5 Ağustos"ta hiç görünmüyordu).
    const isYmd = (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
    const asTrDay = (v: unknown, parsed?: Date) => (isYmd(v) ? trInstant(String(v), '00:00') : parsed)

    if (dFrom || dTo) {
      where.startsAt = {}
      const from = asTrDay(dateFrom, dFrom)
      // gte'yi ŞİMDİ ile kısıtla. Aksi halde "Bugün" filtresi günün başından itibaren sorguluyor ve
      // SABAH BİTMİŞ seanslar listede "Rezerve et" ile çıkıyor; kullanıcı tıklayınca createBooking
      // 400 "Bu seans başlamış" diyor. Filtre gün başını, rezervasyon kontrolü now'u referans alıyordu.
      if (from) where.startsAt.gte = from > now ? from : now
      if (dTo) where.startsAt.lt = asTrDay(dateTo, dTo)
    } else if (dExact) {
      const start = asTrDay(date, dExact) as Date
      const end = isYmd(date) ? trInstant(trAddDays(String(date), 1), '00:00') : new Date(start.getTime() + 86400000)
      where.startsAt = { gte: start > now ? start : now, lt: end }
    } else {
      where.startsAt = { gte: now }
    }

    // Build class filter
    // Pasife alınan ders listede çıkmasın (getForYou/getVenueById ile tutarlı)
    const classWhere: any = { isActive: true }
    // Kategori, Class.category metin alanıyla filtrelenir (sportCategoryId null olabilir)
    if (categoryStr) classWhere.category = { equals: categoryStr, mode: 'insensitive' }
    const vId = parseIntSafe(venueId)
    if (vId) classWhere.venueId = vId
    const nId = parseIntSafe(neighborhoodId)
    const cId = parseIntSafe(cityId)

    // TESLİM BİÇİMİ — mode verilmezse VARSAYILAN 'in_person'.
    // Bilerek "hepsi" DEĞİL: mobil ve web ayrı ayrı yayına çıkıyor, güncellenmemiş bir istemci
    // mode göndermediğinde online dersler mesafe/harita yüzeylerine karışırdı. Online opt-in
    // olsun ki sunucu önden çıkabilsin, istemciler arkadan yetişsin.
    const deliveryMode = parseDeliveryMode(mode) ?? 'in_person'

    // Kapılar ve arama AND altında toplanır: `classLiveWhere()` kendi içinde OR kullanıyor,
    // aramanın OR'u ile aynı nesnede buluşursa biri diğerini SESSİZCE ezerdi.
    const and: any[] = [classLiveWhere(), deliveryWhere(deliveryMode)]

    // Konum filtresi YALNIZ salonlu dersleri kapsar: mekânsız/online dersin mahallesi yoktur,
    // `venue.is` null salonda eşleşmediği için bu filtre seçiliyken online dersler doğal olarak
    // listeden düşer — istenen davranış budur (kullanıcı "Kadıköy" diyorsa online istemiyordur).
    if (nId || cId) {
      and.push({ venue: { is: { ...(nId ? { neighborhoodId: nId } : {}), ...(cId ? { cityId: cId } : {}) } } })
    }

    if (searchStr) {
      and.push({
        OR: [
          { title: { contains: searchStr, mode: 'insensitive' } },
          { venue: { is: { name: { contains: searchStr, mode: 'insensitive' } } } },
          { venue: { is: { neighborhood: { name: { contains: searchStr, mode: 'insensitive' } } } } },
          { venue: { is: { address: { contains: searchStr, mode: 'insensitive' } } } },
          // Mekânsız hoca dersinde aranacak tek isim EĞİTMENİNKİDİR — salon adı yok.
          { instructor: { is: { fullName: { contains: searchStr, mode: 'insensitive' } } } },
          { sportCategory: { name: { contains: searchStr, mode: 'insensitive' } } },
        ],
      })
    }
    classWhere.AND = and
    if (Object.keys(classWhere).length > 0) where.class = classWhere

    // PUANA GÖRE SIRALAMA iki kaynaklı: salonlu derste salonun puanı, online (mekânsız) derste
    // EĞİTMENİN puanı. Tek kaynağa bakmak hata vermez ama sessizce anlamsız bir sıra üretir —
    // online modda tüm satırların sıralama anahtarı NULL olurdu (kart puan gösterirken sıra
    // rastgele; kullanıcı "puana göre" dediğini sanır).
    const orderBy: any = sort === 'rating'
      ? (deliveryMode === 'online'
          ? [{ class: { instructor: { avgRating: 'desc' } } }]
          : [{ class: { venue: { avgRating: 'desc' } } }])
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

    // KALAN YER sunucuda hesaplanır: Class_Session.capacity rezervasyonla azalmaz.
    // Tek sorguyla tüm sayfanın doluluğu (N+1 yok).
    const occMap = await getOccupancyMap(sessions.map((s) => s.id))

    let formattedSessions = sessions.map((s) => ({
      id: s.id,
      title: s.class.title,
      titleEn: s.class.titleEn ?? null,
      // Salon/konum/puan alanları TEK yardımcıdan: mekânsız hoca dersinde salon null'lanır ve
      // puan eğitmenden gelir (bkz. utils/seller.ts — üç uçta kopyalanmasın diye).
      ...sellerCardFields(s.class),
      instructorId: s.class.instructorId ?? null,
      instructorName: s.class.instructor?.fullName ?? null,
      deliveryMode: s.class.deliveryMode === 'online' ? ('online' as const) : ('in_person' as const),
      category: s.class.sportCategory?.name ?? s.class.category ?? '',
      categoryColor: s.class.sportCategory?.colorHex ?? null,
      startsAt: s.startsAt.toISOString(),
      durationMinutes: s.class.durationMinutes,
      basePrice: s.class.basePrice,
      spotsLeft: spotsLeftOf(s.capacity, occMap.get(s.id) || 0),
      // DEPRECATED — eskiden TOPLAM KAPASİTE dönüyordu, üç istemci de "kalan yer"
      // sanıp dolu dersi "10 yer kaldı" diye gösteriyordu. Artık adı neyse o:
      // kalan yer. İstemciler spotsLeft'e geçtikten sonra kaldırılacak.
      availableSpots: spotsLeftOf(s.capacity, occMap.get(s.id) || 0),
      // Seansın kendi kapasitesi (eskiden ders varsayılanı dönüyordu; seans
      // kapasitesi düzenlenebildiği için ikisi ayrışabiliyordu).
      capacity: s.capacity,
      // neighborhood* / rating / totalReviews yukarıdaki sellerCardFields yayılımından geliyor.
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
export const getForYouSessions = async (req: Request, res: Response<ForYouResponse | ApiError>) => {
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
        // "Senin İçin" ŞİMDİLİK YALNIZ YÜZ YÜZE. Kişiselleştirmenin iki ayağından biri mahalle
        // ve online dersin mahallesi yok — yalnız spor eşleşmesiyle girip şeridi doldururdu.
        // Online'ın kendi yüzeyi ana sayfadaki "Online dersler" şeridi; burada ikinci kez
        // göstermek aynı dersi iki yerde tekrarlardı. Açmak istenirse: IN_PERSON_ONLY'yi kaldır.
        class: { isActive: true, AND: [classLiveWhere(), IN_PERSON_ONLY], OR: orClauses },
      },
      include: {
        class: { include: { sportCategory: true, venue: { include: { neighborhood: { select: { id: true, name: true } } } }, instructor: true } },
      },
      // Ders başına yalnızca EN YAKIN seans — aynı dersin çok seansı "Senin İçin"i domine etmesin
      distinct: ['classId'],
      orderBy: { startsAt: 'asc' },
      take: 40,
    })

    const occMap = await getOccupancyMap(sessions.map((s) => s.id))

    // İlgi skoruna göre sırala: hem spor hem mahalle eşleşeni öne al
    const scored = sessions.map(s => {
      const cat = s.class.sportCategory?.name ?? s.class.category ?? ''
      const sportMatch = sports.includes(cat)
      const nbId = s.class.venue?.neighborhoodId ?? null
      const nbMatch = nbId != null && nbIds.includes(nbId)
      const seller = sellerCardFields(s.class)
      return {
        score: (sportMatch ? 1 : 0) + (nbMatch ? 1 : 0),
        session: {
          id: s.id,
          title: s.class.title,
          titleEn: s.class.titleEn ?? null,
          venueId: seller.venueId,
          venueName: seller.venueName,
          venueAddress: seller.venueAddress,
          instructorId: s.class.instructorId ?? null,
          instructorName: s.class.instructor?.fullName ?? null,
          deliveryMode: s.class.deliveryMode === 'online' ? ('online' as const) : ('in_person' as const),
          category: cat,
          categoryColor: s.class.sportCategory?.colorHex ?? null,
          startsAt: s.startsAt.toISOString(),
          durationMinutes: s.class.durationMinutes,
          basePrice: s.class.basePrice,
          spotsLeft: spotsLeftOf(s.capacity, occMap.get(s.id) || 0),
          availableSpots: spotsLeftOf(s.capacity, occMap.get(s.id) || 0), // DEPRECATED — bkz. getSessions
          capacity: s.capacity,
          neighborhood: seller.neighborhood,
          neighborhoodId: seller.neighborhoodId,
          rating: seller.rating,
          totalReviews: seller.totalReviews,
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
export const getSessionById = async (req: Request, res: Response<SessionDetailResponse | ApiError>) => {
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

    // Donmuş/onaysız SATICININ seansı public detayda da görünmesin. Kapı artık iki kaynaklı
    // (salon ya da mekânsız hoca) → tek yardımcıdan. 404: "var ama kapalı" ile "yok" ayrımı
    // numaralandırma sinyalidir, ikisi de 404 döner (önceki turların kuralı).
    if (!s || sellerBlocked(s.class)) {
      return res.status(404).json({ error: 'Seans bulunamadı.' })
    }

    const spotsLeft = spotsLeftOf(s.capacity, await getOccupancy(s.id))
    const sellerDetail = sellerCardFields(s.class)

    return res.json({
      session: {
        id: s.id,
        title: s.class.title,
        titleEn: s.class.titleEn ?? null,
        description: s.class.description,
        venueId: sellerDetail.venueId,
        venueName: sellerDetail.venueName,
        venueAddress: sellerDetail.venueAddress,
        // TESLİM BİÇİMİ. `meetingUrl` BURADA YOK ve olmamalı: bu uç public'tir, bağlantıyı
        // görebilen rezervasyonsuz derse girer. Bağlantı yalnız rezervasyon uçlarından döner.
        deliveryMode: s.class.deliveryMode === 'online' ? ('online' as const) : ('in_person' as const),
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
        spotsLeft,
        availableSpots: spotsLeft, // DEPRECATED — bkz. getSessions
        capacity: s.capacity,
        status: s.status,
        neighborhood: sellerDetail.neighborhood,
        rating: sellerDetail.rating,
        totalReviews: sellerDetail.totalReviews,
      },
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// GET /api/public/venues
export const getVenues = async (req: Request, res: Response<VenueListResponse | ApiError>) => {
  try {
    const venues = await prisma.venue.findMany({
      where: { isApproved: true, isActive: true },
      include: {
        sportCategories: { include: { sportCategory: true } },
        neighborhood: true,
        _count: { select: { classes: true } },
      },
      orderBy: { createdAt: 'desc' },
      // LIMIT+1 → kesildiyse `hasMore` bildir (ek COUNT yok). Eskiden sinyal yoktu: katalog 500'ü
      // aşınca istemci sessizce eksik liste gösteriyordu.
      take: 501,
    })

    const vHasMore = venues.length > 500
    // `createdAt` AÇIKÇA ISO dizgiye çevriliyor. Prisma satırında `Date` duruyor ve `res.json`
    // onu zaten ISO'ya çevirirdi — ama o çevrim ÖRTÜKTÜ, yani sözleşme (src/types/api.ts)
    // "string" derken üretici "Date" tutuyordu ve tsc ikisini bağdaştıramıyordu. Açık çevrim
    // tel biçimini kodda görünür kılıyor; çıktı bit bit aynı, kazanç derleyici denetimi.
    const safeVenues = venues.slice(0, 500).map((v) => {
      const temiz = stripVenueSensitive(v)
      return { ...temiz, createdAt: temiz.createdAt.toISOString() }
    })
    return res.json({ venues: safeVenues, hasMore: vHasMore, limit: 500 })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// GET /api/public/venues/:id
export const getVenueById = async (req: Request, res: Response<VenueDetailResponse | ApiError>) => {
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

    // stripVenueSensitive YALNIZ üst-düzey venue kolonlarını siler; iç içe gelen eğitmen objeleri
    // (instructors[] ve classes[].instructor) tam satır taşır → passwordHash/email/phone SIZAR.
    // Her nested eğitmeni ayrıca temizle.
    // ARTIK `any` YOK. Eskiden `const safe: any = ...` idi ve bu, API sözleşmesinin üretici
    // tarafını KÖR ediyordu: `any` her şeye atanabildiği için tsc bu yanıtın şeklini hiç
    // denetleyemiyordu. `Array.isArray` korumaları da o körlüğün ürünüydü — Prisma `include`
    // ettiği ilişkileri her zaman dizi olarak döndürür, tipler bunu zaten garanti ediyor.
    const temiz = stripVenueSensitive(venue)

    // Seanslar bu uçta HAM geliyor; kalan yeri burada da sunucu hesaplamalı
    // (istemci capacity'yi kalan yer sanmasın).
    const vOcc = await getOccupancyMap(venue.classes.flatMap((c) => c.sessions.map((s) => s.id)))

    // Tarihler AÇIKÇA ISO dizgiye çevriliyor: `res.json` bunu zaten yapardı ama örtük olarak,
    // ve o zaman sözleşme "string" derken üretici "Date" tutuyordu (bkz. getVenues).
    const safe = {
      ...temiz,
      createdAt: temiz.createdAt.toISOString(),
      // stripVenueSensitive YALNIZ üst-düzey venue kolonlarını siler; iç içe eğitmen objeleri
      // TAM SATIR taşır → passwordHash/email/phone SIZAR. Her nested eğitmen ayrıca temizlenir.
      instructors: temiz.instructors.map(stripInstructorSensitive),
      // ONLINE BAĞLANTI PUBLIC'E ÇIKAMAZ. Bu uç ders ve seans satırlarını OLDUĞU GİBİ yayıyor
      // (`...c` / `...s`); `meetingUrl` eklendiği an salonun online dersinin linki herkese açık
      // hâle gelirdi ve rezervasyonsuz derse girilirdi — bağlantı burada fiilen BİLETTİR.
      // Aynı sınıf hata daha önce alt-üye işyeri (IBAN/TCKN) alanlarında yaşandı: select'siz
      // include + ham yayılım. Bağlantı yalnız rezervasyon sahibine (getMyBookings) döner.
      classes: temiz.classes.map(({ meetingUrl: _cMeet, ...c }) => ({
        ...c,
        instructor: stripInstructorSensitive(c.instructor),
        sessions: c.sessions.map(({ meetingUrl: _sMeet, ...s }) => {
          const left = spotsLeftOf(s.capacity, vOcc.get(s.id) || 0)
          return {
            ...s,
            startsAt: s.startsAt.toISOString(),
            endsAt: s.endsAt.toISOString(),
            spotsLeft: left,
            availableSpots: left, // DEPRECATED — bkz. sözleşme
          }
        }),
      })),
    }
    return res.json({ venue: safe })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// GET /api/public/dropin
export const getDropInSlots = async (req: Request, res: Response) => {
  try {
    const slots = await prisma.dropInSlot.findMany({
      // SALON MODERASYON FİLTRESİ: kardeş public uçların (getSessions/getVenues/getVenueById) hepsinde
      // olan `isApproved && isActive` şartı BURADA EKSİKTİ → askıya alınan/onayı kaldırılan salonun
      // drop-in ilanı (salon adı + adresi + saat + fiyat) public listede kalmaya devam ediyordu; üstelik
      // karta tıklayınca detay ucu 404 verdiği için kullanıcı bozuk bir kayda tıklamış oluyordu.
      where: { status: 'open', visibility: 'open', startsAt: { gte: new Date() }, venue: { isApproved: true, isActive: true } },
      include: {
        venue: { select: { id: true, name: true, address: true } },
        sportCategory: { select: { name: true, colorHex: true, iconUrl: true } },
        participants: { select: { id: true } },
      },
      orderBy: { startsAt: 'asc' },
      take: 201, // LIMIT+1 → sessiz kesme yerine hasMore sinyali
    })
    const sHasMore = slots.length > 200
    return res.json({ slots: slots.slice(0, 200), hasMore: sHasMore, limit: 200 })
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
        // privateCode gate kontrolü için ÇEKİLİR ama yanıttan STRIP edilir (aşağıda) — public'e sızmaz
        id: true, venueId: true, sportCategoryId: true, title: true, startsAt: true, endsAt: true,
        format: true, totalPlayers: true, currentPlayers: true, totalPrice: true, pricePerPerson: true,
        status: true, visibility: true, privateCode: true, createdAt: true,
        venue: { select: { id: true, name: true, address: true, isApproved: true, isActive: true } },
        sportCategory: { select: { name: true, colorHex: true, iconUrl: true } },
        participants: {
          // Roster public (kimlik-doğrulamasız uç). Gizli (activityPrivacy=private) ve banlı kullanıcılar
          // roster'da GÖSTERİLMEZ — aksi halde kişinin gerçek adı + nerede/ne zaman olacağı sızardı
          // (liderlik/feed ile aynı filtre). currentPlayers sayacı stored olduğundan sayı etkilenmez.
          where: { status: 'confirmed', user: { activityPrivacy: { not: 'private' }, banned: false } },
          select: {
            id: true,
            team: true,
            user: { select: { id: true, username: true, fullName: true, avatarUrl: true } }
          }
        },
      }
    })
    if (!slot || !slot.venue?.isApproved || slot.venue?.isActive === false) return res.status(404).json({ error: 'Slot bulunamadı.' })
    // GİZLİ slot (visibility='private') yalnızca doğru privateCode ile görüntülenir (?code=...) — aksi halde
    // id enumerasyonuyla kimin nerede/ne zaman oynadığı + roster (gerçek ad) sızardı. Kodsuz/yanlış kod → 404.
    if (slot.visibility === 'private') {
      const code = String((req.query.code as string) || '').trim().toUpperCase()
      if (!code || code !== String(slot.privateCode || '').toUpperCase()) {
        return res.status(404).json({ error: 'Slot bulunamadı.' })
      }
    }
    const { privateCode, venue, ...restSlot } = slot as any
    return res.json({ slot: { ...restSlot, venue: { id: venue.id, name: venue.name, address: venue.address } } })
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

    // GİZLİ PROFİL (profilePrivacy=private): içeriği yalnızca SAHİBİ veya ONAYLI TAKİPÇİ görür.
    // Yabancıya SADECE KİMLİK (isim/avatar) + "gizli" işareti döner — tier/rozet/ilçe/liste/aktivite HİÇBİRİ
    // (Instagram mantığı: tıkla, takip isteği gönder). Kimlik olmadan takip isteği atılamazdı.
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
        user: { id: user.id, username: user.username, fullName: user.fullName, avatarUrl: user.avatarUrl, profilePrivacy: 'private' },
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

    // AKTİVİTE GİZLİ (activityPrivacy=private): yalnız gidilen dersler/takvim (activities) GİZLENİR — SAHİBİ hariç.
    // Rozet + tier + istatistik (toplam ders/streak) + takipçi/takip listeleri HERKESE açık kalır (kullanıcı kararı:
    // "rozet ve tier'ı herkes görür"). Sahip kendi aktivitesini görür (isOwner). Tam `user` objesi (rozetler dahil) döner.
    if (user.activityPrivacy === 'private' && !isOwner) {
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
    const q = (req.query.q as string || '').trim().replace(/^@/, '').slice(0, 80) // uzunluk sınırı (ILIKE girdi hijyeni)
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
    // Askıdaki/onaysız salonun eğitmeni + canlı ders programı public görünmesin — diğer public
    // uçlarla (getVenueById/getSessionById/getSessions) aynı kapı. Pasif eğitmen de 404.
    const instructor = await prisma.instructor.findFirst({
      // Kapı iki kaynaklı: salona bağlı eğitmende SALONUN durumu, mekânsız eğitmende KENDİ
      // onayı. Eski hâli `venue: {...}` istiyordu → mekânsız hoca profili herkese 404 olurdu.
      where: { id: instructorId, ...instructorLiveWhere() },
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
              select: { id: true, startsAt: true, capacity: true }
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

    // optionalAuth: private hoca yanıtı yalnız yorumu yazana görünür
    const viewerId = (req as any).userId as number | undefined
    const safeReviews = instructor.reviews.map(r => hidePrivateReply(r, sanitizeReview(r), viewerId))

    // "Sıradaki seans"ın KALAN YERİ — burada da kapasite kalan yer sanılıyordu.
    const nextSessions = instructor.classes.flatMap(c => c.sessions)
    const occMap = await getOccupancyMap(nextSessions.map(s => s.id))
    // ONLINE BAĞLANTI PUBLIC'E ÇIKAMAZ — getVenueById ile aynı gerekçe. Mekânsız hocanın TÜM
    // dersleri online olduğu için burada risk daha da yüksek: tek bir profil sayfası o hocanın
    // bütün derslerinin bağlantısını dağıtırdı.
    const classesWithSpots = instructor.classes.map(({ meetingUrl: _cMeet, ...c }) => ({
      ...c,
      // (seanslar burada AÇIK select ile geliyor — id/startsAt/capacity; meetingUrl zaten yok)
      sessions: c.sessions.map(s => {
        const left = spotsLeftOf(s.capacity, occMap.get(s.id) || 0)
        return { ...s, spotsLeft: left, availableSpots: left } // availableSpots DEPRECATED
      }),
    }))

    return res.json({
      instructor: {
        // stripInstructorSensitive: passwordHash/email/phone/userId/inviteStatus public'e SIZMASIN
        // (bu uç optionalAuth = kimlik-doğrulamasız; id enumerasyonuyla tüm eğitmen hash'leri toplanabilirdi).
        ...stripInstructorSensitive(instructor),
        classes: classesWithSpots,
        reviews: safeReviews,
        // avgRating/totalReviews: SAKLI değerler (createReview'da tüm yorumlardan tutulur).
        // Buradaki reviews `take:20` ile sınırlı olduğundan slice'tan hesaplamak SAPARDI.
        avgRating: instructor.avgRating,
        totalReviews: instructor.totalReviews,
      }
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// GET /api/public/instructors — EĞİTMEN LİSTESİ (keşif yüzeyi).
//
// Bugüne kadar public'te YALNIZ `/instructors/:id` vardı: eğitmen sayfaları ancak bir dersin
// içinden tıklanarak bulunabiliyordu, listelenemiyordu. Online ders kanadıyla birlikte
// mekânsız hocalar da geldiği için eğitmen artık başlı başına bir keşif nesnesi.
//
// KAPI: `instructorLiveWhere()` — salona bağlı eğitmende SALONUN durumu, mekânsız eğitmende
// KENDİ onayı. Kapıyı burada elle yazmak, kardeş uçlarla ayrışmanın en kısa yoludur.
export const getInstructors = async (req: Request, res: Response) => {
  try {
    const { search, category, mode, page, limit } = req.query
    const pageNum = Math.max(1, parseIntSafe(page) || 1)
    const pageSize = Math.min(50, Math.max(1, parseIntSafe(limit) || 24))
    const searchStr = typeof search === 'string' ? search.trim().slice(0, 80) : undefined
    const categoryStr = typeof category === 'string' ? category : undefined
    const deliveryMode = parseDeliveryMode(mode)

    const and: any[] = [instructorLiveWhere()]

    if (searchStr) {
      and.push({
        OR: [
          { fullName: { contains: searchStr, mode: 'insensitive' } },
          { specialty: { contains: searchStr, mode: 'insensitive' } },
          { venue: { is: { name: { contains: searchStr, mode: 'insensitive' } } } },
        ],
      })
    }

    // Branş/teslim filtresi EĞİTMENİN DERSLERİNDEN türetiliyor: `specialty` serbest metin ve
    // güvenilmez (hoca "yoga · pilates" yazıyor), gerçek sinyal açtığı derslerdir.
    if (categoryStr || deliveryMode) {
      and.push({
        classes: {
          some: {
            isActive: true,
            ...(categoryStr ? { sportCategory: { name: { equals: categoryStr, mode: 'insensitive' } } } : {}),
            ...(deliveryMode ? { deliveryMode } : {}),
          },
        },
      })
    }

    const where = { AND: and }

    // hasMore: LIMIT+1 hilesi — ek COUNT sorgusu yok (kardeş uçlarla aynı desen).
    const rows = await prisma.instructor.findMany({
      where,
      select: {
        id: true, fullName: true, specialty: true, specialtyEn: true, bio: true, bioEn: true,
        avatarUrl: true, verified: true, avgRating: true, totalReviews: true, venueId: true,
        venue: { select: { id: true, name: true, neighborhood: { select: { name: true } } } },
        _count: { select: { classes: true } },
      },
      orderBy: [{ verified: 'desc' }, { avgRating: 'desc' }, { totalReviews: 'desc' }, { id: 'asc' }],
      skip: (pageNum - 1) * pageSize,
      take: pageSize + 1,
    })

    const hasMore = rows.length > pageSize
    const sayfa = hasMore ? rows.slice(0, pageSize) : rows

    return res.json({
      // stripInstructorSensitive: e-posta/telefon/passwordHash/inviteStatus public'e SIZMASIN.
      // Bu uç kimlik doğrulaması İSTEMİYOR; id enumerasyonu yerine doğrudan liste veriyor,
      // yani hassas alan sızıntısının maliyeti burada daha da yüksek.
      instructors: sayfa.map((i) => ({
        ...stripInstructorSensitive(i),
        classCount: i._count.classes,
        // Mekânsız hoca: salon yok, dolayısıyla konum da yok. İstemci salon satırını çizmemeli.
        venueName: i.venue?.name ?? null,
        neighborhood: i.venue?.neighborhood?.name ?? null,
        _count: undefined,
        venue: undefined,
      })),
      page: pageNum,
      pageSize,
      hasMore,
      limit: pageSize,
    })
  } catch (err) {
    console.error('getInstructors error:', err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}
