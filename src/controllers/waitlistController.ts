import { Request, Response } from 'express'
import prisma from '../utils/prisma'
import { sendWaitlistNotificationEmail } from '../utils/email'
import { sendPushNotification } from '../utils/push'
import { trDate, trTime } from "../utils/trFormat"
import { notifyFields, notifyPush } from '../utils/notifyText'
import { Locale } from '../utils/locale'
// API SÖZLEŞMESİ — üç repoda birebir aynı dosya (bkz. scripts/tip-damgasi.cjs).
import type { WaitlistStatusResponse, WaitlistActionResponse, ApiError } from '../types/api'

// Bekleme listesine katıl
export const joinWaitlist = async (req: Request, res: Response<WaitlistActionResponse | ApiError>) => {
  try {
    const userId = (req as any).userId
    const sessionId = parseInt(req.params.sessionId as string)

    const session = await prisma.class_Session.findUnique({
      where: { id: sessionId },
      include: { class: { include: { venue: { select: { isApproved: true, isActive: true, isSuspended: true } } } } }
    })
    if (!session) return res.status(404).json({ error: 'Seans bulunamadı.' })
    // DURUM KAPILARI: createBooking hedef seans için bunları kontrol ediyor, joinWaitlist ETMİYORDU
    // → kullanıcı geçmiş/kapalı bir seansın ya da askıya alınmış salonun bekleme listesine girebiliyor,
    // orada sonsuza dek "sıra 1" görünüyordu (o yer hiç açılmayacağı için bildirim de gelmez).
    if (session.status !== 'open') return res.status(400).json({ error: 'Bu seans rezervasyona kapalı.' })
    if (new Date(session.startsAt) <= new Date()) return res.status(400).json({ error: 'Geçmiş bir seans için bekleme listesine girilemez.' })
    if (!session.class?.isActive) return res.status(400).json({ error: 'Bu ders şu anda kapalı.' })
    const wv = session.class?.venue
    if (!wv || !wv.isApproved || !wv.isActive || wv.isSuspended) return res.status(400).json({ error: 'Salon şu anda aktif değil.' })

    // Zaten kayıtlı mı?
    const existingBooking = await prisma.booking.findFirst({
      where: { userId, sessionId, status: { in: ['confirmed', 'pending'] } }
    })
    if (existingBooking) return res.status(400).json({ error: 'Zaten bu derse kayıtlısınız.' })

    // Bekleme listesi yalnızca DOLU seans için. Yer varsa doğrudan rezervasyon yapılmalı
    // (aksi halde kullanıcı yer varken beklemeye takılır ve iptal olmadan bildirim alamaz).
    const occupancy = await prisma.booking.aggregate({
      where: { sessionId, status: { in: ['confirmed', 'pending'] } },
      _sum: { groupSize: true },
    })
    const occupied = occupancy._sum.groupSize || 0
    if (session.capacity != null && occupied < session.capacity) {
      return res.status(400).json({ error: 'Bu seansta yer var, doğrudan rezervasyon yapabilirsiniz.' })
    }

    // Zaten bekliyor mu?
    const existing = await prisma.waitlist.findUnique({
      where: { userId_sessionId: { userId, sessionId } }
    })
    if (existing) return res.status(400).json({ error: 'Zaten bekleme listesindesiniz.' })

    const entry = await prisma.waitlist.create({
      data: { userId, sessionId }
    })

    return res.status(201).json({ message: 'Bekleme listesine eklendi.', entry })
  } catch (err: any) {
    if (err?.code === 'P2002') return res.status(400).json({ error: 'Zaten bekleme listesindesiniz.' })
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// Bekleme listesinden çık
export const leaveWaitlist = async (req: Request, res: Response<WaitlistActionResponse | ApiError>) => {
  try {
    const userId = (req as any).userId
    const sessionId = parseInt(req.params.sessionId as string)

    await prisma.waitlist.deleteMany({ where: { userId, sessionId } })
    return res.json({ message: 'Bekleme listesinden çıkıldı.' })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// Seans için bekleme listesi durumu
export const getWaitlistStatus = async (req: Request, res: Response<WaitlistStatusResponse | ApiError>) => {
  try {
    const userId = (req as any).userId
    const sessionId = parseInt(req.params.sessionId as string)

    const entry = await prisma.waitlist.findUnique({
      where: { userId_sessionId: { userId, sessionId } }
    })
    const count = await prisma.waitlist.count({ where: { sessionId } })

    // Sıradaki GERÇEK yer = kendinden önce (daha erken) katılanların sayısı + 1
    // (önceden yanlışlıkla toplam sayı dönüyordu — 5 kişi varken 2. kişiye de "5" diyordu)
    let position: number | null = null
    if (entry) {
      const ahead = await prisma.waitlist.count({ where: { sessionId, createdAt: { lt: entry.createdAt } } })
      position = ahead + 1
    }

    return res.json({ onWaitlist: !!entry, position, totalWaiting: count })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// İptal olunca waitlist'teki ilk kişiye bildir (bookingController'dan çağrılacak)
export const notifyFirstWaitlistUser = async (sessionId: number) => {
  try {
    // Eşzamanlı iki iptal (2 yer boşalır) yarışında her iptal FARKLI bir bekleyeni bildirmeli.
    // Kilitsiz findFirst+update, ikisinin de aynı ilk bekleyeni bulup 2 kez bildirmesine + 2. yeri
    // hak edene hiç bildirim gitmemesine yol açıyordu. En eski 'waiting' satırı FOR UPDATE SKIP LOCKED
    // ile atomik "sahiplenilir" → ikinci çağrı kilitli satırı atlayıp SIRADAKİ bekleyeni alır.
    const first = await prisma.$transaction(async (tx) => {
      // banned=false: banlı bekleyen sırayı BAŞTAN kapıp tek "yer açıldı" bildirimini tüketir ama
      // authMiddleware 403 verdiğinden hiç rezerve edemez → sıradaki gerçek bekleyen hiç haber almaz.
      // Yalnız Waitlist satırını kilitle (FOR UPDATE OF w) — join'lenen User satırını değil.
      // 'notified' ÖLÜ BİR DURUMDU: kod tabanında yalnız aşağıda YAZILIYOR, hiçbir yerde geri
      // 'waiting'e çevrilmiyordu. Bildirim gönderilen kişi yeri kapamazsa (araya başkası girdi,
      // e-postayı geç gördü) satırı kalıcı olarak 'notified'da kalıyor ve bir daha ASLA
      // bildirim alamıyordu — sırada görünmeye devam ederek sessizce dışlanıyordu.
      // Çözüm: bildirim bir ÖNCELİK PENCERESİ. Pencere dolduysa kişi havuza geri döner ve
      // sıradaki boşlukta yeniden değerlendirilir; sıra yeri (createdAt) korunur.
      const rows = await tx.$queryRaw<{ id: number }[]>`
        SELECT w.id FROM "Waitlist" w
        JOIN "User" u ON u.id = w."userId"
        WHERE w."sessionId" = ${sessionId}
          AND u.banned = false
          AND (
            w.status = 'waiting'
            -- NOW() timestamptz döner; notifiedAt ise timestamp WITHOUT time zone (Prisma UTC yazar).
            -- Düz NOW() ile karşılaştırma DB OTURUMUNUN saat dilimine göre kayar: yerelde
            -- (TimeZone=America/Toronto) 31 dk önceki satır "4 saat sonrası" gibi görünüp hiç
            -- seçilmiyordu. Railway'de TZ=UTC olduğu için tesadüfen çalışırdı — doğru olduğu için değil.
            OR (w.status = 'notified' AND w."notifiedAt" < (NOW() AT TIME ZONE 'UTC') - INTERVAL '30 minutes')
          )
        -- SIRA GERÇEKTEN DEVREDİLİR. Eskiden yalnız createdAt'e göre sıralanıyordu: penceresi
        -- dolan kişi HÂLÂ en eski satır olduğu için her turda YİNE o seçiliyordu. Yani "30
        -- dakikalık öncelik penceresi" sırayı hiç ilerletmiyor, cevap vermeyen ilk kişi
        -- arkasındaki herkesi süresiz blokluyor ve yer boş kalmaya devam ediyordu.
        -- Artık: önce HİÇ bildirilmemiş olanlar ('waiting'), sonra penceresi dolmuş olanlar;
        -- her grubun kendi içinde sıra yeri (createdAt) korunur. Herkes bir tur aldıktan
        -- sonra baştakiler yeniden sıraya girer → açlık (starvation) yok, sıra da bozulmaz.
        ORDER BY (w.status = 'notified') ASC, w."createdAt" ASC
        LIMIT 1
        FOR UPDATE OF w SKIP LOCKED`
      if (!rows.length) return null
      return tx.waitlist.update({
        where: { id: rows[0].id },
        data: { status: 'notified', notifiedAt: new Date() },
        include: {
          user: { select: { id: true, email: true, fullName: true, pushToken: true, emailReminders: true, locale: true } },
          session: { include: { class: true } },
        },
      })
    })

    if (!first) return

    const startsAt = new Date(first.session.startsAt)
    const date = trDate(startsAt)
    const time = trTime(startsAt)
    const wlLoc = (first.user?.locale || 'tr') as Locale
    const wlParams = { classTitle: first.session.class.title, date, time }
    // IN-APP Notification eklendi (eskiden yalnız e-posta+push vardı → kullanıcı uygulamada göremiyordu).
    if (first.user?.id) {
      await prisma.notification.create({ data: { userId: first.user.id, type: 'waitlist_open', ...notifyFields(wlLoc, 'waitlist_open', wlParams) } }).catch(() => {})
    }
    // E-posta emailReminders opt-out'una saygı (diğer hatırlatma e-postalarıyla tutarlı). Push+in-app
    // her durumda gider → opt-out eden kullanıcı da beklediği yerden mahrum kalmaz.
    if (first.user?.email && first.user.emailReminders !== false) {
      await sendWaitlistNotificationEmail(first.user.email, first.user.fullName, first.session.class.title, date, time, wlLoc)
    }
    const wlPush = notifyPush(wlLoc, 'waitlist_open', wlParams)
    if (first.user?.pushToken && wlPush) {
      sendPushNotification(first.user.pushToken, wlPush.title, wlPush.body).catch(() => {})
    }
  } catch (e) {
    console.error('Waitlist notification error:', e)
  }
}
