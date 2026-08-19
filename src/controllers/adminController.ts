import { Request, Response } from 'express'
import prisma from '../utils/prisma'
import { clampStr } from '../utils/validate'
import { sendVenueApprovedEmail } from '../utils/email'
import { invalidate } from '../utils/cache'
import { purgeUserReviews, purgeUserComments, applyUserBan } from '../utils/moderation'
import { sendPushNotification } from '../utils/push'
import { reversiblePoints } from '../utils/tier'
import { notifyFields, notifyPush } from '../utils/notifyText'
import { Locale } from '../utils/locale'

// İstatistikler
export const getStats = async (req: Request, res: Response) => {
  try {
    const [userCount, venueCount, instructorCount, bookingCount, pendingVenues] = await Promise.all([
      prisma.user.count(),
      prisma.venue.count(),
      prisma.instructor.count(),
      prisma.booking.count(),
      prisma.venue.count({ where: { isApproved: false } }),
    ])

    return res.json({ stats: { userCount, venueCount, instructorCount, bookingCount, pendingVenues } })
  } catch (err) {
    if (handlePrismaErr(err, res)) return
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
    if (handlePrismaErr(err, res)) return
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// Prisma "kayıt bulunamadı" (P2025) → 404, FK ihlali (P2003) → 400 eşle; değilse false (çağıran 500 döner).
// Geçersiz/silinmiş ID veya kullanımdaki kayıt admin mutasyonlarında artık 500 yerine doğru durum kodu döner.
function handlePrismaErr(err: any, res: Response): boolean {
  if (err?.code === 'P2025') { res.status(404).json({ error: 'Kayıt bulunamadı.' }); return true }
  if (err?.code === 'P2003') { res.status(400).json({ error: 'Kayıt başka verilerle ilişkili — işlem yapılamadı.' }); return true }
  return false
}

// Salon onayla / reddet
export const approveVenue = async (req: Request, res: Response) => {
  try {
    const venueId = parseInt(req.params.id as string)
    if (!venueId || isNaN(venueId)) return res.status(400).json({ error: 'Geçersiz salon.' })
    const { approve } = req.body
    if (typeof approve !== 'boolean') return res.status(400).json({ error: 'approve alanı boolean olmalı.' })

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

    // FİNANS-KYC ALANLARI YANITTAN ÇIKARILIR. Arayüz bunları kullanmıyor ama yanıt gövdesi
    // IBAN, TCKN, vergi no, KYC belge adresleri ve iyzico anahtarını taşıyordu: admin'in
    // tarayıcı belleğine, DevTools ağ geçmişine ve aradaki her günlüğe düşüyordu. En hassas
    // veri, ihtiyaç duyulmayan bir yerde durmamalı.
    const { passwordHash, iban, identityNumber, taxNumber, kycDocs, iyzicoSubMerchantKey, ...safeVenue } =
      venue as typeof venue & { iban?: unknown; identityNumber?: unknown; taxNumber?: unknown; kycDocs?: unknown; iyzicoSubMerchantKey?: unknown }
    return res.json({ message: approve ? 'Salon onaylandı.' : 'Salon reddedildi.', venue: safeVenue })
  } catch (err) {
    if (handlePrismaErr(err, res)) return
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// Tüm kullanıcılar
export const getAllUsers = async (req: Request, res: Response) => {
  try {
    const users = await prisma.user.findMany({
      select: {
        id: true, username: true, email: true, fullName: true, banned: true,
        totalLessonsCompleted: true, rewardPoints: true, createdAt: true,
        _count: { select: { bookings: true } }
      },
      orderBy: { createdAt: 'desc' }
    })
    return res.json({ users })
  } catch (err) {
    if (handlePrismaErr(err, res)) return
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
    if (handlePrismaErr(err, res)) return
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// Salon dondur/aktif et
export const suspendVenue = async (req: Request, res: Response) => {
  try {
    const venueId = parseInt(req.params.id as string)
    if (!venueId || isNaN(venueId)) return res.status(400).json({ error: 'Geçersiz salon.' })
    const { suspend } = req.body
    // suspend boolean değilse (ör. boş gövde → undefined), Prisma isSuspended'ı atlar ama isActive:!undefined=true
    // olurdu → askıdaki salon isSuspended=true kalıp isActive=true olur, public listelerde geri belirir (moderasyon-bypass).
    if (typeof suspend !== 'boolean') return res.status(400).json({ error: 'suspend alanı boolean olmalı.' })

    const venue = await prisma.venue.update({
      where: { id: venueId },
      data: { isSuspended: suspend, isActive: !suspend },
    })
    invalidate(`venueState:${venueId}`) // venueAuthMiddleware 60sn cache'ini hemen düşür → askıya alma anında etki eder

    // ── ETKİLENEN KULLANICILARA HABER VER ────────────────────────────────────────────────────
    // Askıya alma rezervasyonları İPTAL ETMİYOR ama check-in'i kapatıyor (venueApprovedMiddleware
    // → 403). Eskiden hiçbir bildirim gitmiyordu: kullanıcının rezervasyonu "onaylı" görünmeye
    // devam ediyor, kişi derse gidiyor ve kapıda öğreniyordu. deleteVenue bu sorumluluğu zaten
    // alıyor (booking_cancelled_venue_closed) — kardeş yol atlanmıştı.
    // Metin iptal DEMİYOR; "duruyor ama giriş kapalı, istersen tam iade ile iptal et" diyor.
    try {
      const etkilenen = await prisma.booking.findMany({
        where: {
          status: { in: ['confirmed', 'pending'] },
          session: { startsAt: { gt: new Date() }, class: { venueId } },
        },
        select: { userId: true },
        distinct: ['userId'],
      })
      const ids = etkilenen.map(b => b.userId)
      if (ids.length) {
        const anahtar = suspend ? 'venue_suspended' : 'venue_reopened'
        const params = { venue: venue.name }
        const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, pushToken: true, locale: true } })
        for (const u of users) {
          const loc = (u.locale || 'tr') as Locale
          await prisma.notification.create({ data: { userId: u.id, type: 'venue_status', ...notifyFields(loc, anahtar, params) } }).catch(() => {})
          const push = notifyPush(loc, anahtar, params)
          if (u.pushToken && push) sendPushNotification(u.pushToken, push.title, push.body).catch(() => {})
        }
      }
    } catch (e) {
      // Bildirim best-effort: askıya alma işleminin KENDİSİ başarılı oldu, onu 500'e çevirme.
      console.error('suspendVenue bildirim hatası:', e)
    }
    // bkz. onay ucu — finans/KYC alanları yanıtta dönmez
    const { passwordHash, iban, identityNumber, taxNumber, kycDocs, iyzicoSubMerchantKey, ...safeVenue } =
      venue as typeof venue & { iban?: unknown; identityNumber?: unknown; taxNumber?: unknown; kycDocs?: unknown; iyzicoSubMerchantKey?: unknown }
    return res.json({ message: suspend ? 'Salon donduruldu.' : 'Salon aktif edildi.', venue: safeVenue })
  } catch (err) {
    if (handlePrismaErr(err, res)) return
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// Salon sil — salona bağlı TÜM kayıtları (ders/seans/rezervasyon/bekleme listesi/drop-in/
// kupon/yorum/rozet/payout/komisyon/favori vb.) FK sırasına göre güvenle temizler.
// Düz `venue.delete` ders/rezervasyonu olan salonda FK ihlaliyle 500 verirdi.
export const deleteVenue = async (req: Request, res: Response) => {
  try {
    const venueId = parseInt(req.params.id as string)
    if (!venueId || isNaN(venueId)) return res.status(400).json({ error: 'Geçersiz salon.' })
    const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { id: true, name: true } })
    if (!venue) return res.status(404).json({ error: 'Salon bulunamadı.' })

    const affectedUserIds = await prisma.$transaction(async (tx) => {
      const affected = new Set<number>()
      // Salonun dersleri → seansları
      const classes = await tx.class.findMany({ where: { venueId }, select: { id: true } })
      const classIds = classes.map((c) => c.id)
      const sessions = classIds.length
        ? await tx.class_Session.findMany({ where: { classId: { in: classIds } }, select: { id: true } })
        : []
      const sessionIds = sessions.map((s) => s.id)
      // Drop-in slotları
      const slots = await tx.dropInSlot.findMany({ where: { venueId }, select: { id: true } })
      const slotIds = slots.map((s) => s.id)

      // Bu salona ait TÜM rezervasyonlar (seans + drop-in) — puan iadesiyle birlikte temizle
      const orBooking: any[] = []
      if (sessionIds.length) orBooking.push({ sessionId: { in: sessionIds } })
      if (slotIds.length) orBooking.push({ dropInSlotId: { in: slotIds } })
      if (orBooking.length) {
        const bookings = await tx.booking.findMany({
          where: { OR: orBooking },
          select: { id: true, userId: true, pointsEarned: true, status: true, createdAt: true, checkedIn: true },
        })
        const bookingIds = bookings.map((b) => b.id)
        for (const b of bookings) {
          if (b.status === 'confirmed' || b.status === 'pending') {
            affected.add(b.userId) // aktif rezervasyonu olan kullanıcı → bilgilendirilecek
            if (b.checkedIn && b.pointsEarned > 0) { // puan yalniz check-in'de kredilenir
              // CLAMP: bakiyeyi NEGATİFE düşürme (cancelBooking ile aynı invariant — FOR UPDATE + Math.min)
              await tx.$executeRaw`SELECT id FROM "User" WHERE id = ${b.userId} FOR UPDATE`
              const cur = await tx.user.findUnique({ where: { id: b.userId }, select: { rewardPoints: true, rewardPointsYear: true } })
              // Cross-year: önceki puan-yılı booking'i reset'te zaten silindi → tekrar düşme.
              const dec = reversiblePoints(b.pointsEarned, b.createdAt, cur?.rewardPointsYear ?? null, cur?.rewardPoints || 0)
              if (dec > 0) {
                await tx.user.update({ where: { id: b.userId }, data: { rewardPoints: { decrement: dec } } })
                await tx.rewardPoint.create({ data: { userId: b.userId, points: -dec, source: 'venue_removed', bookingId: b.id } })
              }
            }
          }
        }
        if (bookingIds.length) {
          // Booking'e gerçek FK ile bağlı çocuklar önce silinir
          await tx.payment.deleteMany({ where: { bookingId: { in: bookingIds } } })
          await tx.review.deleteMany({ where: { bookingId: { in: bookingIds } } })
          await tx.commissionHistory.deleteMany({ where: { bookingId: { in: bookingIds } } })
          await tx.activityLog.deleteMany({ where: { bookingId: { in: bookingIds } } })
          await tx.booking.deleteMany({ where: { id: { in: bookingIds } } })
        }
      }

      // Bekleme listesi seansa gerçek FK ile bağlı → seanslar silinmeden önce
      if (sessionIds.length) await tx.waitlist.deleteMany({ where: { sessionId: { in: sessionIds } } })
      // Seans + ders
      if (classIds.length) {
        await tx.class_Session.deleteMany({ where: { classId: { in: classIds } } })
        await tx.class.deleteMany({ where: { id: { in: classIds } } })
      }
      // Drop-in: katılımcılar (slot'a gerçek FK) → slotlar
      if (slotIds.length) {
        await tx.dropInParticipant.deleteMany({ where: { slotId: { in: slotIds } } })
        await tx.dropInSlot.deleteMany({ where: { id: { in: slotIds } } })
      }
      // Eğitmenler (artık ders/seans referansı kalmadı). Hocaya bağlı yorumlar (instructorId'li,
      // booking'den ayrıştırılmış olabilir) Review→Instructor FK'sını ihlal etmesin diye ÖNCE silinir.
      const venueInstructors = await tx.instructor.findMany({ where: { venueId }, select: { id: true } })
      if (venueInstructors.length) {
        const instIds = venueInstructors.map((i: any) => i.id)
        await tx.review.deleteMany({ where: { instructorId: { in: instIds } } })
        await tx.instructorPasswordResetToken.deleteMany({ where: { instructorId: { in: instIds } } })
      }
      await tx.instructor.deleteMany({ where: { venueId } })
      // Salon düzeyindeki kalan kayıtlar (bağımsız tablolar)
      await tx.coupon.deleteMany({ where: { venueId } })
      await tx.review.deleteMany({ where: { venueId } })
      await tx.userBadge.deleteMany({ where: { venueId } })
      await tx.venuePayout.deleteMany({ where: { venueId } })
      await tx.commissionHistory.deleteMany({ where: { venueId } })
      await tx.activityLog.deleteMany({ where: { venueId } })
      await tx.favoriteVenue.deleteMany({ where: { venueId } })
      await tx.venueSportCategory.deleteMany({ where: { venueId } })
      await tx.venuePasswordResetToken.deleteMany({ where: { venueId } })
      // Salon
      // Panel oturumlarını salondan ÖNCE sil. FK'ler ON DELETE SET NULL olduğu için salon silinince
      // bu satırların venueId'si NULL'a düşüyor, yetim kalıyor ve `venueId` filtresiyle silen hiçbir
      // temizlik onlara BİR DAHA ulaşamıyor (silme sonrasına konan bir temizlik de hiçbir şey bulmaz).
      await tx.panelRefreshToken.deleteMany({ where: { venueId } })
      await tx.venue.delete({ where: { id: venueId } })
      return [...affected]
    }, { timeout: 30000 })

    // Aktif rezervasyonu olan kullanıcılara "salon kaldırıldı, rezervasyonun iptal edildi"
    // bildirimi (in-app + push, best-effort). deleteClass/deleteSession ile tutarlı.
    if (affectedUserIds.length) {
      const params = { venue: venue.name }
      const users = await prisma.user.findMany({ where: { id: { in: affectedUserIds } }, select: { id: true, pushToken: true, locale: true } }).catch(() => [])
      for (const u of users) {
        const loc = (u.locale || 'tr') as Locale
        await prisma.notification.create({ data: { userId: u.id, type: 'booking_cancelled', ...notifyFields(loc, 'booking_cancelled_venue_closed', params) } }).catch(() => {})
        const push = notifyPush(loc, 'booking_cancelled_venue_closed', params)
        if (u.pushToken && push) sendPushNotification(u.pushToken, push.title, push.body).catch(() => {})
      }
    }

    // CACHE DÜŞÜR — suspendVenue bunu yapıyor (:149), deleteVenue YAPMIYORDU. venueAuthMiddleware
    // salon durumunu 60 sn cache'liyor; silinen salonun elindeki panel token'ı o pencere boyunca
    // çalışmaya devam ediyordu. CANLI DOĞRULANDI: salon silindikten sonra eski token ile
    // GET /api/venue/revenue → 200. Askıya almadan daha yıkıcı bir işlemin daha zayıf olması saçma.
    invalidate(`venueState:${venueId}`)
    return res.json({ message: 'Salon ve tüm bağlı kayıtları silindi.' })
  } catch (err) {
    if (handlePrismaErr(err, res)) return
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// Kullanıcı banla/aktif et
export const banUser = async (req: Request, res: Response) => {
  try {
    const userId = parseInt(req.params.id as string)
    const { ban } = req.body
    // TİP DOĞRULAMASI: approveVenue/suspendVenue bu hata sınıfını açıkça kapatmış, banUser'da açıktı.
    // `!!ban` ile eksik/bozuk gövde SESSİZCE ban KALDIRIYORDU (ban=undefined → false → unban). Admin
    // "banla" demek isterken yanlış payload'la yanlışlıkla ban'ı kaldırabilirdi. Boolean şart.
    if (typeof ban !== 'boolean') {
      return res.status(400).json({ error: 'ban alanı true/false olmalı.' })
    }

    // Ban/unban tek yerde (applyUserBan): banned + cache invalidate + refresh iptal + içerik purge
    const user = await applyUserBan(userId, ban)
    const { passwordHash, ...safeUser } = user
    return res.json({ message: ban ? 'Kullanıcı banlandı.' : 'Kullanıcı aktif edildi.', user: safeUser })
  } catch (err) {
    if (handlePrismaErr(err, res)) return
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// Onay bekleyen salon resimleri (admin)
export const getPendingVenueImages = async (req: Request, res: Response) => {
  try {
    const venues = await prisma.venue.findMany({
      where: { imagesPendingReview: true },
      select: {
        id: true, name: true,
        images: true, coverImageUrl: true,
        pendingImages: true, pendingCoverImageUrl: true,
      },
      orderBy: { id: 'asc' },
    })
    return res.json({ venues })
  } catch (err) {
    if (handlePrismaErr(err, res)) return
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// Salon resimlerini onayla/reddet (admin)
export const reviewVenueImages = async (req: Request, res: Response) => {
  try {
    const venueId = parseInt(req.params.id as string)
    const { approve } = req.body
    if (!venueId || isNaN(venueId)) return res.status(400).json({ error: 'Geçersiz salon.' })
    if (typeof approve !== 'boolean') return res.status(400).json({ error: 'approve alanı boolean olmalı.' })

    const venue = await prisma.venue.findUnique({
      where: { id: venueId },
      select: { pendingImages: true, pendingCoverImageUrl: true, imagesPendingReview: true },
    })
    if (!venue) return res.status(404).json({ error: 'Salon bulunamadı.' })
    // ÇİFT ONAY KORUMASI: ilk onay bekleyen seti canlıya alıp pending'i BOŞALTIYOR. İkinci çağrı
    // (çift tıklama / iki admin / yeniden deneme) o BOŞ pending'i canlı alanların üzerine yazıp
    // salonun yayındaki TÜM galerisini ve kapak fotoğrafını kalıcı olarak siliyordu — ve iki yanıt da
    // 200 döndüğü için admin başarı görüyordu. Onaylanacak bekleyen set yoksa artık işlem yapılmaz.
    if (!venue.imagesPendingReview) {
      return res.status(409).json({ error: 'Bu salonun onay bekleyen resmi yok (işlem zaten yapılmış).' })
    }

    if (approve) {
      // Bekleyen seti canlıya al
      await prisma.venue.update({
        where: { id: venueId },
        data: {
          images: venue.pendingImages as any,
          coverImageUrl: venue.pendingCoverImageUrl,
          pendingImages: [],
          pendingCoverImageUrl: null,
          imagesPendingReview: false,
        },
      })
      return res.json({ message: 'Salon resimleri onaylandı ve yayınlandı.' })
    } else {
      // Reddet: bekleyeni temizle, canlı resimler korunur
      await prisma.venue.update({
        where: { id: venueId },
        data: { pendingImages: [], pendingCoverImageUrl: null, imagesPendingReview: false },
      })
      return res.json({ message: 'Salon resimleri reddedildi.' })
    }
  } catch (err) {
    if (handlePrismaErr(err, res)) return
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
    if (handlePrismaErr(err, res)) return
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// Kupon sil (admin) — bu kuponu kullanan booking'lerin couponId'sini önce boşalt
// (yoksa FK ihlali → 500). Booking'in finansal kaydı (discountAmount/finalAmount) korunur.
export const adminDeleteCoupon = async (req: Request, res: Response) => {
  try {
    const couponId = parseInt(req.params.id as string)
    if (!couponId || isNaN(couponId)) return res.status(400).json({ error: 'Geçersiz kupon.' })
    await prisma.$transaction(async (tx) => {
      await tx.booking.updateMany({ where: { couponId }, data: { couponId: null } })
      await tx.coupon.delete({ where: { id: couponId } })
    })
    return res.json({ message: 'Kupon silindi.' })
  } catch (err) {
    if (handlePrismaErr(err, res)) return
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
    const trimmed = typeof name === 'string' ? name.trim() : ''
    if (!trimmed) return res.status(400).json({ error: 'Kategori adı zorunludur.' })
    const existing = await prisma.sportCategory.findFirst({ where: { name: { equals: trimmed, mode: 'insensitive' } } })
    if (existing) return res.status(400).json({ error: 'Bu kategori zaten mevcut.' })
    const category = await prisma.sportCategory.create({ data: { name: trimmed, colorHex, iconUrl } })
    invalidate('categories')
    return res.json({ category })
  } catch (err) {
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// Kategori sil (admin) — kullanımdaysa ENGELLE (gerçek veriyi cascade-silmek yerine).
// sportCategoryId çoğu modelde zorunlu FK; düz delete kullanımdaki kategoride 500 verirdi.
export const deleteCategory = async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id as string)
    if (!id || isNaN(id)) return res.status(400).json({ error: 'Geçersiz kategori.' })
    // ŞEMADAKİ TÜM sportCategoryId REFERANSLARI sayılmalı — eksik bırakılan her tablo, "kontrol ettim,
    // silmek güvenli" diyen bu guard'ı YALANCI yapar ve silme FK ihlaliyle 500'e düşer.
    // ÖNCEDEN: ActivityLog + UserTierHistory sayılıyordu (ikisi de HİÇBİR YERDE oluşturulmuyor → her
    // zaman 0, guard'a katkısı yok) ama GERÇEKTEN yazılan UserBadge.sportCategoryId sayılmıyordu
    // (badges.ts 'spor ustası' + championJob 'sezon şampiyonu' rozetleri kategoriye bağlı yazıyor).
    // Yani rozet dağıtılmış bir kategoriyi silmek guard'dan GEÇİP FK hatasına düşüyordu.
    // Ölü tablolar da listede TUTULDU: bugün 0 dönüyorlar ama ileride yazılmaya başlarsa guard
    // kendiliğinden doğru kalsın (maliyet: iki ucuz count).
    const [classes, venues, dropins, badges, logs, tierHist, monthly] = await Promise.all([
      prisma.class.count({ where: { sportCategoryId: id } }),
      prisma.venueSportCategory.count({ where: { sportCategoryId: id } }),
      prisma.dropInSlot.count({ where: { sportCategoryId: id } }),
      prisma.userBadge.count({ where: { sportCategoryId: id } }),
      prisma.activityLog.count({ where: { sportCategoryId: id } }),
      prisma.userTierHistory.count({ where: { sportCategoryId: id } }),
      prisma.monthlyLeaderboard.count({ where: { sportCategoryId: id } }),
    ])
    const total = classes + venues + dropins + badges + logs + tierHist + monthly
    if (total > 0) {
      return res.status(400).json({
        error: `Bu kategori kullanımda (${classes} ders, ${venues} salon, ${dropins} drop-in, ${badges} rozet) — silinemez. Önce bağlantıları kaldırın.`,
      })
    }
    await prisma.sportCategory.delete({ where: { id } })
    invalidate('categories')
    return res.json({ message: 'Kategori silindi.' })
  } catch (err) {
    if (handlePrismaErr(err, res)) return
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// Kategori güncelle (admin)
export const updateCategory = async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id as string)
    if (!id || isNaN(id)) return res.status(400).json({ error: 'Geçersiz kategori.' })
    const { name, colorHex } = req.body
    const trimmed = typeof name === 'string' ? name.trim() : ''
    if (!trimmed) return res.status(400).json({ error: 'Kategori adı zorunludur.' })
    // Başka bir kategori aynı ada sahip olmasın (büyük/küçük harf duyarsız)
    const dup = await prisma.sportCategory.findFirst({
      where: { name: { equals: trimmed, mode: 'insensitive' }, id: { not: id } },
    })
    if (dup) return res.status(400).json({ error: 'Bu isimde başka bir kategori zaten var.' })
    const category = await prisma.$transaction(async (tx) => {
      const existing = await tx.sportCategory.findUnique({ where: { id }, select: { name: true } })
      if (!existing) throw new Error('NOT_FOUND')
      const updated = await tx.sportCategory.update({
        where: { id },
        data: { name: trimmed, colorHex: colorHex || null },
      })
      // Denormalize edilmiş Class.category string kopyalarını da senkronla — yoksa filtreler eski adda kalır
      if (existing.name !== trimmed) {
        await tx.class.updateMany({ where: { category: existing.name }, data: { category: trimmed } })
      }
      return updated
    })
    invalidate('categories')
    return res.json({ category })
  } catch (err) {
    if (err instanceof Error && err.message === 'NOT_FOUND') return res.status(404).json({ error: 'Kategori bulunamadı.' })
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// Tüm hocalar (admin) — doğrulama yönetimi için. Doğrulanmamışlar üstte.
export const getAllInstructors = async (req: Request, res: Response) => {
  try {
    const instructors = await prisma.instructor.findMany({
      select: {
        id: true, fullName: true, specialty: true, avatarUrl: true,
        verified: true, avgRating: true, totalReviews: true, createdAt: true,
        venue: { select: { id: true, name: true } },
        _count: { select: { classes: true } },
      },
      orderBy: [{ verified: 'asc' }, { createdAt: 'desc' }],
    })
    return res.json({ instructors })
  } catch (err) {
    if (handlePrismaErr(err, res)) return
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// İletişim/şikayet mesajları (admin) — açık olanlar üstte
export const getComplaints = async (req: Request, res: Response) => {
  try {
    const complaints = await prisma.complaint.findMany({
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      take: 200,
    })
    return res.json({ complaints })
  } catch (err) {
    if (handlePrismaErr(err, res)) return
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// Şikayeti çözüldü olarak işaretle (admin)
export const resolveComplaint = async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id as string)
    if (!id || isNaN(id)) return res.status(400).json({ error: 'Geçersiz mesaj.' })
    await prisma.complaint.update({ where: { id }, data: { status: 'resolved', resolvedAt: new Date() } })
    return res.json({ message: 'Mesaj çözüldü olarak işaretlendi.' })
  } catch (err) {
    if (handlePrismaErr(err, res)) return
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// Hocayı doğrula / doğrulamayı kaldır (admin) — "doğrulanmış hoca" mavi tiki
export const verifyInstructor = async (req: Request, res: Response) => {
  try {
    // BOOLEAN KAPISI — kardeş uçlarda (approveVenue, suspendVenue, banUser) VAR, burada YOKTU.
    // `!!verified` her girdiyi sessizce yorumluyordu: boş gövde → sessiz UNVERIFY + 200,
    // {"verified":"false"} (string) → truthy → VERIFY + 200. Doğrulama rozeti kullanıcıya
    // gösterilen bir güven işareti; kazayla verilmesi/alınması sessiz olmamalı.
    const { verified } = req.body
    if (typeof verified !== 'boolean') return res.status(400).json({ error: 'verified alanı boolean olmalı.' })
    const instructorId = parseInt(req.params.id as string)
    if (!instructorId || isNaN(instructorId)) return res.status(400).json({ error: 'Geçersiz hoca.' })
    const instructor = await prisma.instructor.update({
      where: { id: instructorId },
      data: { verified },
      select: { id: true, fullName: true, verified: true },
    })
    return res.json({ message: verified ? 'Hoca doğrulandı.' : 'Doğrulama kaldırıldı.', instructor })
  } catch (err) {
    if (handlePrismaErr(err, res)) return
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// PUT /api/admin/instructors/:id/approve — MEKÂNSIZ (bireysel) eğitmenin yayın onayı.
//
// `verified` (mavi tik) ile KARIŞTIRMA: o bir KALİTE işareti ve görünürlüğü etkilemez;
// `isApproved` salonun `isApproved`'ının birebir karşılığıdır ve mekânsız hocanın derslerinin
// yayına çıkıp çıkmayacağını belirler. Salona bağlı eğitmende bu alan okunmaz (kapı salondur).
export const approveInstructor = async (req: Request, res: Response) => {
  try {
    // Boolean kapısı — bkz. verifyInstructor: boş gövde SESSİZCE onayı kaldırıyordu.
    const { approved } = req.body
    if (typeof approved !== 'boolean') return res.status(400).json({ error: 'approved alanı boolean olmalı.' })
    const instructorId = parseInt(req.params.id as string)
    if (!instructorId || isNaN(instructorId)) return res.status(400).json({ error: 'Geçersiz hoca.' })

    const reason = typeof req.body.reason === 'string' ? clampStr(req.body.reason, 500) : null

    const existing = await prisma.instructor.findUnique({
      where: { id: instructorId },
      select: { venueId: true },
    })
    if (!existing) return res.status(404).json({ error: 'Hoca bulunamadı.' })
    // Salona bağlı eğitmende bu alan hiçbir kapıyı açıp kapatmıyor. Yazılmasına izin vermek,
    // panelde "onayladım ama hiçbir şey değişmedi" yanılsaması üretirdi.
    if (existing.venueId != null) {
      return res.status(400).json({ error: 'Bu eğitmen bir salona bağlı; görünürlüğü salonun onayına tabidir.' })
    }

    const instructor = await prisma.instructor.update({
      where: { id: instructorId },
      data: {
        isApproved: approved,
        approvedAt: approved ? new Date() : null,
        rejectionReason: approved ? null : reason,
      },
      select: { id: true, fullName: true, email: true, isApproved: true, approvedAt: true, rejectionReason: true },
    })
    return res.json({
      message: approved ? 'Eğitmen onaylandı; dersleri yayına çıkabilir.' : 'Onay kaldırıldı; dersleri yayından düştü.',
      instructor,
    })
  } catch (err) {
    if (handlePrismaErr(err, res)) return
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}
