import { Request, Response } from 'express'
import prisma from '../utils/prisma'
import crypto from 'crypto'
import { sendVenueBookingNotificationEmail, sendCancellationEmail, sendVenueCancellationEmail, sendBookingConfirmationEmail, sendGroupTagNotificationEmail, sendGroupInviteEmail, sendCashbackEmail, sendTransferEmail } from '../utils/email'
import { sendPushNotification } from '../utils/push'
import { completeReferral } from './referralController'
import { resetYearlyPointsIfNeeded, reversiblePoints } from '../utils/tier'
import { clampStr } from '../utils/validate'
import { stripVenueSensitive } from '../utils/sanitize'
import { trDate, trTime } from "../utils/trFormat"
import { notifyFields, notifyPush, notifyText } from '../utils/notifyText'
import { Locale } from '../utils/locale'
// API SÖZLEŞMESİ — üç repoda birebir aynı dosya (bkz. scripts/tip-damgasi.cjs).
import type { MyBookingsResponse, ApiError } from '../types/api'

class BookingError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

// Parayı kuruş hassasiyetinde yuvarla — ikili kayan-nokta sapmasını (0.1+0.2 vb.) önler.
// (Ödeme entegrasyonu eklenince tüm para alanları Int-kuruş'a taşınmalı.)
const money = (x: number) => Math.round(x * 100) / 100

