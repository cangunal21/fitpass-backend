import { Request, Response } from 'express'
import prisma from '../utils/prisma'
import { instructorBlocked } from '../utils/seller'
import { clampStr, parseIntSafe } from '../utils/validate'
import { sanitizeReview, hidePrivateReply } from '../utils/reviews'
// API SÖZLEŞMESİ — üç repoda birebir aynı dosya (bkz. scripts/tip-damgasi.cjs).
import type { VenueReviewsResponse, ApiError } from '../types/api'
import { trafikKaydet } from '../utils/trafikKaydi'

// Yorum/puan ekle (auth required)
// YENİ MODEL: Bir katılımdan İKİ satır — salon (targetType='venue') + hoca (targetType='instructor').
// Yalnızca derse KATILAN (check-in onaylı) kullanıcı, ders bitiminden 2 SAAT sonra puanlayabilir.
// Salon puanı zorunlu; hoca puanı ders bir hocaya bağlıysa opsiyonel. İki ayrı opsiyonel yorum.
export const createReview = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId
    const bookingId = parseIntSafe(req.body.bookingId) // int4 aralığı garanti (taşan/bozuk → undefined)

    // Geriye dönük uyum: eski istemci `rating`/`comment` (tekil) gönderir → salon puanı say
    const venueRating = parseInt(req.body.venueRating ?? req.body.rating)
    const instructorRaw = req.body.instructorRating
    const hasInstructorRating = instructorRaw !== undefined && instructorRaw !== null && instructorRaw !== ''
    const instructorRating = hasInstructorRating ? parseInt(instructorRaw) : null
    const venueComment = req.body.venueComment ?? req.body.comment
    const instructorComment = req.body.instructorComment
    // Boolean'a ZORLA: ham gövde değeri (ör. "evet"/1/{}) non-null Boolean kolona gidince Prisma
    // PrismaClientValidationError fırlatıyordu; handler'ın P2002/P2003 dalları bunu kapsamadığı için 500 dönerdi.
    const rawAnon = req.body.isAnonymous
    const isAnonymous = (rawAnon === undefined || rawAnon === null)
      ? true
      : (rawAnon === true || rawAnon === 'true' || rawAnon === 1 || rawAnon === '1')

    const validRating = (r: number) => Number.isInteger(r) && r >= 1 && r <= 5
    if (!bookingId || !validRating(venueRating)) {
      return res.status(400).json({ error: 'Geçerli bir salon puanı (1-5) ve rezervasyon gerekli.' })
    }
    if (hasInstructorRating && !validRating(instructorRating as number)) {
      return res.status(400).json({ error: 'Geçerli bir hoca puanı (1-5) girin.' })
    }

    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: {
        session: {
          select: {
            startsAt: true,
            endsAt: true,
            class: { select: { id: true, venueId: true, instructorId: true } },
          },
        },
      },
    })
    if (!booking || booking.userId !== userId) {
      return res.status(403).json({ error: 'Bu rezervasyon size ait değil.' })
    }
    if (booking.status !== 'confirmed') {
      return res.status(400).json({ error: 'Yalnızca tamamlanan rezervasyonlar için puan verilebilir.' })
    }
    // Yalnızca derse KATILAN (salon check-in kodunu okutmuş) kullanıcı puanlayabilir
    if (!booking.checkedIn) {
      return res.status(403).json({ error: 'Yalnızca derse katıldığınız (giriş onaylı) rezervasyonlar puanlanabilir.' })
    }
    // Puanlama ders BİTTİĞİ an açılır (uygulamayı hemen açarsa direkt puanlayabilir).
    // +2 saat yalnızca "hatırlatma bildirimi" için (ratingPromptJob), puanlama hakkını geciktirmez.
    const endsAt = booking.session?.endsAt
    if (!endsAt || Date.now() < new Date(endsAt).getTime()) {
      return res.status(400).json({ error: 'Puanlama ders bittikten sonra açılır.' })
    }

    // Zaten puanlandı mı? (salon satırı referans alınır — bir booking tek kez puanlanır)
    const existing = await prisma.review.findUnique({
      where: { bookingId_targetType: { bookingId, targetType: 'venue' } },
    })
    if (existing) {
      return res.status(400).json({ error: 'Bu ders için zaten puan verdiniz.' })
    }

    const venueId = booking.session?.class?.venueId || null
    const instructorId = booking.session?.class?.instructorId || null
    const classId = booking.session?.class?.id || null
    // Ders bir hocaya bağlı değilse hoca puanı yok sayılır
    const willRateInstructor = hasInstructorRating && instructorId != null

    // Salon + (varsa) hoca satırı oluşturma + iki ortalamayı yeniden hesaplama TEK transaction'da.
    // Salon/hoca satırı FOR UPDATE ile kilitlenir → eşzamanlı puanlar sıraya girer, recompute
    // tüm commit'li puanları görür (totalReviews/avgRating sapmaz).
    const result = await prisma.$transaction(async (tx) => {
      if (venueId) await tx.$executeRaw`SELECT id FROM "Venue" WHERE id = ${venueId} FOR UPDATE`
      if (willRateInstructor) await tx.$executeRaw`SELECT id FROM "Instructor" WHERE id = ${instructorId} FOR UPDATE`

      const venueReview = await tx.review.create({
        data: {
          bookingId, reviewerUserId: userId, targetType: 'venue',
          venueId, classId, rating: venueRating,
          comment: clampStr(venueComment, 1000) || null, isAnonymous,
        },
      })
      let instructorReview = null
      if (willRateInstructor) {
        instructorReview = await tx.review.create({
          data: {
            bookingId, reviewerUserId: userId, targetType: 'instructor',
            instructorId, classId, rating: instructorRating as number,
            comment: clampStr(instructorComment, 1000) || null, isAnonymous,
          },
        })
      }
      // Salon ortalaması (instructor satırlarında venueId=null → kirlenmez)
      if (venueId) {
        const vr = await tx.review.findMany({ where: { venueId }, select: { rating: true } })
        const avg = vr.reduce((s, r) => s + r.rating, 0) / vr.length
        await tx.venue.update({ where: { id: venueId }, data: { avgRating: Math.round(avg * 10) / 10, totalReviews: vr.length } })
      }
      // Hoca ortalaması (venue satırlarında instructorId=null → kirlenmez)
      if (willRateInstructor) {
        const ir = await tx.review.findMany({ where: { instructorId }, select: { rating: true } })
        const avg = ir.reduce((s, r) => s + r.rating, 0) / ir.length
        await tx.instructor.update({ where: { id: instructorId as number }, data: { avgRating: Math.round(avg * 10) / 10, totalReviews: ir.length } })
      }
      return { venueReview, instructorReview }
    })

    // 5651 yer sağlayıcı trafik kaydı — yayımlanan içeriği kimin nereden yayımladığı.
    trafikKaydet(req, 'icerik_yayin', { ozne: 'user', ozneId: (req as any).userId, icerikTuru: 'review', icerikId: result.venueReview?.id ?? null })

    return res.status(201).json({ message: 'Puanınız kaydedildi!', ...result })
  } catch (err: any) {
    // Çift-submit yarışı: existing kontrolü sıralı durumu yakalar, eşzamanlıda unique
    // (bookingId,targetType) ihlali P2002 fırlatır → 500 yerine aynı zarif mesajı döndür
    if (err?.code === 'P2002') return res.status(400).json({ error: 'Bu ders için zaten puan verdiniz.' })
    // Nadir yarış: booking okunduktan sonra hoca/salon silinirse FK ihlali (P2003) → 500 yerine zarif 400
    if (err?.code === 'P2003') return res.status(400).json({ error: 'Puanlama şu an yapılamıyor, ders/hoca güncellenmiş olabilir.' })
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// Puanlanmayı bekleyen dersler (auth). "Katıldım ama puanlamadım": check-in onaylı + confirmed +
// ders BİTMİŞ (endsAt <= now, createReview kapısıyla birebir) + o booking için salon (targetType='venue')
// yorumu YOK. Mobil bunu foreground'da çekip puanlama modalını açar. Hassas alan sızmaması için
// include DEĞİL nested select kullanılır (venue finans/checkInCode dönmez).
export const getPendingRatings = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId
    const now = new Date()

    const bookings = await prisma.booking.findMany({
      where: {
        userId,
        status: 'confirmed',
        checkedIn: true,
        session: { endsAt: { lte: now } },          // session non-null + ders bitmiş
        reviews: { none: { targetType: 'venue' } },  // salon puanı henüz verilmemiş
      },
      select: {
        id: true,
        session: {
          select: {
            endsAt: true,
            class: {
              select: {
                title: true,
                titleEn: true,
                venueId: true,
                instructorId: true,
                venue: { select: { id: true, name: true } },
                instructor: { select: { id: true, fullName: true } },
              },
            },
          },
        },
      },
      orderBy: { session: { endsAt: 'desc' } },
      take: 20,
    })

    const pending = bookings.map(b => ({
      bookingId: b.id,
      className: b.session!.class.title,
      classNameEn: b.session!.class.titleEn,
      venueId: b.session!.class.venueId,
      venueName: b.session!.class.venue?.name ?? null,
      instructorId: b.session!.class.instructorId,
      instructorName: b.session!.class.instructor?.fullName ?? null,
      endsAt: b.session!.endsAt,
    }))

    return res.json({ pending })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// Salon yanıtı (venue auth)
export const replyToReview = async (req: Request, res: Response) => {
  try {
    const venueId = (req as any).venueId
    const reviewId = parseInt(req.params.id as string)
    const { reply } = req.body
    // Yanıt görünürlüğü: 'public' (tüm kullanıcılar görür) | 'private' (yalnız yorumu yazan + platform)
    const replyVisibility = req.body.visibility === 'private' ? 'private' : 'public'

    if (typeof reply !== 'string' || !reply.trim()) return res.status(400).json({ error: 'Yanıt boş olamaz.' })
    if (reply.length > 1000) return res.status(400).json({ error: 'Yanıt en fazla 1000 karakter olabilir.' })

    const review = await prisma.review.findUnique({ where: { id: reviewId } })
    if (!review || review.venueId !== venueId) {
      return res.status(403).json({ error: 'Bu yoruma yanıt verme yetkiniz yok.' })
    }

    const updated = await prisma.review.update({
      where: { id: reviewId },
      data: { venueReply: reply.trim(), venueRepliedAt: new Date(), replyVisibility }
    })

    // GÜVENLİK: ham satır reviewerUserId/bookingId taşır → anonim yorumda salon kimin verdiğini
    // görebilirdi. sanitizeReview anonimde bu alanları çıkarır (yalnız anonim satırları etkiler).
    return res.json({ message: 'Yanıtınız kaydedildi.', review: sanitizeReview(updated) })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// Salon yanıtını sil (venue auth)
export const deleteReviewReply = async (req: Request, res: Response) => {
  try {
    const venueId = (req as any).venueId
    const reviewId = parseInt(req.params.id as string)

    const review = await prisma.review.findUnique({ where: { id: reviewId } })
    if (!review || review.venueId !== venueId) {
      return res.status(403).json({ error: 'Yetki yok.' })
    }

    await prisma.review.update({
      where: { id: reviewId },
      data: { venueReply: null, venueRepliedAt: null, replyVisibility: null }
    })

    return res.json({ message: 'Yanıt silindi.' })
  } catch (err) {
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// Salon yorumlarını getir (public, optionalAuth: private yanıtı sahibine gösterebilmek için)
export const getVenueReviews = async (req: Request, res: Response<VenueReviewsResponse | ApiError>) => {
  try {
    const venueId = parseInt(req.params.venueId as string)
    const viewerId = (req as any).userId as number | undefined

    // MODERASYON KAPISI: kardeş public uçların hepsinde (getVenueById, getSessions, getDropInSlots)
    // `isApproved && isActive` şartı var ama YORUM ucunda yoktu → platformdan kaldırılan/askıya
    // alınan salonun yorumları (ve yorumcuların adları) public'te kalmaya devam ediyordu.
    // 404: salon "yok" gibi davranır, kardeş uçlarla tutarlı.
    const vGate = await prisma.venue.findUnique({
      where: { id: venueId },
      select: { isApproved: true, isActive: true, isSuspended: true },
    })
    if (!vGate || !vGate.isApproved || !vGate.isActive || vGate.isSuspended) {
      return res.status(404).json({ error: 'Salon bulunamadı.' })
    }

    const where = { venueId, targetType: 'venue' as const }
    // Ortalama/toplam TÜM yorumlardan (aggregate) hesaplanır — liste `take:50` ile sınırlı olduğundan
    // avg'i o dilimden hesaplarsak saklı venue.avgRating ile SAPARDI (ör. 80 yorumda 50'nin ortalaması).
    const [reviews, stats, dagilim] = await Promise.all([
      prisma.review.findMany({
        where,
        include: { reviewer: { select: { fullName: true, username: true, avatarUrl: true } } },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      prisma.review.aggregate({ where, _avg: { rating: true }, _count: true }),
      // YILDIZ DAĞILIMI SUNUCUDA: web'de bu dağılım SABİT KODLUYDU (5 yıldız %75, 4 yıldız %18,
      // gerisi %5) ve avgRating ne olursa olsun aynı çubuklar çiziliyordu — yani kullanıcıya
      // UYDURMA veri gösteriliyordu, üstelik rezervasyon kararını etkileyen bir yerde.
      // İstemcide `reviews` dizisinden hesaplamak da YANLIŞ olurdu: o liste `take: 50` ile
      // sınırlı, 80 yorumlu salonda dağılım sapardı (avgRating'in aggregate'ten gelme sebebiyle aynı).
      prisma.review.groupBy({ by: ['rating'], where, _count: { rating: true } }),
    ])

    const safeReviews = reviews.map(r => hidePrivateReply(r, sanitizeReview(r), viewerId))
    const avgRating = stats._avg.rating ? Math.round(stats._avg.rating * 10) / 10 : 0
    // Her yıldız için sayı — hiç yorum almamış yıldız da 0 ile GELİR (istemci eksik anahtar
    // aramasın, çubuğu doğrudan çizebilsin).
    const ratingBreakdown: Record<'1' | '2' | '3' | '4' | '5', number> = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 }
    for (const g of dagilim) {
      const yildiz = String(Math.round(g.rating)) as '1' | '2' | '3' | '4' | '5'
      if (yildiz in ratingBreakdown) ratingBreakdown[yildiz] += g._count.rating
    }
    return res.json({ reviews: safeReviews, avgRating, totalReviews: stats._count, ratingBreakdown })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// Hoca yorumlarını getir (public, optionalAuth) — hoca profilinde gösterilir
export const getInstructorReviews = async (req: Request, res: Response) => {
  try {
    const instructorId = parseInt(req.params.instructorId as string)
    const viewerId = (req as any).userId as number | undefined

    // MODERASYON KAPISI (bkz. getVenueReviews): pasif eğitmenin ya da askıya alınmış/onaysız
    // salona bağlı eğitmenin yorumları public'te kalmaya devam ediyordu.
    const iGate = await prisma.instructor.findUnique({
      where: { id: instructorId },
      select: { isActive: true, isApproved: true, venueId: true, venue: { select: { isApproved: true, isActive: true, isSuspended: true } } },
    })
    // Mekânsız eğitmende `venue` null olduğu için eski iki dallı kontrol onu HİÇ elemiyordu
    // (onaysız hocanın yorumları public kalırdı). Kapı tek yardımcıdan.
    if (instructorBlocked(iGate)) {
      return res.status(404).json({ error: 'Eğitmen bulunamadı.' })
    }

    const where = { instructorId, targetType: 'instructor' as const }
    const [reviews, stats] = await Promise.all([
      prisma.review.findMany({
        where,
        include: { reviewer: { select: { fullName: true, username: true, avatarUrl: true } } },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      prisma.review.aggregate({ where, _avg: { rating: true }, _count: true }),
    ])

    const avg = stats._avg.rating ? Math.round(stats._avg.rating * 10) / 10 : 0
    const safeReviews = reviews.map(r => hidePrivateReply(r, sanitizeReview(r), viewerId))

    return res.json({ reviews: safeReviews, avgRating: avg, totalReviews: stats._count })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// ─── EĞİTMEN PORTALI (instructorAuth) — eğitmen KENDİ yorumlarını görür + yanıtlar ───

// Eğitmenin kendi yorumları (req.instructorId'den). GÜVENLİK: anonim yorumda yorum sahibinin
// kimliği sanitizeReview ile gizlenir (eğitmen kimin kaç verdiğini göremez — salonla aynı kural).
// Salonun KENDİ yorumları (salon paneli için). Eğitmendeki getMyInstructorReviews'ın salon aynası.
//
// NEDEN GEREKLİ: salon panelleri yorumları PUBLIC uçtan (getVenueReviews) okuyordu; o uç
// `hidePrivateReply` uyguladığı için salon KENDİ yazdığı ÖZEL yanıtı bile göremiyordu. Yani özel
// yanıt özelliği backend'de hazır olmasına rağmen kullanılamaz durumdaydı: salon yanıtı yazınca
// panelinde kaybolurdu. Sahip ucunda gizleme YOK — yanıt zaten salonun kendisine ait.
export const getMyVenueReviews = async (req: Request, res: Response) => {
  try {
    const venueId = (req as any).venueId
    const where = { venueId, targetType: 'venue' as const }
    const [reviews, stats] = await Promise.all([
      prisma.review.findMany({
        where,
        include: { reviewer: { select: { fullName: true, username: true, avatarUrl: true } } },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
      prisma.review.aggregate({ where, _avg: { rating: true }, _count: true }),
    ])
    const avg = stats._avg.rating ? Math.round(stats._avg.rating * 10) / 10 : 0
    // sanitizeReview: anonim yorumda yazar kimliğini gizler (salon da göremez — o kural korunur).
    // hidePrivateReply UYGULANMAZ: salon kendi yanıtını görmeli.
    const safeReviews = reviews.map(r => sanitizeReview(r))
    return res.json({ reviews: safeReviews, avgRating: avg, totalReviews: stats._count })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

export const getMyInstructorReviews = async (req: Request, res: Response) => {
  try {
    const instructorId = (req as any).instructorId
    const where = { instructorId, targetType: 'instructor' as const }
    const [reviews, stats] = await Promise.all([
      prisma.review.findMany({
        where,
        include: { reviewer: { select: { fullName: true, username: true, avatarUrl: true } } },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
      prisma.review.aggregate({ where, _avg: { rating: true }, _count: true }),
    ])
    const avg = stats._avg.rating ? Math.round(stats._avg.rating * 10) / 10 : 0
    // Eğitmen kendi yanıtını görebilmeli → viewerId'yi geçmeye gerek yok, kendi yanıtı zaten public/private
    // ayrımından bağımsız kendisine ait; ama private-başkası yanıtı yok (tek reply kolonu) → sanitize yeter.
    const safeReviews = reviews.map(r => sanitizeReview(r))
    return res.json({ reviews: safeReviews, avgRating: avg, totalReviews: stats._count })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// Eğitmen yorum yanıtı (instructorAuth). Sahiplik: review.targetType==='instructor' VE
// review.instructorId===req.instructorId (aksi halde eğitmen salon yorumuna yanıt yazamaz).
export const instructorReplyToReview = async (req: Request, res: Response) => {
  try {
    const instructorId = (req as any).instructorId
    const reviewId = parseInt(req.params.id as string)
    const { reply } = req.body
    const replyVisibility = req.body.visibility === 'private' ? 'private' : 'public'

    if (typeof reply !== 'string' || !reply.trim()) return res.status(400).json({ error: 'Yanıt boş olamaz.' })
    if (reply.length > 1000) return res.status(400).json({ error: 'Yanıt en fazla 1000 karakter olabilir.' })

    const review = await prisma.review.findUnique({ where: { id: reviewId } })
    if (!review || review.targetType !== 'instructor' || review.instructorId !== instructorId) {
      return res.status(403).json({ error: 'Bu yoruma yanıt verme yetkiniz yok.' })
    }

    const updated = await prisma.review.update({
      where: { id: reviewId },
      data: { venueReply: reply.trim(), venueRepliedAt: new Date(), replyVisibility },
    })
    // GÜVENLİK: anonim yorumda reviewerUserId/bookingId sızmasın (eğitmen kimin verdiğini görmemeli)
    return res.json({ message: 'Yanıtınız kaydedildi.', review: sanitizeReview(updated) })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// Eğitmen yanıtını sil (instructorAuth, aynı sahiplik)
export const deleteInstructorReply = async (req: Request, res: Response) => {
  try {
    const instructorId = (req as any).instructorId
    const reviewId = parseInt(req.params.id as string)
    const review = await prisma.review.findUnique({ where: { id: reviewId } })
    if (!review || review.targetType !== 'instructor' || review.instructorId !== instructorId) {
      return res.status(403).json({ error: 'Yetki yok.' })
    }
    await prisma.review.update({
      where: { id: reviewId },
      data: { venueReply: null, venueRepliedAt: null, replyVisibility: null },
    })
    return res.json({ message: 'Yanıt silindi.' })
  } catch (err) {
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

/**
 * GİZLİ SEANS GERİ BİLDİRİMİ — yalnızca yöneticiye iletilir.
 *
 * Public puanlamadan (createReview) AYRI bir uçtur ve check-in ARAMAZ. Sebebi: "hoca gelmedi"
 * vakasında check-in zaten yoktur; createReview'ın checkedIn şartını buraya da koysaydık,
 * tam olarak yakalamak istediğimiz olayı raporlanamaz kılardık.
 *
 * İSTEĞE BAĞLIDIR (kullanıcı kararı 26 Ağu 2026): kullanıcı bu adımı atlayabilir.
 */
export const gizliGeriBildirim = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId
    const bookingId = parseInt(req.body?.bookingId)
    if (!bookingId) return res.status(400).json({ error: 'Rezervasyon gerekli.' })

    const ilanEdilenGibi = req.body?.ilanEdilenGibi
    if (typeof ilanEdilenGibi !== 'boolean') {
      return res.status(400).json({ error: 'Cevap evet/hayır olmalı.' })
    }

    const GECERLI_SEBEP = ['hoca_gelmedi', 'kisa_surdu', 'baglanti', 'icerik_farkli', 'diger']
    const sebepRaw = typeof req.body?.sebep === 'string' ? req.body.sebep : null
    // "Evet" cevabında sebep anlamsızdır; taşınırsa veriyi kirletir.
    const sebep = ilanEdilenGibi ? null : (sebepRaw && GECERLI_SEBEP.includes(sebepRaw) ? sebepRaw : null)
    const yorum = typeof req.body?.yorum === 'string' ? req.body.yorum.trim().slice(0, 1000) || null : null

    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      select: {
        id: true, userId: true, status: true,
        session: { select: { endsAt: true, class: { select: { venueId: true, instructorId: true } } } },
      },
    })
    if (!booking) return res.status(404).json({ error: 'Rezervasyon bulunamadı.' })
    // Sahiplik: başkasının dersi hakkında geri bildirim verilemez.
    if (booking.userId !== userId) return res.status(403).json({ error: 'Yetki yok.' })
    if (booking.status !== 'confirmed') {
      return res.status(400).json({ error: 'Yalnızca geçerli rezervasyonlar için geri bildirim verilebilir.' })
    }
    // Ders BİTMEDEN "yapılmadı" denemez.
    const endsAt = booking.session?.endsAt
    if (!endsAt || Date.now() < new Date(endsAt).getTime()) {
      return res.status(400).json({ error: 'Ders bitmeden geri bildirim verilemez.' })
    }

    try {
      const kayit = await prisma.seansGeriBildirim.create({
        data: {
          bookingId, userId,
          venueId: booking.session?.class?.venueId ?? null,
          instructorId: booking.session?.class?.instructorId ?? null,
          ilanEdilenGibi, sebep, yorum,
        },
      })
      return res.status(201).json({ message: 'Geri bildiriminiz yöneticilere iletildi.', id: kayit.id })
    } catch (e: any) {
      // bookingId UNIQUE: aynı ders için ikinci kez gönderilemez.
      if (e?.code === 'P2002') return res.status(409).json({ error: 'Bu ders için geri bildirim zaten gönderilmiş.' })
      throw e
    }
  } catch (err) {
    console.error('gizliGeriBildirim error:', err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}