// Rezervasyon oluştur
export const createBooking = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId
    const { sessionId: rawSessionId, notes, groupSize: rawGroupSize, taggedUsernames, couponCode } = req.body
    const sessionId = parseInt(rawSessionId)
    const groupSize = Math.max(1, Math.min(parseInt(rawGroupSize) || 1, 10))
    const rawTags: string[] = Array.isArray(taggedUsernames) ? taggedUsernames.slice(0, groupSize - 1) : []
    // normalize: @ temizle + küçült + TEKİLLEŞTİR (aynı kişi 2 kez etiketlenip çift bildirim almasın)
    let cleanTags = [...new Set(rawTags.map((u: string) => u.replace(/^@/, '').toLowerCase().trim()).filter(Boolean))]
    // Kendini etiketleme: kişi kendini davet edemez (kendine "davet edildin" bildirimi gitmesin)
    if (cleanTags.length) {
      const me = await prisma.user.findUnique({ where: { id: userId }, select: { username: true } })
      if (me?.username) cleanTags = cleanTags.filter(u => u !== me.username!.toLowerCase())
    }
    // GAMING ÖNLEME: etiketleri GERÇEK (banlı olmayan) kullanıcılara indirge → var olmayan/banlı
    // kullanıcı ('asdf' gibi) etiketleyip "Takım" rozeti oyunlanamaz. taggedFriends yalnız gerçek
    // kullanıcıları tutar (bildirim döngüsüyle aynı case-insensitive eşleşme).
    if (cleanTags.length) {
      const realUsers = await prisma.user.findMany({
        where: { banned: false, OR: cleanTags.map(u => ({ username: { equals: u, mode: 'insensitive' as const } })) },
        select: { username: true },
      })
      const realSet = new Set(realUsers.map(u => u.username.toLowerCase()))
      cleanTags = cleanTags.filter(u => realSet.has(u))
    }

    if (!sessionId || isNaN(sessionId)) {
      return res.status(400).json({ error: 'Geçerli bir ders seansı gerekli.' })
    }

    let coupon: { id: number; discountType: string; discountValue: number } | null = null
    let couponDiscount = 0
    let finalAmount = 0
    let booking: any

    // Puanlar yıllık sıfırlanır; kazandırmadan önce yıl damgasını güncelle
    await resetYearlyPointsIfNeeded(userId)

    try {
      // Tüm kapasite/kupon/kredi kontrolü ve yazma işlemi tek transaction içinde,
      // seans satırı kilitlenerek aynı anda gelen isteklerin sıraya girmesi sağlanır
      // (iki kişi son boş yere aynı anda tıklarsa kapasite aşılmasın diye).
      booking = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT id FROM "Class_Session" WHERE id = ${sessionId} FOR UPDATE`

        const session = await tx.class_Session.findUnique({
          where: { id: sessionId },
          include: { class: { include: { venue: { select: { isActive: true, isApproved: true } } } } },
        })

        if (!session) throw new BookingError('Ders seansı bulunamadı.', 404)
        // Geçmiş/başlamış seansa rezervasyon yapılamaz — aksi halde geçmiş seansı booklayıp
        // (katılmadan) yorum kilidini (startsAt < now) baypas edip sahte yorum yazılabilirdi.
        if (new Date(session.startsAt) <= new Date()) {
          throw new BookingError('Bu seans başlamış, rezervasyon yapılamaz.', 400)
        }
        // Donmuş/onaysız salonun seansına (eski linkle) rezervasyon yapılamaz
        if (!session.class.venue || !session.class.venue.isActive || !session.class.venue.isApproved) {
          throw new BookingError('Bu salon şu anda rezervasyona kapalı.', 400)
        }
        // Salon KAPATTIĞI ders (isActive=false) ya da kapalı seans hâlâ ayakta olan sessionId'siyle booklanamaz —
        // aksi halde tüm listelerden gizlenen ders eski/enumerate edilmiş linkle rezerve edilir (kapasite yanar + puan kazanılır).
        if (!session.class.isActive) throw new BookingError('Bu ders şu anda rezervasyona kapalı.', 400)
        if (session.status !== 'open') throw new BookingError('Bu seans rezervasyona kapalı.', 400)

        // Kapasite = onaylı/bekleyen rezervasyonların groupSize TOPLAMI
        // (satır sayısı değil — bir rezervasyon birden çok kişilik olabilir, grup rezervasyonunda overbooking olmasın diye)
        const occupancy = await tx.booking.aggregate({
          where: { sessionId, status: { in: ['confirmed', 'pending'] } },
          _sum: { groupSize: true },
        })
        const occupied = occupancy._sum.groupSize || 0

        if (session.capacity != null && occupied + groupSize > session.capacity) {
          const remaining = session.capacity - occupied
          throw new BookingError(remaining <= 0 ? 'Bu ders seansı dolu.' : `Sadece ${remaining} kontenjan kaldı.`, 400)
        }

        const existing = await tx.booking.findFirst({
          where: { userId, sessionId, status: { in: ['confirmed', 'pending'] } },
        })

        if (existing) throw new BookingError('Bu derse zaten kayıtlısınız.', 400)

        const basePrice = (session.class?.basePrice || 0) * groupSize

        if (couponCode) {
          // KİLİT SIRASI: User → Coupon (kod tabanının tamamıyla aynı: User → Class_Session →
          // Booking → Coupon). Eskiden burada önce Coupon kilitleniyordu; cancelBooking ise
          // User'ı önce kilitliyor → aynı kullanıcı + aynı kupon üzerinde eşzamanlı
          // rezervasyon+iptal döngüsel beklemeye (40P01 deadlock) giriyor, kurban istek
          // "Sunucu hatası" alıyordu.
          await tx.$executeRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`
          // TRIM: mobil istemci kodu kırpıyor, web ve sunucu KIRPMIYORDU. Kopyala-yapıştırda sona
          // eklenen tek boşluk "geçersiz kupon" demeye yetiyordu. Normalizasyon tek yerde.
          const kuponKodu = String(couponCode).trim().toUpperCase()
          await tx.$executeRaw`SELECT id FROM "Coupon" WHERE code = ${kuponKodu} FOR UPDATE`
          const found = await tx.coupon.findUnique({ where: { code: kuponKodu } })

          // ENUMERASYON/ORACLE ENGELİ — validateCoupon ile AYNI politika.
          // Buradaki dört red eskiden DÖRT AYRI mesaj veriyordu ('Geçersiz kupon kodu.' /
          // 'Bu kupon bu salona ait değil.' / 'Kupon süresi dolmuş.' / 'Kupon kullanım limiti dolmuş.').
          // couponController'daki sertleştirme bu yüzden fiilen işlevsizdi: saldırgan aynı bilgiyi
          // /api/bookings üzerinden alıyordu — üstelik couponLimiter (15/dk) YALNIZ
          // /api/public/validate-coupon'a bağlı olduğu için hız sınırı da yoktu.
          // ÖLÇÜLDÜ (17 Ağu 2026): 40 ardışık tahmin → validate-coupon'da 25'i limitlendi,
          // /api/bookings'te 40/40 geçti. Başarısız tahmin tx'i geri aldığı için iz de bırakmıyordu.
          const gecersiz = () => new BookingError('Geçersiz veya kullanılamaz kupon kodu.', 400)
          if (!found || !found.isActive) throw gecersiz()
          if (found.venueId !== session.class!.venueId) throw gecersiz()
          if (found.expiresAt && found.expiresAt < new Date()) throw gecersiz()
          if (found.maxUses && found.usedCount >= found.maxUses) throw gecersiz()
          // Kişi başı limit: bu kullanıcının bu kuponu kaç aktif (iptal edilmemiş) rezervasyonda kullandığını say.
          // Kupon satırı FOR UPDATE ile kilitli → eşzamanlı ikinci kullanım da bu kontrolde yakalanır.
          // perUserLimit mesajı BİLİNÇLİ olarak bilgilendirici: bu dal ancak kullanıcı kuponu DAHA ÖNCE
          // başarıyla kullandıysa çalışır — yani kodun varlığını zaten biliyor. Sızdırdığı yeni bilgi yok.
          if (found.perUserLimit != null) {
            const myUses = await tx.booking.count({ where: { couponId: found.id, userId, status: { not: 'cancelled' } } })
            if (myUses >= found.perUserLimit) throw new BookingError('Bu kuponu daha fazla kullanamazsınız (kişi başı limit doldu).', 400)
          }
          coupon = found
          // İKİ DAL DA money(): fixed dalı eskiden Math.min'i ham bırakıyordu → discountAmount kolonuna
          // yuvarlanmamış float (49.995 gibi) yazılıp baseAmount = finalAmount + discountAmount defter
          // özdeşliği 0.001 TL bozuluyordu. Artık her iki dal da 2 ondalığa yuvarlı.
          couponDiscount = found.discountType === 'percent'
            ? money(basePrice * (found.discountValue / 100))
            : money(Math.min(found.discountValue, basePrice))
        }

        const userWithTier = await tx.user.findUnique({
          where: { id: userId },
          select: { tier: { select: { pointRate: true } } },
        })

        finalAmount = money(Math.max(0, basePrice - couponDiscount))

        // Salon her zaman tam hak edişini alır; sadece salonun kendi kuponu payoutu etkiler.
        const venuePayout = money(Math.max(0, basePrice - couponDiscount))

        // Ödenen tutar üzerinden, kullanıcının tier'ına göre PUAN kazandırılır (ödüllerde kullanılır, indirim değil)
        const pointRate = userWithTier?.tier?.pointRate || 0
        const pointsEarned = finalAmount > 0 ? Math.round(finalAmount * (pointRate / 100)) : 0

        const created = await tx.booking.create({
          data: {
            userId,
            sessionId,
            bookingType: 'class',
            status: 'confirmed',
            notes: clampStr(notes, 500) || null,
            groupSize,
            baseAmount: money(basePrice), // money() ile yuvarla (finalAmount/venuePayout gibi) — grup×ondalık fiyatta float tozu kalmasın
            discountAmount: couponDiscount,
            commissionAmount: 0,
            userCommission: 0,
            venueCommission: 0,
            finalAmount,
            venuePayout,
            pointsEarned,
            couponId: coupon?.id || null,
            bookingNumber: `BK-${crypto.randomUUID()}`,
            // 6 bayt (12 hex): 4 bayt ~4.3 milyar idi ve @unique olduğu için çarpışma P2002
            // fırlatıp kullanıcıya "Sunucu hatası" (500) olarak dönüyordu. 6 bayt çarpışma
            // olasılığını pratikte sıfırlar; ayrıca kod hâlâ elle okunabilir uzunlukta.
            checkInCode: crypto.randomBytes(6).toString('hex').toUpperCase(),
            taggedFriends: cleanTags.length ? cleanTags : [],
          },
          include: {
            session: {
              include: { class: true },
            },
          },
        })

        if (coupon) {
          await tx.coupon.update({ where: { id: coupon.id }, data: { usedCount: { increment: 1 } } })
        }
        // NOT: puan artik REZERVASYONDA kredilenmez — check-in'de (awardAttendanceOnCheckin) verilir.
        // pointsEarned yine kaydedilir (oran booking aninda kilitlenir), kredilenme derse gidince olur.

        // Rezervasyon yapan kullanıcı bu seansın bekleme listesindeyse çıkar
        // (aksi halde hem "kayıtlı" hem "bekliyor" kalır → şişik sayaç + onWaitlist:true)
        await tx.waitlist.deleteMany({ where: { userId, sessionId } })

        return created
      })
    } catch (e: any) {
      if (e instanceof BookingError) return res.status(e.status).json({ error: e.message })
      throw e
    }

    // Salon email bildirimi
    try {
      const venue = await prisma.venue.findUnique({
        where: { id: booking.session!.class.venueId },
        select: { email: true, name: true },
      })

      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { fullName: true },
      })

      if (venue?.email) {
        const startsAt = new Date(booking.session!.startsAt)
        const date = trDate(startsAt)
        const time = trTime(startsAt)

        const occ = await prisma.booking.aggregate({
          where: { sessionId, status: { in: ['confirmed', 'pending'] } },
          _sum: { groupSize: true },
        })
        const occupiedSpots = occ._sum.groupSize || 0

        // BEKLENMİYOR. Rezervasyon transaction'ı ÇOKTAN commit oldu; bu yalnız bir bildirim.
        // `await` edildiğinde yanıt e-postanın hızına bağlanıyordu: her gönderim 8sn timeout'lu
        // ve bu uçta 2-11 gönderim SIRAYLA bekleniyordu (salon + kullanıcı + etiketlenen kişi
        // başına bir tane). Resend yavaşladığında mobil istemci 15sn'de vazgeçiyor, kullanıcı
        // "rezervasyon olmadı" sanıyor — OYSA OLMUŞTU. Hata zaten loglanıyor + sayaca yazılıyor.
        sendVenueBookingNotificationEmail(
          venue.email,
          venue.name,
          user?.fullName || 'Kullanıcı',
          booking.session!.class.title,
          date,
          time,
          booking.session!.capacity ?? 0,
          (booking.session!.capacity ?? 0) - occupiedSpots
        ).catch((e) => console.error('Venue booking email:', e))
      }
    } catch (emailErr) {
      console.error('Venue email notification error:', emailErr)
      // Don't fail the booking if email fails
    }

    // Kullanıcıya onay emaili
    try {
      const userForEmail = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, fullName: true, locale: true } })
      if (userForEmail?.email) {
        const startsAt = new Date(booking.session!.startsAt)
        const date = trDate(startsAt)
        const time = trTime(startsAt)
        // BEKLENMİYOR — gerekçe için bkz. yukarıdaki salon bildirimi.
        sendBookingConfirmationEmail(userForEmail.email, userForEmail.fullName, booking.session!.class.title, date, time, booking.finalAmount, (userForEmail.locale as Locale) || 'tr')
          .catch((e) => console.error('User confirmation email:', e))
      }
    } catch (emailErr) {
      console.error('User confirmation email error:', emailErr)
    }

    // (Cashback bildirimi check-in'e taşındı — awardAttendanceOnCheckin. Rezervasyonda puan verilmiyor.)

    // Etiketlenen kullanıcılara bildirim gönder
    if (cleanTags.length > 0) {
      try {
        const booker = await prisma.user.findUnique({ where: { id: userId }, select: { fullName: true } })
        const startsAt = new Date(booking.session!.startsAt)
        const date = trDate(startsAt)
        const time = trTime(startsAt)
        const venueName = booking.session!.class.venueId
          ? (await prisma.venue.findUnique({ where: { id: booking.session!.class.venueId }, select: { name: true } }))?.name || ''
          : ''

        const categoryName = booking.session!.class.category || booking.session!.class.title

        for (const username of cleanTags) {
          const taggedUser = await prisma.user.findFirst({
            where: { username: { equals: username, mode: 'insensitive' }, banned: false },
            select: { id: true, email: true, fullName: true, emailReminders: true, pushToken: true, locale: true }
          })
          if (!taggedUser) continue

          // BİLDİRİM BOMBASI KAPISI. Etiketleme, ALICININ İZNİ OLMADAN ona e-posta + push +
          // bildirim gönderebilen tek uçtu: saldırgan taze bir hesapla farklı seanslara
          // rezervasyon yapıp her seferinde 9 kişiyi etiketleyerek seçtiği kurbanın kutusunu
          // doldurabiliyordu. Sayaç ALICI tarafında tutulur (gönderen hesap değiştirse de işler).
          const dun = new Date(Date.now() - 24 * 3600_000)
          const [ayniKisiden, toplam] = await Promise.all([
            prisma.notification.count({ where: { userId: taggedUser.id, type: 'group_invite', relatedUserId: userId, createdAt: { gt: dun } } }),
            prisma.notification.count({ where: { userId: taggedUser.id, type: 'group_invite', createdAt: { gt: dun } } }),
          ])
          // 3/gün aynı kişiden: gerçek arkadaş grubunda bile bir günde bu kadar davet olmaz.
          // 15/gün toplam: çok hesaplı saldırıyı da kapatır, meşru kullanımın çok üstünde.
          if (ayniKisiden >= 3 || toplam >= 15) continue

          const tLoc = (taggedUser.locale || 'tr') as Locale
          const bookerName = booker?.fullName || notifyText(tLoc, 'anonymous_user')

          if (taggedUser.email && taggedUser.emailReminders !== false) {
            // BEKLENMİYOR — bu DÖNGÜ İÇİNDE ve etiketlenen kişi sayısı kadar tekrar ediyor.
            // `await` ile 9 kişilik bir grup rezervasyonu yanıtı 70+ saniye bekletebiliyordu.
            sendGroupTagNotificationEmail(
              taggedUser.email,
              taggedUser.fullName,
              bookerName,
              booking.session!.class.title,
              date,
              time,
              venueName,
              tLoc
            ).catch((e) => console.error('Group tag email:', e))
          }

          const giParams = { name: bookerName, category: categoryName }
          await prisma.notification.create({
            data: {
              userId: taggedUser.id,
              type: 'group_invite',
              ...notifyFields(tLoc, 'group_invite', giParams),
              relatedUserId: userId,
            },
          })

          const giPush = notifyPush(tLoc, 'group_invite', giParams)
          if (taggedUser.pushToken && giPush) {
            sendPushNotification(taggedUser.pushToken, giPush.title, giPush.body).catch(() => {})
          }
        }
      } catch (tagErr) {
        console.error('Tag notification error:', tagErr)
      }
    }

    // (Referral tamamlama check-in'e taşındı — awardAttendanceOnCheckin. Booking anında değil, ilk ücretli ders GERÇEKLEŞİNCE.)

    // getMyBookings ile AYNI politika: komisyon kırılımı (platformun iş modeli verisi)
    // müşteriye dönmez. Bu uç `booking`i ham yayıyordu → aynı alanlar buradan sızıyordu.
    const { commissionAmount: _c1, venueCommission: _c2, userCommission: _c3, venuePayout: _c4, ...bookingSafe } = booking as any
    res.status(201).json({ message: 'Rezervasyon başarıyla oluşturuldu!', booking: bookingSafe, taggedCount: cleanTags.length, pointsEarned: booking.pointsEarned })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

/**
 * TRANSFER İADESİ — TEK HESAP, İKİ ÇAĞIRAN.
 *
 * Transfer SEÇENEKLERİ listesi `(eskiBaz − yeniBaz) × kişi` diye HAM FİYAT FARKINI vaat ediyordu;
 * gerçek transfer ise `ödenen − yeni borç` hesaplıyor ve kuponu yeni baza TİPİYLE uyguluyordu.
 * Yüzde kuponlu bir rezervasyonda ikisi AYRIŞIYORDU: kullanıcı listede "₺100 iade" görüp seçiyor,
 * işlem sonunda ₺50 alıyordu. Para konusunda yanıltmak, kusurdan fazlasıdır.
 *
 * Artık ikisi de burayı çağırıyor; ayrışma imkânsız.
 */
export function transferIadesiHesapla(args: {
  finalAmount: number
  venuePayout: number
  oldBase: number
  newBase: number
  kupon: { discountType: string; discountValue: number } | null
}): { yeniTutar: number; iade: number } {
  const { finalAmount, venuePayout, oldBase, newBase, kupon } = args
  let indirim = 0
  if (kupon) {
    indirim = kupon.discountType === 'percent'
      ? money(newBase * (kupon.discountValue / 100))
      : Math.min(kupon.discountValue, newBase)
  } else if (oldBase > 0 && finalAmount < oldBase) {
    // Kupon satırı silinmiş (nadir) → eski EFEKTİF oranı koru (yüzde-eşdeğeri).
    indirim = money(newBase * (Math.max(0, oldBase - venuePayout) / oldBase))
  }
  const yeniTutar = money(Math.max(0, newBase - indirim))
  return { yeniTutar, iade: money(Math.max(0, finalAmount - yeniTutar)) }
}

// Kullanıcının rezervasyonlarını getir
export const getMyBookings = async (req: Request, res: Response<MyBookingsResponse | ApiError>) => {
  try {
    const userId = (req as any).userId

    const bookings = await prisma.booking.findMany({
      where: { userId },
      include: {
        session: {
          // instructor: puanlama formu hocayı ADIYLA göstersin diye (yalnız id + ad; hocanın
          // e-posta/telefon gibi alanları MÜŞTERİYE dönmemeli). Eskiden yoktu ve web'deki
          // puanlama modalı hoca bölümünü hiç açamıyordu.
          include: { class: { include: { venue: true, instructor: { select: { id: true, fullName: true } } } } },
        },
        dropInSlot: {
          include: { venue: true },
        },
        reviews: true, // salon + hoca ayrı satır (targetType)
      },
      orderBy: { createdAt: 'desc' },
      take: 200, // tüm ömür-boyu booking geçmişi derin include'la tek yanıtta yüklenmesin
    })

    const safeBookings = bookings.map(b => {
      // `...b` Booking'in TÜM kolonlarını yayıyordu: salonun net hak edişi ve komisyon kırılımı
      // (commissionAmount, venueCommission, userCommission, venuePayout) müşteriye dönüyordu — bu
      // platformun iş modeli verisi, müşteriyi ilgilendirmez. checkInCode'u da ayıklıyoruz: müşteri
      // kendi kodunu görür ama yanıtın geri kalanı loglara/istemci state'ine gereksiz taşımasın.
      // `as any` KALDIRILDI: yıkım (destructuring) gerçek tiple de çalışır ve `bSafe` doğru
      // şekilde Omit<...> olur. `any` burada yalnızca sözleşmenin üretici tarafını körleştiriyordu.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { commissionAmount, venueCommission, userCommission, venuePayout, ...bSafe } = b
      return {
      ...bSafe,
      createdAt: b.createdAt.toISOString(),
      session: b.session ? {
        ...b.session,
        class: b.session.class ? {
          ...b.session.class,
          // ÖNCEDEN yalnız passwordHash siliniyordu → IBAN/TCKN/vergi no/İyzico alt-üye anahtarı/KYC
          // müşteriye SIZIYORDU. stripVenueSensitive TÜM ödeme/KYC alanlarını temizler.
          venue: b.session.class.venue ? stripVenueSensitive(b.session.class.venue) : null,
        } : null,
      } : null,
      dropInSlot: b.dropInSlot ? {
        ...b.dropInSlot,
        venue: b.dropInSlot.venue ? stripVenueSensitive(b.dropInSlot.venue) : null,
      } : null,
      // Geriye dönük uyum: eski istemci `review` (tekil, salon yorumu) bekliyor + yeni `reviewed` bayrağı
      review: b.reviews.find((r) => r.targetType === 'venue') || null,
      reviewed: b.reviews.length > 0,
      }
    })

    res.json({ bookings: safeBookings })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// Drop-in'e katıl
export const joinDropIn = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId
    const slotId = parseInt(req.params.slotId as string)
    if (isNaN(slotId)) return res.status(400).json({ error: 'Geçersiz slot.' })

    let participant: any
    try {
      participant = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT id FROM "DropInSlot" WHERE id = ${slotId} FOR UPDATE`

        const slot = await tx.dropInSlot.findUnique({
          where: { id: slotId },
          include: { venue: { select: { isActive: true, isApproved: true } } },
        })
        if (!slot) throw new BookingError('Slot bulunamadı.', 404)
        if (!slot.venue || !slot.venue.isActive || !slot.venue.isApproved) {
          throw new BookingError('Bu salon şu anda rezervasyona kapalı.', 400)
        }
        if (slot.status !== 'open') throw new BookingError('Bu slot artık açık değil.', 400)
        if (new Date(slot.startsAt) <= new Date()) throw new BookingError('Bu slot başlamış, katılım yapılamaz.', 400)
        // ÖZEL slot: yalnız geçerli davet koduyla katılınır. Aksi halde herkes slotId enumerate edip
        // özel maça (privateCode hiç sorulmadan) girebiliyordu — listeleme gizliyor ama join kontrolü yoktu.
        if (slot.visibility === 'private') {
          const code = String(req.body?.privateCode || req.body?.code || '').trim().toUpperCase()
          if (!slot.privateCode || code !== slot.privateCode.toUpperCase()) {
            throw new BookingError('Bu özel maça katılmak için geçerli davet kodu gerekli.', 403)
          }
        }
        if (slot.currentPlayers >= slot.totalPlayers) throw new BookingError('Slot dolu.', 400)

        const existing = await tx.dropInParticipant.findFirst({ where: { slotId, userId } })
        if (existing) throw new BookingError('Zaten katılıyorsunuz.', 400)

        const created = await tx.dropInParticipant.create({
          data: {
            slotId,
            userId,
            status: 'confirmed',
            checkInCode: crypto.randomBytes(6).toString('hex').toUpperCase(),
          }
        })

        await tx.dropInSlot.update({
          where: { id: slotId },
          data: { currentPlayers: { increment: 1 } }
        })

        return created
      })
    } catch (e: any) {
      if (e instanceof BookingError) return res.status(e.status).json({ error: e.message })
      throw e
    }

    return res.status(201).json({ message: "Drop-in'e katıldınız!", participant })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// Rezervasyon iptal et
export const cancelBooking = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId
    const bookingId = parseInt(req.params.id as string)

    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: { session: { select: { startsAt: true } } },
    })

    if (!booking) {
      return res.status(404).json({ error: 'Rezervasyon bulunamadı.' })
    }

    // Başkasının rezervasyonu, OLMAYAN rezervasyonla AYNI 404 döner (403 DEĞİL): artan id'lerle
    // "şu id'de rezervasyon var mı" enumerasyonunu ve platform hacmi ölçümünü kapatır.
    if (booking.userId !== userId) {
      return res.status(404).json({ error: 'Rezervasyon bulunamadı.' })
    }

    if (booking.status === 'cancelled') {
      return res.status(400).json({ error: 'Rezervasyon zaten iptal edilmiş.' })
    }

    // İptal politikası: 12 saat içinde iptal yok, 12-24 saat yarım iade, 24 saat üstü tam iade.
    // MUAFİYET: seansı SALON ertelediyse (booking.rescheduledAt) bu kural uygulanmaz — yeni saat
    // kullanıcının tercihi değil. Ders başlayana kadar TAM İADE ile iptal edebilir.
    const sessionStartsAt = booking.session?.startsAt
    if (sessionStartsAt && !booking.rescheduledAt) {
      const now = new Date()
      const hoursUntilSession = (new Date(sessionStartsAt).getTime() - now.getTime()) / (1000 * 60 * 60)

      if (hoursUntilSession < 12) {
        return res.status(400).json({
          error: 'Derse 12 saatten az kaldığı için iptal yapılamaz.',
          hoursLeft: Math.round(hoursUntilSession * 10) / 10
        })
      }
    }

    // (İade tipi/tutarı artık transaction İÇİNDE, taze satırdan hesaplanıyor — aşağıya bak.)

    // NOT: yukarıdaki `booking` yalnızca ERKEN REDDETME içindir (404/403/zaten-iptal/12-saat).
    // İptal MATEMATİĞİ transaction içindeki TAZE ve KİLİTLİ satırdan türetilir — aşağıya bak.
    const outcome = await prisma.$transaction(async (tx) => {
      // KİLİT SIRASI (tüm kod tabanında aynı olmalı): User → Class_Session → Booking → Coupon.
      // Eskiden burası Booking(CAS) → User → Coupon, purgeBookingsForSessions ise User → Booking
      // sırasıyla kilitliyordu; ters sıra PostgreSQL deadlock'u (40P01) üretiyordu.
      await tx.$executeRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`
      await tx.$executeRaw`SELECT id FROM "Booking" WHERE id = ${bookingId} FOR UPDATE`

      // TAZE OKUMA. Kritik: satır 445'teki okuma transaction DIŞINDA ve kilitsizdi. Araya giren
      // bir transferBooking sessionId/finalAmount/pointsEarned'ı değiştirebiliyor, iptal ise
      // BAYAT değerlerle çalışıp kullanıcının bakiyesinden fazla puan siliyor, yanlış iade tutarı
      // vaat ediyor ve 12-saat kapısını ESKİ seansın saatiyle değerlendiriyordu (politika baypası).
      const fresh = await tx.booking.findUnique({
        where: { id: bookingId },
        include: { session: { select: { startsAt: true } } },
      })
      if (!fresh || fresh.status === 'cancelled') return { kind: 'already' as const }
      if (fresh.userId !== userId) return { kind: 'forbidden' as const }

      // 12-saat kapısı ve iade tutarı TAZE satırdan yeniden hesaplanır.
      const freshHours = fresh.session?.startsAt
        ? (new Date(fresh.session.startsAt).getTime() - Date.now()) / 3600000
        : 999
      // SALON ERTELEDİ → iptal penceresi kuralı uygulanmaz, iade TAM. Kullanıcı bu saati
      // seçmedi; "12 saat kala iptal yok" ve "12-24 saat yarım iade" onun kusuru değil.
      const salonErteledi = !!fresh.rescheduledAt
      if (!salonErteledi && freshHours < 12) return { kind: 'tooLate' as const, hoursLeft: Math.round(freshHours * 10) / 10 }
      // Ders BAŞLADIYSA artık iptal edilemez (ertelenmiş olsa bile) — geçmiş seansa iade yok.
      if (freshHours <= 0) return { kind: 'tooLate' as const, hoursLeft: Math.round(freshHours * 10) / 10 }
      const rType = (salonErteledi || freshHours >= 24) ? 'full' : 'half'
      const rAmount = rType === 'full' ? fresh.finalAmount : money((fresh.finalAmount || 0) / 2)

      // CAS'i transferBooking:783 ile SİMETRİK yap: yalnız status değil, matematiği besleyen
      // alanları da pinle. Araya giren transfer bunları değiştirdiyse count=0 → hiçbir şey yapma.
      const flip = await tx.booking.updateMany({
        where: {
          id: bookingId,
          status: fresh.status,
          sessionId: fresh.sessionId,
          finalAmount: fresh.finalAmount,
          pointsEarned: fresh.pointsEarned,
          checkedIn: false,
        },
        data: {
          status: 'cancelled',
          notes: `${fresh.notes ? fresh.notes + ' | ' : ''}İptal: ${rType === 'full' ? 'Tam iade' : 'Yarım iade'} (₺${rAmount})`,
        },
      })
      if (flip.count === 0) return { kind: 'conflict' as const }
      const booking = fresh // aşağıdaki geri-alma bloklarının tamamı artık TAZE satırı kullanır
      const refundType = rType
      const refundAmount = rAmount

      // Puan geri-alma: puan artık YALNIZ check-in'de kredilenir; iptal ise check-in'den önce olur
      // (12-saat iptal kapısı vs check-in penceresi çakışmaz) → checkedIn=false iken kredilenmiş puan
      // YOKTUR, geri alma da yapılmamalı (aksi halde hiç verilmemiş puanı düşerdi). Yalnız check-in
      // yapılmış (dolayısıyla kredilenmiş) bir booking iptal/temizlenirse geri al.
      if (booking.checkedIn && booking.pointsEarned > 0) {
        // User satırını FOR UPDATE kilitle → aynı kullanıcının EŞZAMANLI iki iptali serileşir; ikincisi
        // ilkinin düşürdüğü GÜNCEL bakiyeyi okur. Kilitsizken ikisi de stale bakiye okuyup min-clamp'i
        // atlar ve rewardPoints NEGATİFE düşerdi.
        await tx.$executeRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`
        const cur = await tx.user.findUnique({ where: { id: userId }, select: { rewardPoints: true, rewardPointsYear: true } })
        // Cross-year: booking önceki puan-yılındaysa puanı reset zaten sildi → tekrar düşme.
        const dec = reversiblePoints(booking.pointsEarned, booking.createdAt, cur?.rewardPointsYear ?? null, cur?.rewardPoints || 0)
        if (dec > 0) {
          await tx.user.update({ where: { id: userId }, data: { rewardPoints: { decrement: dec } } })
          await tx.rewardPoint.create({ data: { userId, points: -dec, source: 'booking_cancelled', bookingId: booking.id } })
        }
      }

      // Kupon kullanımı iptalle geri verilir (aksi halde iptal edilen rezervasyon kuponun
      // maxUses hakkını kalıcı yakar → kupon bir daha kullanılamaz). 0'ın altına inmesin.
      if (booking.couponId) {
        await tx.coupon.updateMany({
          where: { id: booking.couponId, usedCount: { gt: 0 } },
          data: { usedCount: { decrement: 1 } },
        })
      }

      // FARMING ENGELİ (iptal-tarafı): completeReferral ödülü davet edilenin İLK ÜCRETLİ dersinde iki tarafa
      // +100 verir. Bu ders iptal edilip kullanıcının başka (iptal edilmemiş) ücretli booking'i KALMADIYSA ödül
      // artık GMV'ye bağlı değil → iki taraftan da +100 geri alınır ve referral 'pending'e döner (ileride gerçek
      // ücretli derste yeniden hak edilir). Hesap-silmedeki referral_reversed ile simetrik; iptal-tarafı eksikti.
      if ((booking.finalAmount || 0) > 0) {
        const otherPaid = await tx.booking.count({ where: { userId, finalAmount: { gt: 0 }, status: { not: 'cancelled' }, id: { not: bookingId } } })
        if (otherPaid === 0) {
          const ref = await tx.referral.findFirst({ where: { referredId: userId, status: 'completed', referredBonusGranted: true }, select: { id: true, referrerId: true, referredId: true } })
          if (ref) {
            const flip2 = await tx.referral.updateMany({ where: { id: ref.id, status: 'completed' }, data: { status: 'pending', completedAt: null, referredBonusGranted: false } })
            if (flip2.count === 1) {
              const REFERRAL_POINTS = 100 // referralController ile senkron
              for (const uid of [ref.referrerId, ref.referredId]) {
                await tx.$executeRaw`SELECT id FROM "User" WHERE id = ${uid} FOR UPDATE`
                const u = await tx.user.findUnique({ where: { id: uid }, select: { rewardPoints: true } })
                const dec = Math.min(REFERRAL_POINTS, u?.rewardPoints || 0)
                if (dec > 0) {
                  await tx.user.update({ where: { id: uid }, data: { rewardPoints: { decrement: dec } } })
                  await tx.rewardPoint.create({ data: { userId: uid, points: -dec, source: 'referral_reversed_cancel' } })
                }
              }
            }
          }
        }
      }

      return {
        kind: 'ok' as const,
        booking: await tx.booking.findUnique({ where: { id: bookingId } }),
        refundType, refundAmount, sessionId: fresh.sessionId,
      }
    })

    if (outcome.kind === 'already') return res.status(400).json({ error: 'Rezervasyon zaten iptal edilmiş.' })
    if (outcome.kind === 'forbidden') return res.status(404).json({ error: 'Rezervasyon bulunamadı.' })
    if (outcome.kind === 'tooLate') return res.status(400).json({ error: 'Derse 12 saatten az kaldığı için iptal yapılamaz.', hoursLeft: outcome.hoursLeft })
    // Araya giren bir transfer rezervasyonu değiştirdi → istemci tazeleyip tekrar denemeli.
    if (outcome.kind === 'conflict') return res.status(409).json({ error: 'Rezervasyon bu sırada değişti. Sayfayı yenileyip tekrar deneyin.' })
    const updated = outcome.booking
    const refundType = outcome.refundType
    const refundAmount = outcome.refundAmount

    // İptal email bildirimleri
    try {
      const fullBooking = await prisma.booking.findUnique({
        where: { id: bookingId },
        include: {
          user: { select: { fullName: true, email: true, pushToken: true, locale: true } },
          session: { include: { class: { include: { venue: { select: { email: true, name: true } } } } } },
        },
      })

      if (fullBooking) {
        const startsAt = new Date(fullBooking.session!.startsAt)
        const date = trDate(startsAt)
        const time = trTime(startsAt)
        const classTitle = fullBooking.session!.class.title
        const venue = fullBooking.session!.class.venue

        // Kullanıcıya iptal bildirimi (e-posta + push) — kullanıcının diliyle
        const cLoc = (fullBooking.user?.locale || 'tr') as Locale
        if (fullBooking.user?.email) {
          await sendCancellationEmail(fullBooking.user.email, fullBooking.user.fullName, classTitle, date, time, cLoc)
        }
        const cPush = notifyPush(cLoc, 'booking_cancelled_self', {
          classTitle, date, time,
          refund: notifyText(cLoc, refundType === 'full' ? 'refund_full' : 'refund_half'),
        })
        if (fullBooking.user?.pushToken && cPush) {
          sendPushNotification(fullBooking.user.pushToken, cPush.title, cPush.body).catch(() => {})
        }

        // Salona iptal bildirimi
        if (venue?.email) {
          await sendVenueCancellationEmail(venue.email, venue.name, fullBooking.user?.fullName || 'Kullanıcı', classTitle, date, time)
        }
      }
    } catch (emailErr) {
      console.error('Cancellation email error:', emailErr)
    }

    // Waitlist'teki ilk kişiye bildir
    try {
      const { notifyFirstWaitlistUser } = await import('./waitlistController')
      // TAZE sessionId: bayat okumadan gelirse boşalan yer YANLIŞ seansa duyurulur ve gerçek
      // boşluk hiç ilan edilmez.
      await notifyFirstWaitlistUser(outcome.sessionId!)
    } catch (e) {
      console.error('Waitlist notify error:', e)
    }

    // Komisyon kırılımı müşteriye dönmez (getMyBookings ile aynı politika).
    const { commissionAmount: _x1, venueCommission: _x2, userCommission: _x3, venuePayout: _x4, ...updatedSafe } = (updated || {}) as any
    res.json({
      message: `Rezervasyon iptal edildi. ${refundType === 'full' ? 'Tam iade' : 'Yarım iade'} (₺${refundAmount}) uygulandı.`,
      booking: updatedSafe,
      refundType,
      refundAmount,
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// Bir rezervasyon için uygun transfer hedeflerini getir
// Kural: aynı salon, gelecekte, açık, fiyatı aynı veya daha ucuz, kapasitenin %50+'si boş ve grup sığıyor
export const getTransferOptions = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId
    const bookingId = parseInt(req.params.id as string)

    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: { session: { include: { class: true } } },
    })
    if (!booking || booking.userId !== userId) return res.status(404).json({ error: 'Rezervasyon bulunamadı.' })
    if (booking.bookingType !== 'class' || !booking.session) return res.status(400).json({ error: 'Bu rezervasyon transfer edilemez.' })
    if (booking.status !== 'confirmed') return res.status(400).json({ error: 'Sadece aktif rezervasyonlar transfer edilebilir.' })

    const venueId = booking.session.class.venueId
    const groupSize = booking.groupSize
    // ── TEK KAYNAK: DONMUŞ baseAmount ────────────────────────────────────────────────────────
    // Burası eskiden CANLI ders fiyatını (`booking.session.class.basePrice`) kullanıyordu; gerçek
    // transfer ise (aşağıda, transferBooking içinde) rezervasyon anında DONMUŞ `booking.baseAmount`ı.
    // Salon dersin fiyatını sonradan değiştirdiğinde (updateClass'ta buna karşı bir kapı YOK) iki
    // taraf ayrışıyordu: ÖLÇÜLDÜ — aynı rezervasyon için liste "iade 150₺" derken işlem 0₺ ödüyordu;
    // ters yönde de listede çıkan seans işlem kapısında 400 ile reddedilebiliyor.
    // `transferIadesiHesapla` 15 Ağu'da ortaklaştırılmıştı ama ARGÜMANLARI ayrı üretildiği için
    // ayrışma aynı yerden geri döndü — ortak fonksiyon, ortak GİRDİ olmadan yetmiyor.
    const oldBaseToplam = booking.baseAmount                                  // işlem tarafıyla AYNI
    const oldBasePrice = groupSize > 0 ? oldBaseToplam / groupSize : oldBaseToplam  // birim fiyata indir
    // Kuponu BURADA da oku: iade vaadi gerçek transferle AYNI hesaptan çıkmalı (bkz.
    // transferIadesiHesapla). Eskiden liste ham fiyat farkını vaat ediyor, işlem kuponu
    // hesaba katıyordu ve yüzde kuponlu kullanıcı vaat edilenin YARISINI alıyordu.
    const transferKuponu = booking.couponId
      ? await prisma.coupon.findUnique({ where: { id: booking.couponId }, select: { discountType: true, discountValue: true } })
      : null

    // Aynı salonun gelecekteki açık seansları (aynı/daha ucuz fiyat)
    const sessions = await prisma.class_Session.findMany({
      where: {
        status: 'open',
        startsAt: { gt: new Date() },
        id: { not: booking.sessionId! },
        class: { venueId, isActive: true, basePrice: { lte: oldBasePrice } },
      },
      include: { class: { select: { title: true, basePrice: true, capacity: true } } },
      orderBy: { startsAt: 'asc' },
      take: 100, // seans başına 2 sorgu döngüsü var → aday seans sayısını sınırla (N+1 patlamasını kes)
    })

    // Her seans için doluluk hesapla (groupSize toplamı) ve %50 + grup sığma filtresini uygula
    const options = []
    for (const s of sessions) {
      const occ = await prisma.booking.aggregate({
        where: { sessionId: s.id, status: { in: ['confirmed', 'pending'] } },
        _sum: { groupSize: true },
      })
      const occupied = occ._sum.groupSize || 0
      const capacity = s.capacity || 0
      const available = capacity - occupied
      const alreadyIn = await prisma.booking.findFirst({
        where: { sessionId: s.id, userId, status: { in: ['confirmed', 'pending'] } },
      })
      if (alreadyIn) continue
      if (capacity > 0 && available >= Math.ceil(capacity * 0.5) && available >= groupSize) {
        options.push({
          sessionId: s.id,
          title: s.class.title,
          basePrice: s.class.basePrice,
          startsAt: s.startsAt,
          endsAt: s.endsAt,
          available,
          capacity,
          priceRefund: transferIadesiHesapla({
            finalAmount: booking.finalAmount,
            venuePayout: booking.venuePayout,
            oldBase: oldBaseToplam,
            // newBase de işlem tarafındaki gibi money() ile yuvarlanır (:936 ile simetrik)
            newBase: money(s.class.basePrice * groupSize),
            kupon: transferKuponu,
          }).iade,
        })
      }
    }

    return res.json({ options })
  } catch (err) {
    console.error('getTransferOptions error:', err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// Rezervasyonu başka bir seansa transfer et (aynı salon, aynı/ucuz, %50+ boş)
// CHECK-IN'DE ATTENDANCE PUANI: puan ve referral odulu artik REZERVASYONDA degil, kullanici
// derse GERCEKTEN gidince (check-in) verilir. Boylece tier/streak/liderligin "yalniz checkedIn"
// kurali ile tutarli olur ve no-show ile puan/referral farming'i kapanir. pointsEarned booking
// aninda hesaplanip saklanir (oran o an kilitlenir), kredilenme check-in'de olur.
// Idempotent: 'attendance' defter satiri varsa tekrar kredilemez (CAS kazanani cagirir ama cift-guard).
export async function awardAttendanceOnCheckin(bookingId: number) {
  try {
    const b = await prisma.booking.findUnique({
      where: { id: bookingId },
      select: { id: true, userId: true, finalAmount: true, session: { select: { class: { select: { title: true } } } } },
    })
    if (!b) return
    const finalAmount = b.finalAmount || 0
    if (finalAmount > 0) {
      await resetYearlyPointsIfNeeded(b.userId).catch(() => {})
      // PUAN, rezervasyonda DONDURULMUŞ oranla değil, katılım (check-in) anındaki GÜNCEL tier oranıyla
      // hesaplanır: kullanıcı rezervasyondan bu yana tier atlamış olabilir (ör. Aday→Sporcu) → adil olan,
      // gerçekten gittiği anda geçerli oran. Kredilenen tutar booking.pointsEarned'a da YAZILIR (0 olsa
      // bile) → iptal-geri-alma (cancelBooking, checkedIn && pointsEarned>0) tam olarak verilen kadarını
      // geri alır; aksi halde rezervasyon-anı tahmini ile gerçek kredi ayrışıp hayalet puan/defter sapması olurdu.
      const credited = await prisma.$transaction(async (tx) => {
        const exists = await tx.rewardPoint.findFirst({ where: { bookingId: b.id, source: 'attendance' }, select: { id: true } })
        if (exists) return 0 // zaten kredilendi (idempotent) — pointsEarned önceki turda doğru yazıldı, dokunma
        const u = await tx.user.findUnique({ where: { id: b.userId }, select: { tier: { select: { pointRate: true } } } })
        const rate = u?.tier?.pointRate || 0
        const pts = Math.round(finalAmount * (rate / 100))
        // Kilit sırası (User→Booking): önce User FOR UPDATE + kredi, en son Booking güncellemesi.
        if (pts > 0) {
          await tx.$executeRaw`SELECT id FROM "User" WHERE id = ${b.userId} FOR UPDATE`
          await tx.user.update({ where: { id: b.userId }, data: { rewardPoints: { increment: pts } } })
          await tx.rewardPoint.create({ data: { userId: b.userId, points: pts, source: 'attendance', bookingId: b.id } })
        }
        await tx.booking.update({ where: { id: b.id }, data: { pointsEarned: pts } })
        return pts
      })
      if (credited > 0) {
        const u = await prisma.user.findUnique({ where: { id: b.userId }, select: { email: true, fullName: true, rewardPoints: true, pushToken: true, emailReminders: true, locale: true } })
        const pLoc = (u?.locale || 'tr') as Locale
        const title = b.session?.class?.title || notifyText(pLoc, 'class_fallback')
        if (u?.email && u.emailReminders !== false) sendCashbackEmail(u.email, u.fullName, credited, title, u.rewardPoints, pLoc).catch(() => {})
        const pPush = notifyPush(pLoc, 'points_earned', { classTitle: title, points: credited })
        if (u?.pushToken && pPush) sendPushNotification(u.pushToken, pPush.title, pPush.body).catch(() => {})
      }
    }
    // Referral: davet edilenin ilk UCRETLI dersi GERCEKLESINCE (check-in) tamamlanir (booking aninda DEGIL).
    if (finalAmount > 0) completeReferral(b.userId).catch(() => {})
  } catch (e) {
    console.error('awardAttendanceOnCheckin error:', e)
  }
}

export const transferBooking = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId
    const bookingId = parseInt(req.params.id as string)
    const { targetSessionId } = req.body
    if (!targetSessionId) return res.status(400).json({ error: 'Hedef seans gerekli.' })

    // Transfer de puan YAZAN bir yol (pahalıya geçişte pointsDelta>0). createBooking'deki gibi yıl
    // damgasını önce tazele; aksi halde yeni yılda eklenen puan bir sonraki getMe'de eski bakiyeyle
    // birlikte sıfırlanır ama RewardPoint defter satırı kalır (bakiye/defter çelişkisi).
    await resetYearlyPointsIfNeeded(userId)

    let result: any
    try {
      result = await prisma.$transaction(async (tx) => {
        const booking = await tx.booking.findUnique({
          where: { id: bookingId },
          include: { session: { include: { class: true } } },
        })
        if (!booking || booking.userId !== userId) throw new BookingError('Rezervasyon bulunamadı.', 404)
        if (booking.bookingType !== 'class' || !booking.session) throw new BookingError('Bu rezervasyon transfer edilemez.', 400)
        if (booking.status !== 'confirmed') throw new BookingError('Sadece aktif rezervasyonlar transfer edilebilir.', 400)
        if (booking.checkedIn) throw new BookingError('Check-in yapılmış rezervasyon transfer edilemez.', 400)
        if (booking.sessionId === targetSessionId) throw new BookingError('Zaten bu seanstasınız.', 400)
        if (new Date(booking.session.startsAt) <= new Date()) throw new BookingError('Başlamış ders transfer edilemez.', 400)

        // İki seansı da kilitle (deadlock önlemek için id sırasına göre)
        const ids = [booking.sessionId!, targetSessionId].sort((a, b) => a - b)
        await tx.$executeRaw`SELECT id FROM "Class_Session" WHERE id IN (${ids[0]}, ${ids[1]}) ORDER BY id FOR UPDATE`

        const target = await tx.class_Session.findUnique({
          where: { id: targetSessionId },
          include: { class: true },
        })
        if (!target) throw new BookingError('Hedef seans bulunamadı.', 404)
        if (target.status !== 'open') throw new BookingError('Hedef seans açık değil.', 400)
        if (new Date(target.startsAt) <= new Date()) throw new BookingError('Geçmiş bir seansa transfer yapılamaz.', 400)
        // DURUM KAPILARI: createBooking:82,87 hedef ders/salon için bunları kontrol ediyor, transfer
        // ETMİYORDU → kullanıcı, salonun kapattığı (isActive=false) bir derse ya da askıya alınmış/
        // onayı geri alınmış salonun seansına transfer olabiliyordu. Aynı kapılar burada da olmalı.
        if (!target.class.isActive) throw new BookingError('Hedef ders şu anda rezervasyona kapalı.', 400)
        const tVenue = await tx.venue.findUnique({ where: { id: target.class.venueId }, select: { isActive: true, isApproved: true } })
        if (!tVenue || !tVenue.isActive || !tVenue.isApproved) throw new BookingError('Hedef salon şu anda aktif değil.', 400)

        // Aynı salon kontrolü
        if (target.class.venueId !== booking.session.class.venueId) {
          throw new BookingError('Sadece aynı salon içinde transfer yapılabilir.', 400)
        }

        const groupSize = booking.groupSize
        const oldBase = booking.baseAmount // DB'de money() ile yuvarlanmış
        const newBase = money(target.class.basePrice * groupSize)

        // Aynı veya daha ucuz olmalı. KRİTİK: oldBase yuvarlı (kayıtlı baseAmount) ama newBase eskiden
        // HAM float'tı → 8.33*3=24.990000000000002 > 24.99 TRUE olup AYNI fiyatlı transferi reddediyordu
        // (getTransferOptions o seansı geçerli/0-iade listeler → liste ile transfer çelişiyordu). İki
        // tarafı da money() ile yuvarlayınca 24.99 > 24.99 = false, doğru geçer.
        if (newBase > oldBase) {
          throw new BookingError('Sadece aynı veya daha uygun fiyatlı derslere transfer yapabilirsiniz.', 400)
        }

        // Zaten hedefte kayıtlı mı?
        const alreadyIn = await tx.booking.findFirst({
          where: { sessionId: targetSessionId, userId, status: { in: ['confirmed', 'pending'] } },
        })
        if (alreadyIn) throw new BookingError('Bu seansta zaten rezervasyonunuz var.', 400)

        // Hedef kapasite: %50+ boş ve grup sığmalı
        const occ = await tx.booking.aggregate({
          where: { sessionId: targetSessionId, status: { in: ['confirmed', 'pending'] } },
          _sum: { groupSize: true },
        })
        const occupied = occ._sum.groupSize || 0
        const capacity = target.capacity || 0
        const available = capacity - occupied
        if (capacity <= 0 || available < Math.ceil(capacity * 0.5)) {
          throw new BookingError('Hedef dersin en az yarısı dolu, transfer yapılamıyor.', 400)
        }
        if (available < groupSize) {
          throw new BookingError('Hedef derste yeterli yer yok.', 400)
        }

        // Finansal yeniden hesap — kuponu TİPİYLE yeni baza uygula. ESKİ kod indirimi MUTLAK
        // (oldBase − venuePayout) alıp küçük yeni baza uyguluyordu → YÜZDE kuponu dev mutlak indirime donup
        // salonu eksik ödüyor, kullanıcıyı fazla iade ediyordu (üst üste transferde bedava derse kadar).
        // TEK HESAP: seçenek listesiyle BİREBİR aynı fonksiyon (transferIadesiHesapla).
        // İade = ÖDENEN (finalAmount) − yeni borç; baz farkı DEĞİL, yoksa kupon (özellikle
        // yüzde) kullanan kullanıcıya fazla iade çıkardı. (ödeme entegrasyonunda karta iade)
        const bc = booking.couponId
          ? await tx.coupon.findUnique({ where: { id: booking.couponId }, select: { discountType: true, discountValue: true } })
          : null
        const { yeniTutar: newFinalAmount, iade: priceRefund } = transferIadesiHesapla({
          finalAmount: booking.finalAmount,
          venuePayout: booking.venuePayout,
          oldBase,
          newBase,
          kupon: bc,
        })
        const newVenuePayout = newFinalAmount

        // pointsEarned = TAHMİN, bakiye DEĞİL. Puan yalnızca check-in'de kredilenir
        // (awardAttendanceOnCheckin; createBooking satır ~186 bunu açıkça söylüyor) ve orada
        // GÜNCEL tier oranıyla yeniden hesaplanıp pointsEarned'a tekrar yazılır. Transfer ise
        // yalnızca check-in YAPILMAMIŞ rezervasyonda mümkün (aşağıdaki CAS: checkedIn: false)
        // → bu rezervasyonun puanı bakiyede henüz YOKTUR. Bu yüzden burada yalnız tahmini
        // tazeliyoruz; bakiyeye DOKUNMUYORUZ.
        const uTier = await tx.user.findUnique({ where: { id: userId }, select: { tier: { select: { pointRate: true } } } })
        const newPoints = newFinalAmount > 0 ? Math.round(newFinalAmount * ((uTier?.tier?.pointRate || 0) / 100)) : 0

        // CAS: yalnızca booking HÂLÂ beklenen durumdaysa (confirmed, kaynak seansta, check-in yok)
        // taşı. booking kilitten önce okundu; eşzamanlı iptal/transfer bu arada durumu değiştirdiyse
        // (count=0) stale veriyle çift işlem yapmadan çakışma döndür (ödeme gelince priceRefund
        // gerçek iadeye dönüşünce çift-iade de böyle önlenir).
        const flip = await tx.booking.updateMany({
          where: { id: bookingId, status: 'confirmed', sessionId: booking.sessionId, checkedIn: false },
          data: {
            sessionId: targetSessionId,
            baseAmount: money(newBase),
            venuePayout: newVenuePayout,
            finalAmount: newFinalAmount,
            // İndirim = yeni baz − yeni tutar (transferIadesiHesapla'nın uyguladığı indirim).
            discountAmount: money(Math.max(0, newBase - newFinalAmount)),
            pointsEarned: newPoints,
            // Hatırlatma bayrağı SIFIRLANIR: eski seans için hatırlatma gönderilmişse
            // reminderSent=true kalıyordu ve reminderJob yalnız false olanları taradığı için
            // YENİ seans için hatırlatma HİÇ gitmiyordu (kullanıcı transfer ettiği dersi kaçırır).
            reminderSent: false,
            // Salon-erteleme damgası TRANSFERDE SİLİNİR: kullanıcı yeni seansı KENDİ seçti,
            // dolayısıyla ertelemeden doğan "pencere kuralından muaf tam iade" hakkı tükenir.
            // (Silinmezse kullanıcı bir kez ertelenen dersi istediği seansa taşıyıp süresiz
            // tam-iade hakkı taşırdı.)
            rescheduledAt: null,
            notes: `${booking.notes ? booking.notes + ' | ' : ''}Transfer edildi${priceRefund > 0 ? ` (₺${priceRefund} iade)` : ''}`,
          },
        })
        if (flip.count === 0) throw new BookingError('Rezervasyon durumu değişti, transfer yapılamadı. Lütfen tekrar deneyin.', 409)

        // BAKİYEYE DOKUNULMAZ — burada eskiden `pointsDelta` bakiyeye yansıtılıyordu ve bu,
        // puan kredilendirmesi rezervasyondan CHECK-IN'e taşındığında geride kalmış bir artıktı:
        //  • Ucuza transfer (delta < 0): hiç kredilenmemiş puan GERÇEK bakiyeden düşülüyordu.
        //    Örn. bakiye 100, ₺600 seansı ₺200'e transfer → 100'den 80'e iniyordu; kullanıcı
        //    başka derslerden kazandığı puanı kaybediyordu (defterde -20 'booking_transfer').
        //  • Arada tier yükseldiyse (delta > 0): derse hiç gidilmeden bakiyeye puan EKLENİYOR,
        //    sonra check-in'de aynı ders için ikinci kez puan veriliyordu.
        // Doğru davranış: yalnız tahmini (pointsEarned) tazele; gerçek kredi check-in'de,
        // güncel tier oranıyla ve idempotent olarak verilsin.
        const updated = await tx.booking.findUnique({
          where: { id: bookingId },
          include: { session: { include: { class: true } } },
        })

        return { updated, priceRefund, oldSessionId: booking.sessionId }
      })
    } catch (e: any) {
      if (e instanceof BookingError) return res.status(e.status).json({ error: e.message })
      throw e
    }

    // Bilgilendirme (e-posta + push) (yeni ders + varsa fiyat farkı iadesi)
    try {
      const u = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, fullName: true, pushToken: true, locale: true } })
      const sess = result.updated.session
      if (sess) {
        const startsAt = new Date(sess.startsAt)
        const date = trDate(startsAt)
        const time = trTime(startsAt)
        const tLoc = (u?.locale || 'tr') as Locale
        if (u?.email) await sendTransferEmail(u.email, u.fullName, sess.class.title, date, time, result.priceRefund, tLoc)
        const refundTxt = result.priceRefund > 0 ? notifyText(tLoc, 'refund_note', { refund: result.priceRefund }) : ''
        const tPush = notifyPush(tLoc, 'booking_transferred', { classTitle: sess.class.title, date, time, refund: refundTxt })
        if (u?.pushToken && tPush) {
          sendPushNotification(u.pushToken, tPush.title, tPush.body).catch(() => {})
        }
      }
    } catch (mailErr) {
      console.error('Transfer notify error:', mailErr)
    }

    // Transfer ESKİ seansta bir yer açar; cancelBooking'de olan waitlist bildirimi burada YOKTU →
    // eski seansı bekleyen kişi hiç haber almıyordu. Serbest kalan yeri sıradakine duyur.
    try {
      const { notifyFirstWaitlistUser } = await import('./waitlistController')
      if (result.oldSessionId) await notifyFirstWaitlistUser(result.oldSessionId)
    } catch (e) {
      console.error('Transfer waitlist notify error:', e)
    }

    // Komisyon kırılımı müşteriye dönmez (getMyBookings/createBooking ile aynı politika).
    const { commissionAmount: _t1, venueCommission: _t2, userCommission: _t3, venuePayout: _t4, ...updatedSafe } = (result.updated || {}) as any
    return res.json({
      message: result.priceRefund > 0
        ? `Rezervasyon transfer edildi. ₺${result.priceRefund} fiyat farkı kredinize iade edildi.`
        : 'Rezervasyon başarıyla transfer edildi.',
      booking: updatedSafe,
      priceRefund: result.priceRefund,
    })
  } catch (err) {
    console.error('transferBooking error:', err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// Drop-in check-in
export const checkInDropIn = async (req: Request, res: Response) => {
  try {
    const venueId = (req as any).venueId
    const { code } = req.body

    if (!code?.trim()) {
      return res.status(400).json({ error: 'Check-in kodu gerekli.' })
    }

    const participant = await prisma.dropInParticipant.findFirst({
      where: { checkInCode: code.trim().toUpperCase() },
      include: {
        user: { select: { fullName: true, username: true, avatarUrl: true } },
        slot: { select: { title: true, venueId: true, startsAt: true, endsAt: true } }
      }
    })

    if (!participant) {
      return res.status(404).json({ error: 'Geçersiz kod. Katılım bulunamadı.' })
    }

    if (participant.slot?.venueId !== venueId) {
      // 403 DEĞİL 404: sahip-olunmayan kod, bulunamayan kodla aynı yanıtı vermeli (existence-oracle
      // kapalı; checkInBooking/checkInInstructorBooking ile simetrik).
      return res.status(404).json({ error: 'Geçersiz kod. Katılım bulunamadı.' })
    }

    // ZAMAN PENCERESİ: checkInBooking (satır ~941) ve checkInInstructorBooking bu kapıyı uygularken
    // drop-in'de HİÇ yoktu — kod geçmişte ya da haftalar sonrasında istenildiği an okutulabiliyordu.
    // Salon, gelecekteki katılımları toplu check-in'leyip katılımcıların serisini/rozetini şişirebilir,
    // kullanıcı da gelmediği bir etkinliği sonradan "gitmiş" gösterebilirdi.
    const dSt = participant.slot?.startsAt ? new Date(participant.slot.startsAt).getTime() : null
    const dEn = participant.slot?.endsAt ? new Date(participant.slot.endsAt).getTime() : null
    const dNow = Date.now()
    if (dSt != null && dNow < dSt - 60 * 60000) return res.status(400).json({ error: 'Check-in etkinlik saatine yakın açılır (henüz erken).' })
    if (dEn != null && dNow > dEn + 180 * 60000) return res.status(400).json({ error: 'Check-in süresi doldu.' })

    if (participant.status !== 'confirmed') {
      return res.status(400).json({ error: 'Katılım onaylı değil.' })
    }

    if (participant.checkedIn) {
      return res.json({
        alreadyCheckedIn: true,
        message: 'Bu katılımcı zaten check-in yapmış.',
        participant: { user: participant.user, slotTitle: participant.slot?.title, checkedInAt: participant.checkedInAt }
      })
    }

    // ATOMİK SAHİPLENME (CAS): checkInBooking ve checkInInstructorBooking bu deseni kullanıyor,
    // burada unutulmuştu. Oku-sonra-yaz olduğu için aynı kod iki kez okutulduğunda İKİ istek de
    // yukarıdaki `participant.checkedIn` kontrolünü geçip ikisine de "Check-in başarılı!" dönüyordu
    // (salon aynı kişiyi iki kez içeri almış sayıyor). count=0 → yarışı kaybettik, zaten yapılmış.
    const claim = await prisma.dropInParticipant.updateMany({
      where: { id: participant.id, checkedIn: false },
      data: { checkedIn: true, checkedInAt: new Date() }
    })
    if (claim.count === 0) {
      const now = await prisma.dropInParticipant.findUnique({ where: { id: participant.id }, select: { checkedInAt: true } })
      return res.json({
        alreadyCheckedIn: true,
        message: 'Bu katılımcı zaten check-in yapmış.',
        participant: { user: participant.user, slotTitle: participant.slot?.title, checkedInAt: now?.checkedInAt }
      })
    }

    return res.json({
      success: true,
      message: 'Check-in başarılı!',
      participant: { user: participant.user, slotTitle: participant.slot?.title, checkedInAt: new Date() }
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// Salon check-in: kodu doğrula ve check-in yap
export const checkInBooking = async (req: Request, res: Response) => {
  try {
    const venueId = (req as any).venueId
    const { code } = req.body

    if (!code?.trim()) {
      return res.status(400).json({ error: 'Check-in kodu gerekli.' })
    }

    const booking = await prisma.booking.findFirst({
      where: { checkInCode: code.trim().toUpperCase() },
      include: {
        user: { select: { fullName: true, username: true, avatarUrl: true } },
        session: { include: { class: { select: { title: true, venueId: true } } } }
      }
    })

    if (!booking) {
      return res.status(404).json({ error: 'Geçersiz kod. Rezervasyon bulunamadı.' })
    }

    // Bu salona ait mi? Sahip-olunmayan kod, BULUNAMAYAN kodla AYNI 404 döner (403 DEĞİL) →
    // "bu kod platformda var mı?" existence-oracle'ı kapatılır. checkInInstructorBooking:201 zaten
    // bu deseni kullanıyor; salon tarafı 403 dönüp kodun varlığını ele veriyordu.
    if (booking.session?.class?.venueId !== venueId) {
      return res.status(404).json({ error: 'Geçersiz kod. Rezervasyon bulunamadı.' })
    }

    if (booking.status !== 'confirmed') {
      return res.status(400).json({ error: 'Rezervasyon onaylı değil.' })
    }

    // ZAMAN PENCERESİ: check-in yalnız ders saati civarında (başlangıç−1sa .. bitiş+3sa). Gelecekteki
    // dersi bugünden check-in'leyip streak/rozet şişirme engellenir; çok geç geriye-dönük check-in de kapalı.
    const st = booking.session?.startsAt ? new Date(booking.session.startsAt).getTime() : null
    const en = booking.session?.endsAt ? new Date(booking.session.endsAt).getTime() : null
    const nowMs = Date.now()
    if (st != null && nowMs < st - 60 * 60000) return res.status(400).json({ error: 'Check-in ders saatine yakın açılır (henüz erken).' })
    if (en != null && nowMs > en + 180 * 60000) return res.status(400).json({ error: 'Check-in süresi doldu.' })

    const already = {
      user: booking.user,
      classTitle: booking.session?.class?.title,
      checkedInAt: booking.checkedInAt,
      groupSize: booking.groupSize,
    }
    if (booking.checkedIn) {
      return res.json({ alreadyCheckedIn: true, message: 'Bu rezervasyon zaten check-in yapılmış.', booking: already })
    }

    // ATOMİK: checkedIn=false→true çevirebilen TEK istek başarılı; eşzamanlı çift-okutma "zaten check-in" alır.
    const claim = await prisma.booking.updateMany({ where: { id: booking.id, checkedIn: false }, data: { checkedIn: true, checkedInAt: new Date() } })
    if (claim.count === 0) {
      return res.json({ alreadyCheckedIn: true, message: 'Bu rezervasyon zaten check-in yapılmış.', booking: already })
    }

    // Attendance puani + referral: derse GERCEKTEN gidildi (check-in) → şimdi kredile (best-effort).
    awardAttendanceOnCheckin(booking.id).catch(() => {})

    return res.json({
      success: true,
      message: 'Check-in başarılı!',
      booking: {
        user: booking.user,
        classTitle: booking.session?.class?.title,
        groupSize: booking.groupSize,
        checkedInAt: new Date(),
      }
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}
