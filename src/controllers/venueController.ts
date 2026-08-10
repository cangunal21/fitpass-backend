import { Request, Response } from 'express'
import bcrypt from 'bcryptjs'
const VENUE_DUMMY_HASH = bcrypt.hashSync('sipsakspor-venue-timing-guard', 12) // login enumeration timing oracle guard
import prisma from '../utils/prisma'
import { translateClassTitle } from '../utils/translate'
import { generateToken } from '../utils/jwt'
import { sendCancellationEmail, sendVenuePasswordResetEmail, sendVenueRegistrationAdminEmail } from '../utils/email'
import { sendPushNotification } from '../utils/push'
import { isValidEmail, MIN_PASSWORD, parseIntSafe, clampStr } from '../utils/validate'
import crypto from 'crypto'
import { trAddDays, trDate, trInstant, trTime, trWeekday, trYmd } from '../utils/trFormat'
import { reversiblePoints } from '../utils/tier'
import { cityIdOfNeighborhood } from '../utils/geo'
import { notifyFields, notifyPush } from '../utils/notifyText'
import { Locale } from '../utils/locale'
const money = (x: number) => Math.round(x * 100) / 100 // bookingController ile aynı 2-ondalık yuvarlama

// Bir seans/ders silinirken aktif rezervasyonları GÜVENLİ kaldırır:
// puanları iade eder, FK'lı alt kayıtları temizler (Payment/Review/Commission/ActivityLog),
// rezervasyonları siler. Etkilenen kullanıcıları (bildirim için) döndürür.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function purgeBookingsForSessions(tx: any, sessionIds: number[]) {
  // Bekleme listesi kayıtları seansa GERÇEK FK ile bağlı → seans silinmeden önce temizlenmeli
  // (rezervasyon olmasa bile bekleme listesi olabilir; erken return'dan ÖNCE silinir)
  if (sessionIds.length) await tx.waitlist.deleteMany({ where: { sessionId: { in: sessionIds } } })
  // KİLİT SIRASI: User → Booking (cancelBooking ile AYNI sıra). Eskiden burada Booking'e hiç
  // kilit alınmıyordu ve User döngü içinde kilitleniyordu; cancelBooking ise Booking→User
  // sırasındaydı → ters sıra PostgreSQL deadlock'u (40P01) üretiyordu. Kurban bu taraf olursa
  // seans silinmiyor ve o seanstaki HERKESİN puan iadesi hiç yazılmıyordu.
  const preview = await tx.booking.findMany({ where: { sessionId: { in: sessionIds } }, select: { userId: true } })
  if (preview.length === 0) return []
  for (const uid of [...new Set(preview.map((b: any) => b.userId))].sort((a: any, b: any) => a - b)) {
    await tx.$executeRaw`SELECT id FROM "User" WHERE id = ${uid} FOR UPDATE`
  }
  await tx.$executeRaw`SELECT id FROM "Booking" WHERE "sessionId" = ANY(${sessionIds}::int[]) FOR UPDATE`

  // Kilitler alındıktan SONRA taze oku. Kilitsiz okuma, eşzamanlı bir cancelBooking ile aynı
  // rezervasyonun puanını İKİ KEZ geri aldırıyordu (iptal -100 yazar, burası bayat snapshot'ta
  // hâlâ 'confirmed'/pointsEarned=100 gördüğü için bir -100 daha yazardı → bakiyeden 200 düşer,
  // defterde aynı bookingId için iki ters kayıt kalırdı).
  const bookings = await tx.booking.findMany({
    where: { sessionId: { in: sessionIds } },
    select: { id: true, userId: true, pointsEarned: true, status: true, createdAt: true, checkedIn: true },
  })
  if (bookings.length === 0) return []
  const ids = bookings.map((b: any) => b.id)
  for (const b of bookings) {
    if (b.checkedIn && b.pointsEarned > 0 && (b.status === 'confirmed' || b.status === 'pending')) { // puan yalniz check-in'de kredilenir → yalniz kredilenmis (checkedIn) booking'i geri al
      // CLAMP: bakiyeyi NEGATİFE düşürme (yıllık reset/redemption sonrası pointsEarned > güncel bakiye olabilir).
      // cancelBooking/transferBooking ile aynı invariant — Math.min. (User kilidi yukarıda,
      // döngüden ÖNCE ve id sırasıyla alındı: hem deadlock sırası sabit hem tx daha kısa.)
      const cur = await tx.user.findUnique({ where: { id: b.userId }, select: { rewardPoints: true, rewardPointsYear: true } })
      // Cross-year: booking önceki puan-yılındaysa reset zaten sildi → tekrar düşme (cancelBooking ile aynı).
      const dec = reversiblePoints(b.pointsEarned, b.createdAt, cur?.rewardPointsYear ?? null, cur?.rewardPoints || 0)
      if (dec > 0) {
        await tx.user.update({ where: { id: b.userId }, data: { rewardPoints: { decrement: dec } } })
        await tx.rewardPoint.create({ data: { userId: b.userId, points: -dec, source: 'session_removed', bookingId: b.id } })
      }
    }
  }
  // FK kısıtlı alt kayıtlar (onDelete tanımsız = Restrict) → önce sil
  await tx.payment.deleteMany({ where: { bookingId: { in: ids } } })
  // YORUM SİLİNMEZ, AYRIŞTIRILIR: bookingId=null'a çekilir → seans/rezervasyon silinse de yorum
  // kalıcı kalır (salon, kötü yorumu seansı silerek temizleyemesin). venueId/instructorId ve puan
  // korunur; recomputeVenueRating sonrası ortalama aynı kalır. booking silinmeden ÖNCE ayrıştırılır
  // ki Review→Booking FK ihlali olmasın.
  await tx.review.updateMany({ where: { bookingId: { in: ids } }, data: { bookingId: null } })
  await tx.commissionHistory.deleteMany({ where: { bookingId: { in: ids } } })
  await tx.activityLog.deleteMany({ where: { bookingId: { in: ids } } })
  await tx.booking.deleteMany({ where: { id: { in: ids } } })
  return bookings as { id: number; userId: number; status: string }[]
}

// Salonun avgRating/totalReviews'ını kalan yorumlardan yeniden hesaplar.
// Ders/seans silmede yorumlar da silindiği için puan hayalet kalmasın diye çağrılır.
async function recomputeVenueRating(tx: any, venueId: number) {
  // Venue satırını FOR UPDATE ile kilitle — createReview de aynı kilidi alır. Böylece silme yolundaki
  // recompute ile eşzamanlı bir puanlama SERİLEŞİR; ikisi kilitsiz çalışırsa lost-update ile
  // avgRating/totalReviews sapabilirdi.
  await tx.$executeRaw`SELECT id FROM "Venue" WHERE id = ${venueId} FOR UPDATE`
  const reviews = await tx.review.findMany({ where: { venueId }, select: { rating: true } })
  const avg = reviews.length ? reviews.reduce((s: number, r: any) => s + r.rating, 0) / reviews.length : 0
  await tx.venue.update({ where: { id: venueId }, data: { avgRating: Math.round(avg * 10) / 10, totalReviews: reviews.length } })
}

// Etkilenen kullanıcılara "rezervasyonun salon tarafından kaldırıldı" push'u (best-effort)
async function notifyRemovedBookings(affected: { userId: number; status: string }[], classTitle: string) {
  const userIds = [...new Set(affected.filter(b => b.status === 'confirmed' || b.status === 'pending').map(b => b.userId))]
  if (userIds.length === 0) return
  const params = { classTitle }
  // ÜÇ KANAL. Eskiden YALNIZCA pushToken!=null olanlara push atılıyordu → web kullanıcısı (token yok)
  // ya da push izni vermeyen mobil kullanıcı iptalden HİÇ haberdar olmuyordu (booking hard-delete
  // edildiği için geriye taranacak kayıt da kalmıyordu). Artık admin deleteVenue deseniyle aynı:
  // herkese in-app Notification + e-posta, pushToken varsa ek push. Her kanal ALICININ diliyle.
  const users = await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true, fullName: true, pushToken: true, emailReminders: true, locale: true } })
  for (const u of users) {
    const loc = (u.locale || 'tr') as Locale
    await prisma.notification.create({ data: { userId: u.id, type: 'booking_cancelled', ...notifyFields(loc, 'booking_cancelled_class_removed', params) } }).catch(() => {})
    const push = notifyPush(loc, 'booking_cancelled_class_removed', params)
    if (u.pushToken && push) sendPushNotification(u.pushToken, push.title, push.body).catch(() => {})
    // İptal/iade işlemsel bir bildirimdir (opt-out'a tabi değil) — kullanıcı parasının iade
    // edileceğini bilmeli. E-posta yalnız adresi olana.
    if (u.email) sendCancellationEmail(u.email, u.fullName || '', classTitle, '', '', loc).catch(() => {})
  }
}

// SALON KAYIT
export const venueRegister = async (req: Request, res: Response) => {
  try {
    const { name, email, password, phone, address, description, neighborhoodId, sportCategories, instructor } = req.body // cityId BİLEREK alınmıyor — mahalleden türetiliyor

    if (!name || !email || !password || !phone || !address) {
      return res.status(400).json({ error: 'Ad, email, şifre, telefon ve adres zorunludur.' })
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Geçerli bir e-posta adresi girin.' })
    }

    if (password.length < MIN_PASSWORD) {
      return res.status(400).json({ error: `Şifre en az ${MIN_PASSWORD} karakter olmalı.` })
    }

    // E-postayi normalize et: Venue.email byte-exact @unique. Normalize edilmezse (a) 'Salon@X.com' ile
    // kayit olan salon 'salon@x.com' ile GIREMEZ ve sifre-sifirlama da sessizce mail atmaz (kalici kilit),
    // (b) ayni posta kutusu farkli harf duzeniyle IKI salon hesabi acabilir. User/Instructor zaten normalize ediyor.
    const cleanEmail = String(email || '').trim().toLowerCase()
    const existing = await prisma.venue.findUnique({ where: { email: cleanEmail } })
    if (existing) {
      return res.status(400).json({ error: 'Bu email adresi zaten kullanılıyor.' })
    }

    const passwordHash = await bcrypt.hash(password, 12)

    const venue = await prisma.venue.create({
      data: {
        name: clampStr(name, 120) || '',
        email: cleanEmail,
        passwordHash,
        phone: clampStr(phone, 30) || '',
        address: clampStr(address, 250) || '',
        description: clampStr(description, 2000) || null,
        // cityId İSTEMCİDEN ALINMAZ: türetilmiş bir değeri istemcinin dikte etmesi (web 'cityId: 1'
        // gönderiyordu) mahalle-şehir tutarsızlığı üretir. Mahalleden türetilir; ilçe yoksa null.
        cityId: await cityIdOfNeighborhood(parseIntSafe(neighborhoodId)),
        neighborhoodId: neighborhoodId || null,
        isApproved: false,
      },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        address: true,
        isApproved: true,
        createdAt: true,
      }
    })

    if (sportCategories && Array.isArray(sportCategories)) {
      // SINIRLA: tekrarsız (Set) + string + en çok 30 kategori. Aksi halde ~14k elemanlık dizi 14k sıralı
      // findFirst + 14k duplikat venueSportCategory insert'e dönüşüyordu (amplifikasyon + çöp satır).
      const uniqueCats = [...new Set((sportCategories as any[]).filter((c) => typeof c === 'string').map((c) => c.trim()).filter(Boolean))].slice(0, 30)
      for (const catName of uniqueCats) {
        const cat = await prisma.sportCategory.findFirst({ where: { name: { equals: catName, mode: 'insensitive' } } })
        if (cat) {
          await prisma.venueSportCategory.create({ data: { venueId: venue.id, sportCategoryId: cat.id } })
        }
      }
    }

    if (instructor?.fullName) {
      await prisma.instructor.create({
        data: {
          venueId: venue.id,
          fullName: clampStr(instructor.fullName, 80) || '', // createInstructor/updateInstructor ile aynı sınır
          bio: null,
        }
      })
    }

    try {
      await sendVenueRegistrationAdminEmail(
        venue.name,
        venue.email || '',
        phone,
        address,
        sportCategories || []
      )
    } catch (e) {
      console.error('Admin notification email error:', e)
    }

    const token = generateToken({ venueId: venue.id, email: venue.email ?? cleanEmail, role: 'venue' })

    return res.status(201).json({ message: 'Salon kaydı oluşturuldu! Onay bekleniyor.', token, venue })
  } catch (err: any) {
    if (err?.code === 'P2002') {
      return res.status(400).json({ error: 'Bu email adresi zaten kullanılıyor.' })
    }
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// SALON GİRİŞ
export const venueLogin = async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body

    if (!email || !password) {
      return res.status(400).json({ error: 'Email ve şifre gerekli.' })
    }

    // E-postayi normalize et: Venue.email byte-exact @unique. Normalize edilmezse (a) 'Salon@X.com' ile
    // kayit olan salon 'salon@x.com' ile GIREMEZ ve sifre-sifirlama da sessizce mail atmaz (kalici kilit),
    // (b) ayni posta kutusu farkli harf duzeniyle IKI salon hesabi acabilir. User/Instructor zaten normalize ediyor.
    const cleanEmail = String(email || '').trim().toLowerCase()
    const venue = await prisma.venue.findUnique({ where: { email: cleanEmail } })
    if (!venue || !venue.passwordHash) {
      await bcrypt.compare(String(password), VENUE_DUMMY_HASH).catch(() => {}) // timing'i eşitle (enumeration önleme)
      return res.status(401).json({ error: 'Email veya şifre hatalı.' })
    }

    const isValid = await bcrypt.compare(password, venue.passwordHash)
    if (!isValid) {
      return res.status(401).json({ error: 'Email veya şifre hatalı.' })
    }

    if ((venue as any).isSuspended) {
      return res.status(403).json({ error: 'Hesabınız askıya alınmıştır. Destek için admin@sipsakspor.com ile iletişime geçin.' })
    }

    const token = generateToken({ venueId: venue.id, email: venue.email ?? cleanEmail, role: 'venue' })

    return res.json({
      message: 'Giriş başarılı!',
      token,
      venue: {
        id: venue.id,
        name: venue.name,
        email: venue.email,
        isApproved: venue.isApproved,
      }
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// SALON BİLGİSİ
export const getVenueMe = async (req: Request, res: Response) => {
  try {
    const venueId = (req as any).venueId

    const venue = await prisma.venue.findUnique({
      where: { id: venueId },
      select: {
        id: true, name: true, email: true, phone: true, address: true,
        description: true, website: true, neighborhoodId: true,
        isApproved: true, avgRating: true, totalReviews: true, createdAt: true,
        coverImageUrl: true, images: true,
        pendingCoverImageUrl: true, pendingImages: true, imagesPendingReview: true,
        // İyzico alt-üye (sub-merchant) durumu
        subMerchantType: true, subMerchantStatus: true, iban: true, taxOffice: true,
        taxNumber: true, identityNumber: true, contactName: true, contactSurname: true,
        legalCompanyTitle: true, payoutGsm: true, ibanMatchConsent: true, kycDocs: true,
        subMerchantRejection: true,
        sportCategories: {
          select: { sportCategory: { select: { name: true } } }
        },
        classes: {
          select: {
            id: true, title: true, category: true, basePrice: true, isActive: true,
            sessions: {
              select: {
                id: true, startsAt: true, endsAt: true, capacity: true,
                _count: { select: { bookings: true } },
                bookings: {
                  where: { status: { in: ['confirmed', 'pending'] } },
                  select: { id: true, status: true, user: { select: { id: true, fullName: true, username: true } } }
                }
              },
              orderBy: { startsAt: 'asc' }
            }
          }
        }
      }
    })

    if (!venue) return res.status(404).json({ error: 'Salon bulunamadı.' })

    return res.json({ venue })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// SALON PROFİL GÜNCELLE
export const updateVenueProfile = async (req: Request, res: Response) => {
  try {
    const venueId = (req as any).venueId
    const { name, phone, address, description, website, neighborhoodId } = req.body

    const data: any = {}
    if (name !== undefined) data.name = clampStr(name, 120)
    if (phone !== undefined) data.phone = clampStr(phone, 30)
    if (address !== undefined) data.address = clampStr(address, 250)
    if (description !== undefined) data.description = clampStr(description, 2000)
    if (website !== undefined) data.website = clampStr(website, 250)
    // Boş/geçersiz ilçe → NaN ile 500 olmasın; geçerliyse ata, boşsa null (ilçe kaldır)
    if (neighborhoodId !== undefined) {
      const nId = parseIntSafe(neighborhoodId)
      data.neighborhoodId = nId ?? null
      // cityId SABİT 1 (İstanbul) yazılıyordu → mahalleden türet (bkz. utils/geo.ts).
      if (nId) data.cityId = await cityIdOfNeighborhood(nId)
    }

    const venue = await prisma.venue.update({
      where: { id: venueId },
      data,
      select: { id: true, name: true, phone: true, address: true, description: true, website: true }
    })

    return res.json({ message: 'Salon bilgileri güncellendi.', venue })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// SALON ŞİFRE DEĞİŞTİR
export const changeVenuePassword = async (req: Request, res: Response) => {
  try {
    const venueId = (req as any).venueId
    const { currentPassword, newPassword } = req.body

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Mevcut ve yeni şifre gerekli.' })
    }
    if (newPassword.length < MIN_PASSWORD) {
      return res.status(400).json({ error: `Yeni şifre en az ${MIN_PASSWORD} karakter olmalı.` })
    }

    const venue = await prisma.venue.findUnique({ where: { id: venueId } })
    if (!venue?.passwordHash) return res.status(404).json({ error: 'Salon bulunamadı.' })

    const isValid = await bcrypt.compare(currentPassword, venue.passwordHash)
    if (!isValid) return res.status(401).json({ error: 'Mevcut şifre hatalı.' })

    const newHash = await bcrypt.hash(newPassword, 12)
    await prisma.venue.update({ where: { id: venueId }, data: { passwordHash: newHash } })

    return res.json({ message: 'Şifre başarıyla değiştirildi.' })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// DERS EKLE
export const createClass = async (req: Request, res: Response) => {
  try {
    const venueId = (req as any).venueId
    const { title, description, category, basePrice, duration, capacity, instructorId } = req.body

    if (!title || !category || !basePrice || !duration || !capacity) {
      return res.status(400).json({ error: 'Tüm zorunlu alanları doldurun.' })
    }

    // SAHİPLİK: instructorId gövdeden geliyor — YALNIZ bu salona ait bir hoca bağlanabilir. Aksi halde
    // salon A, rakip salon B'nin hocasını dersine iliştirir (B'nin puanı kirlenir, B kendi portalında
    // A'nın dersini görüp seans ekleyebilir). Her diğer hoca mutasyonu venueId eşitliği kontrol ediyor.
    let safeInstructorId: number | null = null
    if (instructorId !== undefined && instructorId !== null && instructorId !== '') {
      const instId = parseInt(String(instructorId), 10)
      if (isNaN(instId)) return res.status(400).json({ error: 'Geçersiz hoca.' })
      const inst = await prisma.instructor.findUnique({ where: { id: instId }, select: { venueId: true } })
      if (!inst || inst.venueId !== venueId) {
        return res.status(403).json({ error: 'Bu hocayı dersinize ekleme yetkiniz yok.' })
      }
      safeInstructorId = instId
    }

    // Kategori adından sportCategoryId'yi bul (ilişki tutarlılığı için)
    const sportCat = await prisma.sportCategory.findFirst({
      where: { name: { equals: category, mode: 'insensitive' } },
      select: { id: true },
    })

    // Metinleri ÇEVİRİDEN ÖNCE sınırla — dev girdi AI token maliyetini patlatmasın + DB şişmesin
    const safeTitle = clampStr(title, 120) || ''
    const safeDesc = clampStr(description, 2000) || null
    const titleEn = await translateClassTitle(safeTitle)

    const newClass = await prisma.class.create({
      data: {
        title: safeTitle,
        titleEn,
        description: safeDesc,
        category,
        sportCategoryId: sportCat?.id ?? null,
        basePrice: parseFloat(basePrice),
        duration: parseInt(duration),
        durationMinutes: parseInt(duration),
        capacity: parseInt(capacity),
        venueId,
        instructorId: safeInstructorId,
        isActive: true,
      }
    })

    return res.status(201).json({ message: 'Ders oluşturuldu!', class: newClass })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// DERS GÜNCELLE
export const updateClass = async (req: Request, res: Response) => {
  try {
    const venueId = (req as any).venueId
    const classId = parseInt(req.params.id as string)
    const { title, description, category, basePrice, duration, capacity, isActive } = req.body

    const existing = await prisma.class.findUnique({ where: { id: classId } })
    if (!existing || existing.venueId !== venueId) {
      return res.status(403).json({ error: 'Bu dersi düzenleme yetkiniz yok.' })
    }

    // Kategori değiştiyse sportCategoryId'yi de güncelle
    let sportCategoryId: number | undefined = undefined
    if (category && category !== existing.category) {
      const sportCat = await prisma.sportCategory.findFirst({
        where: { name: { equals: category, mode: 'insensitive' } },
        select: { id: true },
      })
      sportCategoryId = sportCat?.id ?? undefined
    }

    // clampStr: createClass (satir ~377) title'i 120, description'i 2000'e keser; UPDATE yolu bu
    // sınırı ATLIYORDU → ~100KB ham metin DB'ye yazılıyor, ham başlık AI çevirisine (Groq) girip
    // token maliyetini şişiriyordu. UPDATE de aynı sınırlara uymalı.
    const safeTitle = title !== undefined ? (clampStr(title, 120) || '') : undefined
    const safeDesc = description !== undefined ? clampStr(description, 2000) : undefined
    // Başlık değiştiyse İngilizce karşılığını yeniden üret — KIRPILMIŞ değerle (AI token koruması).
    const titleEn = (safeTitle && safeTitle !== existing.title) ? await translateClassTitle(safeTitle) : undefined
    // basePrice: parseFloat('abc')=NaN Float kolonda Prisma 500 verirdi → geçerli sayı değilse yok say.
    const priceNum = basePrice !== undefined && basePrice !== '' ? parseFloat(basePrice) : undefined
    const safePrice = (priceNum !== undefined && Number.isFinite(priceNum) && priceNum >= 0) ? priceNum : undefined

    const updated = await prisma.class.update({
      where: { id: classId },
      data: {
        ...(safeTitle !== undefined ? { title: safeTitle } : {}),
        ...(safeDesc !== undefined ? { description: safeDesc } : {}),
        category,
        ...(titleEn !== undefined ? { titleEn } : {}),
        ...(sportCategoryId !== undefined ? { sportCategoryId } : {}),
        basePrice: safePrice,
        duration: duration ? parseInt(duration) : undefined,
        durationMinutes: duration ? parseInt(duration) : undefined,
        capacity: capacity ? parseInt(capacity) : undefined,
        isActive,
      }
    })

    return res.json({ message: 'Ders güncellendi!', class: updated })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// SEANS EKLE
export const createSession = async (req: Request, res: Response) => {
  try {
    const venueId = (req as any).venueId
    const classId = parseInt(req.params.classId as string)
    const { date, time, capacity, price } = req.body

    // Kapasite POZİTİF tamsayı olmalı: truthy guard -5 (dead seans) ve "abc"→parseInt NaN→Prisma 500'ü geçirirdi
    const cap = parseInt(capacity)
    if (!date || !time || !(cap > 0)) {
      return res.status(400).json({ error: 'Tarih, saat ve pozitif kapasite zorunludur.' })
    }

    const cls = await prisma.class.findUnique({ where: { id: classId } })
    if (!cls || cls.venueId !== venueId) {
      return res.status(403).json({ error: 'Bu derse seans ekleme yetkiniz yok.' })
    }

    const startsAt = new Date(`${date}T${time}:00+03:00`) // TR (UTC+3) duvar-saati — sunucu TZ'inden bağımsız doğru an
    if (startsAt <= new Date()) {
      return res.status(400).json({ error: 'Geçmiş tarihli seans eklenemez. Lütfen gelecekteki bir tarih ve saat seçin.' })
    }
    const endsAt = new Date(startsAt.getTime() + (cls.durationMinutes || cls.duration || 60) * 60000)

    let session
    try {
      session = await prisma.class_Session.create({
        data: {
          classId,
          startsAt,
          endsAt,
          capacity: cap,
        }
      })
    } catch (e: any) {
      // (classId, startsAt) artık DB'de tekil (ensureIndexes). Aynı saate ikinci seans denemesi
      // "Sunucu hatası" değil, anlaşılır bir çakışma mesajı almalı.
      if (e?.code === 'P2002') return res.status(409).json({ error: 'Bu ders için bu saatte zaten bir seans var.' })
      throw e
    }

    return res.status(201).json({ message: 'Seans oluşturuldu!', session })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// TEKRARLAYAN SEANSLAR
// body: { time, capacity, weekDays: [1,3,5], weeks: 4, instructorId? }
// weekDays: 0=Pazar, 1=Pazartesi, ..., 6=Cumartesi
export const createRecurringSessions = async (req: Request, res: Response) => {
  try {
    const venueId = (req as any).venueId
    const classId = parseInt(req.params.classId as string)
    const { time, capacity, weekDays, weeks } = req.body

    if (!time || !capacity || !weekDays || !Array.isArray(weekDays) || weekDays.length === 0 || !weeks) {
      return res.status(400).json({ error: 'Saat, kapasite, günler ve hafta sayısı zorunludur.' })
    }
    // weekDays'i SINIRLA: yalnız 0-6 tam sayı + tekrarsız (Set). Aksi halde ~50k elemanlık dizi
    // haftalar×N sıralı findFirst sorgusuna dönüşüp DB bağlantı havuzunu kilitliyordu (DoS). En çok 7 gün.
    const days = [...new Set((weekDays as any[]).map((d) => parseInt(d)).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))]
    if (days.length === 0) return res.status(400).json({ error: 'Geçerli gün seçin (Pazar=0 … Cumartesi=6).' })

    const cls = await prisma.class.findUnique({ where: { id: classId } })
    if (!cls || cls.venueId !== venueId) {
      return res.status(403).json({ error: 'Bu derse seans ekleme yetkiniz yok.' })
    }

    // Saat formatını DOĞRULA: trInstant'a çöp girerse Invalid Date olur ve DB'ye NULL/patlama gider.
    if (!/^\d{2}:\d{2}$/.test(String(time))) {
      return res.status(400).json({ error: 'Saat SS:DD biçiminde olmalı (örn. 19:00).' })
    }
    const created: any[] = []
    const skipped: string[] = []
    const now = new Date()
    const totalWeeks = Math.min(parseInt(weeks), 12) // max 12 hafta

    // Gün ve saat İSTANBUL'a göre hesaplanır — sunucu (Railway=UTC) saatiyle DEĞİL.
    // Eski hali `new Date().setHours(0,0,0,0)` + `getDay()` + `setHours(h,m)` kullanıyordu; bu,
    // salonun girdiği duvar-saatini sunucunun saati sanıyordu. Ölçüldü: UTC sunucuda "Pazartesi
    // 19:00" → 2026-08-03T19:00Z = İstanbul 22:00 (3 saat ileri); saat 22:00 seçilirse gün de
    // kayıp Salı 01:00 oluyordu. Tek-seans yolu (satır 450) zaten +03:00 kullandığından aynı
    // dersin iki seansı 3 saat farkla yan yana duruyordu. Artık iki yol da aynı sözleşmede.
    const todayYmd = trYmd(now)
    const todayWeekday = trWeekday(now)

    for (let w = 0; w < totalWeeks; w++) {
      for (const day of days) {
        const diff = (day - todayWeekday + 7) % 7
        const date = trInstant(trAddDays(todayYmd, diff + w * 7), time)

        if (date <= now) continue // geçmiş, atla

        const endsAt = new Date(date.getTime() + (cls.durationMinutes || cls.duration || 60) * 60000)

        // Aynı seans var mı kontrol et
        const existing = await prisma.class_Session.findFirst({
          where: { classId, startsAt: date }
        })
        if (existing) {
          skipped.push(date.toISOString())
          continue
        }

        try {
          const session = await prisma.class_Session.create({
            data: { classId, startsAt: date, endsAt, capacity: parseInt(capacity) }
          })
          created.push(session)
        } catch (e: any) {
          // P2002: yukarıdaki findFirst ile bu create arasında BAŞKA bir istek aynı seansı
          // oluşturdu (çift gönderim / eşzamanlı istek). DB tekilliği artık bunu yakalıyor;
          // 500 yerine "zaten vardı, atlandı" olarak raporla.
          if (e?.code === 'P2002') { skipped.push(date.toISOString()); continue }
          throw e
        }
      }
    }

    return res.status(201).json({
      message: `${created.length} seans oluşturuldu.${skipped.length > 0 ? ` ${skipped.length} seans zaten mevcuttu, atlandı.` : ''}`,
      created: created.length,
      skipped: skipped.length,
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// DROP-IN

const DROP_IN_SPORTS = ['Basketbol', 'Padel', 'Halı Saha']

const DROP_IN_FORMATS: Record<string, string[]> = {
  'Basketbol': ['4v4 Yarım Saha', '5v5 Tam Saha'],
  'Padel': ['1v1', '2v2'],
  'Halı Saha': ['6v6', '7v7'],
}

const FORMAT_PLAYERS_MAP: Record<string, number> = {
  '4v4 Yarım Saha': 8, '5v5 Tam Saha': 10,
  '1v1': 2, '2v2': 4, '6v6': 12, '7v7': 14,
}

export const createDropInSlot = async (req: Request, res: Response) => {
  try {
    const venueId = (req as any).venueId
    const { sport, format, date, time, totalPlayers, pricePerPerson, visibility, privateCode } = req.body

    if (!sport || !format || !date || !time || !pricePerPerson) {
      return res.status(400).json({ error: 'Tüm zorunlu alanları doldurun.' })
    }

    if (!DROP_IN_SPORTS.includes(sport)) {
      return res.status(400).json({ error: 'Bu spor için drop-in desteklenmiyor.' })
    }

    const validFormats = DROP_IN_FORMATS[sport] || []
    if (!validFormats.includes(format)) {
      return res.status(400).json({ error: 'Geçersiz format.' })
    }

    // SESSİZ FALLBACK YOK: eskiden `sportCategoryId: sportCat?.id || 1` yazılıyordu. Drop-in'in izinli
    // 3 sporu (Basketbol/Padel/Halı Saha) katalogda HİÇ YOK (court sporları bilinçli olarak hold'da),
    // dolayısıyla her drop-in slotu id=1 (Yoga) ile kaydolurdu: public listede "Yoga" adı/rengiyle
    // görünür, rozet sayacı futbol maçını Yoga'ya yazar, ?branch=Halı Saha filtresi hiç sonuç vermez.
    // Kategori yoksa sessizce bozuk veri yazmak yerine AÇIK hata döndür.
    const sportCat = await prisma.sportCategory.findFirst({ where: { name: { equals: sport, mode: 'insensitive' } }, orderBy: { id: 'asc' } })
    if (!sportCat) {
      return res.status(503).json({ error: `"${sport}" kategorisi sistemde tanımlı değil; bu spor için drop-in henüz açılmadı.` })
    }

    const startsAt = new Date(`${date}T${time}:00+03:00`) // TR (UTC+3) duvar-saati — sunucu TZ'inden bağımsız doğru an
    if (startsAt <= new Date()) {
      return res.status(400).json({ error: 'Geçmiş tarihli slot eklenemez.' })
    }
    const endsAt = new Date(startsAt.getTime() + 90 * 60000)

    const players = FORMAT_PLAYERS_MAP[format] || parseInt(totalPlayers) || 8
    // `!pricePerPerson` kontrolü (satır ~600) string '0' ve negatifi geçiriyordu → bedava/negatif
    // fiyatlı slot oluşabiliyordu. Number.isFinite + pozitiflik ile kesin kapat.
    const price = parseFloat(pricePerPerson)
    if (!Number.isFinite(price) || price <= 0) {
      return res.status(400).json({ error: 'Kişi başı fiyat 0’dan büyük geçerli bir sayı olmalı.' })
    }

    const slot = await prisma.dropInSlot.create({
      data: {
        venueId,
        sportCategoryId: sportCat.id,
        title: `${sport} — ${format}`,
        startsAt,
        endsAt,
        format,
        totalPlayers: players,
        currentPlayers: 0,
        totalPrice: money(players * price), // money(): players*price float tozunu temizle (public API'de ₺333.299999... görünüyordu)
        pricePerPerson: money(price),
        status: 'open',
        // visibility BEYAZ-LISTE: eskiden herhangi bir string geçiyordu (public listeleme filtresi
        // status+visibility'ye göre → tanımsız değer slotu görünmez/tutarsız yapabilirdi).
        visibility: visibility === 'private' ? 'private' : 'open',
        // privateCode clampStr + yalnız private slotta anlamlı; ham sınırsız string yazılmasın.
        privateCode: (visibility === 'private' && privateCode) ? (clampStr(String(privateCode), 32) || null) : null,
        bookedBy: null,
      }
    })

    return res.status(201).json({ message: 'Drop-in slot oluşturuldu!', slot })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

export const getVenueDropInSlots = async (req: Request, res: Response) => {
  try {
    const venueId = (req as any).venueId
    const slots = await prisma.dropInSlot.findMany({
      where: { venueId },
      include: { participants: { select: { id: true, status: true, user: { select: { fullName: true, username: true } } } } },
      orderBy: { startsAt: 'asc' },
    })
    return res.json({ slots })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// DERS SİL
export const deleteClass = async (req: Request, res: Response) => {
  try {
    const venueId = (req as any).venueId
    const classId = parseInt(req.params.id as string)
    const cls = await prisma.class.findUnique({ where: { id: classId } })
    if (!cls || cls.venueId !== venueId) return res.status(403).json({ error: 'Yetki yok.' })
    const sessions = await prisma.class_Session.findMany({ where: { classId }, select: { id: true } })
    const sessIds = sessions.map(s => s.id)
    const affected = await prisma.$transaction(async (tx) => {
      // KİLİT SIRASI: Venue → User → Booking. recomputeVenueRating Venue'yu EN SONDA kilitliyordu,
      // createReview ise ÖNCE Venue'yu kilitleyip sonra Booking'e FK'li Review yazıyor → ters sıra,
      // deadlock (40P01). Kurban puanlama tarafı olursa kullanıcının yorumu kaydedilmez ve booking
      // hemen ardından silineceği için o puan bir daha ASLA verilemez. Venue kilidini başa alıyoruz.
      await tx.$executeRaw`SELECT id FROM "Venue" WHERE id = ${cls.venueId} FOR UPDATE`
      const a = sessIds.length ? await purgeBookingsForSessions(tx, sessIds) : []
      await tx.class_Session.deleteMany({ where: { classId } })
      await tx.class.delete({ where: { id: classId } })
      await recomputeVenueRating(tx, cls.venueId) // yorumlar silindi → salon puanını güncelle
      return a
    }, { timeout: 30000, maxWait: 10000 })
    // timeout: purge rezervasyon başına birkaç gidiş-dönüş yapıyor; dolu bir dersin silinmesi
    // Prisma'nın 5 sn'lik VARSAYILANINI aşıp TÜM işlemi geri alıyordu (seans silinmez, o dersteki
    // herkesin puan iadesi hiç yazılmaz, salona 500 döner — tekrar denemede yük daha da büyük).
    await notifyRemovedBookings(affected, cls.title).catch(() => {})
    return res.json({ message: 'Ders silindi.', affectedBookings: affected.length })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// SEANS SİL
export const deleteSession = async (req: Request, res: Response) => {
  try {
    const venueId = (req as any).venueId
    const sessionId = parseInt(req.params.sessionId as string)
    const session = await prisma.class_Session.findUnique({ where: { id: sessionId }, include: { class: true } })
    if (!session || session.class.venueId !== venueId) return res.status(403).json({ error: 'Yetki yok.' })
    const affected = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM "Venue" WHERE id = ${session.class.venueId} FOR UPDATE` // sıra: Venue → User → Booking (deleteClass ile aynı)
      const a = await purgeBookingsForSessions(tx, [sessionId])
      await tx.class_Session.delete({ where: { id: sessionId } })
      await recomputeVenueRating(tx, session.class.venueId) // yorumlar silindi → salon puanını güncelle
      return a
    }, { timeout: 30000, maxWait: 10000 })
    await notifyRemovedBookings(affected, session.class.title).catch(() => {})
    return res.json({ message: 'Seans silindi.', affectedBookings: affected.length })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// DROP-IN SLOT SİL
export const deleteDropInSlot = async (req: Request, res: Response) => {
  try {
    const venueId = (req as any).venueId
    const slotId = parseInt(req.params.id as string)
    const slot = await prisma.dropInSlot.findUnique({ where: { id: slotId } })
    if (!slot || slot.venueId !== venueId) return res.status(403).json({ error: 'Yetki yok.' })
    // TEK TRANSACTION. Eskiden iki ayrı otomatik-commit yazmaydı: araya giren bir joinDropIn
    // yeni katılımcı eklediğinde ikinci silme FK ihlaliyle patlıyor, ama İLK silme çoktan
    // commit olmuş oluyordu → 5 katılımcı kalıcı silinmiş, slot hâlâ 'open' ve public listede.
    // Slot satırını FOR UPDATE ile kilitliyoruz ki join bu arada araya giremesin.
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM "DropInSlot" WHERE id = ${slotId} FOR UPDATE`
      await tx.dropInParticipant.deleteMany({ where: { slotId } })
      await tx.dropInSlot.delete({ where: { id: slotId } })
    })
    return res.json({ message: 'Drop-in slot silindi.' })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// SALON RESERVASYONLARİ
export const getVenueBookings = async (req: Request, res: Response) => {
  try {
    const venueId = (req as any).venueId

    // AÇIK SELECT (include DEĞİL). include, Booking'in TÜM skaler kolonlarını döndürüyordu; bunların
    // arasında müşterinin tek-kullanımlık `checkInCode` KATILIM KANITI vardı. Salon bu kodu bilirse
    // müşteri gelmeden onun adına check-in yapıp streak/rozet ilerletebilir (kodun tüm amacı bunu
    // engellemek). Salonun panelde ihtiyacı olan alanlarla sınırlıyoruz; checkInCode ASLA dönmez.
    const bookings = await prisma.booking.findMany({
      where: { session: { class: { venueId } } },
      select: {
        id: true, status: true, bookingType: true, groupSize: true, bookingNumber: true,
        checkedIn: true, checkedInAt: true, createdAt: true,
        // Veri minimizasyonu (KVKK): salona müşteri e-postası verilmez — check-in kodla, roster isimle.
        user: { select: { id: true, fullName: true, username: true } },
        session: { select: { id: true, startsAt: true, class: { select: { title: true, category: true } } } },
      },
      orderBy: { createdAt: 'desc' },
    })

    return res.json({ bookings })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// SEANS GÜNCELLE
export const updateSession = async (req: Request, res: Response) => {
  try {
    const venueId = (req as any).venueId
    const sessionId = parseInt(req.params.sessionId as string)
    const { date, time, capacity } = req.body

    // Kapasite POZİTİF tamsayı olmalı. Bu kapı createSession'da (satır ~486) VARDI ama
    // güncelleme yolunda YOKTU: boş/"abc" → parseInt NaN → Prisma 500, -5 → ölü seans.
    const cap = parseInt(capacity)
    if (!date || !time || !(cap > 0)) {
      return res.status(400).json({ error: 'Tarih, saat ve pozitif kapasite zorunludur.' })
    }

    const session = await prisma.class_Session.findUnique({
      where: { id: sessionId },
      include: { class: true }
    })
    if (!session || session.class.venueId !== venueId) {
      return res.status(403).json({ error: 'Bu seansı düzenleme yetkiniz yok.' })
    }

    const startsAt = new Date(`${date}T${time}:00+03:00`) // TR (UTC+3) duvar-saati — sunucu TZ'inden bağımsız doğru an
    if (startsAt <= new Date()) {
      return res.status(400).json({ error: 'Geçmiş tarihli seans eklenemez.' })
    }
    const endsAt = new Date(startsAt.getTime() + (session.class.durationMinutes || session.class.duration || 60) * 60000)

    const eskiStartsAt = session.startsAt

    // KAPASİTE MEVCUT DOLULUĞUN ALTINA ÇEKİLEMEZ.
    // Eskiden hiçbir kontrol yoktu: 20 kişilik, 15'i satılmış seansın kapasitesi 5
    // yazılabiliyor, 15 onaylı rezervasyon aynen kalıyordu → seans 3 kat aşırı satılmış
    // hâlde, hiçbir uyarı çıkmadan devam ediyordu.
    // Okuma+yazma tek transaction'da ve seans satırı FOR UPDATE ile kilitli: aksi hâlde
    // kontrol ile update arasında yeni rezervasyon girip sınırı yine aşabilirdi
    // (createBooking da aynı satırı kilitler; kilit sırası Class_Session → Booking).
    const CAP_ERR = 'CAPACITY_BELOW_OCCUPANCY'
    let updated
    try {
      updated = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT id FROM "Class_Session" WHERE id = ${sessionId} FOR UPDATE`
        const occ = await tx.booking.aggregate({
          where: { sessionId, status: { in: ['confirmed', 'pending'] } },
          _sum: { groupSize: true },
        })
        const occupied = occ._sum.groupSize || 0
        if (cap < occupied) throw Object.assign(new Error(CAP_ERR), { occupied })
        return tx.class_Session.update({
          where: { id: sessionId },
          data: { startsAt, endsAt, capacity: cap },
        })
      })
    } catch (e: any) {
      if (e?.message === CAP_ERR) {
        return res.status(400).json({
          error: `Bu seansta ${e.occupied} kişilik rezervasyon var; kapasite ${e.occupied} kişinin altına düşürülemez.`,
        })
      }
      // (classId, startsAt) DB'de tekil — aynı saate taşıma "Sunucu hatası" değil,
      // anlaşılır bir çakışma mesajı almalı (createSession ile aynı davranış).
      if (e?.code === 'P2002') {
        return res.status(409).json({ error: 'Bu ders için bu saatte zaten bir seans var.' })
      }
      throw e
    }

    // YENİDEN-PLANLAMA BİLDİRİMİ: seans yeni saate taşındı; rezervasyonlu kullanıcılar HABERSİZ
    // kalıp eski saatte boş stüdyoya gelmesin. Eskiden hiçbir kanal yoktu. Saat gerçekten değiştiyse
    // bildir + reminderSent=false yap (düzeltilmiş hatırlatma tekrar gitsin, aksi halde eski saatli
    // hatırlatma kalıcı bastırılıyordu).
    if (eskiStartsAt.getTime() !== startsAt.getTime()) {
      const yeniTarih = trDate(startsAt), yeniSaat = trTime(startsAt)
      await prisma.booking.updateMany({ where: { sessionId, status: 'confirmed' }, data: { reminderSent: false } }).catch(() => {})
      const affected = await prisma.booking.findMany({
        where: { sessionId, status: 'confirmed' },
        select: { user: { select: { id: true, email: true, fullName: true, pushToken: true, locale: true } } },
      })
      const rsParams = { classTitle: session.class.title, date: yeniTarih, time: yeniSaat }
      for (const b of affected) {
        const u = b.user
        if (!u) continue
        const loc = (u.locale || 'tr') as Locale
        await prisma.notification.create({ data: { userId: u.id, type: 'session_rescheduled', ...notifyFields(loc, 'session_rescheduled', rsParams) } }).catch(() => {})
        const push = notifyPush(loc, 'session_rescheduled', rsParams)
        if (u.pushToken && push) sendPushNotification(u.pushToken, push.title, push.body).catch(() => {})
        const newTimeSuffix = loc === 'en' ? `(new time: ${yeniTarih} ${yeniSaat})` : `(yeni saat: ${yeniTarih} ${yeniSaat})`
        if (u.email) sendCancellationEmail(u.email, u.fullName || '', `${session.class.title} ${newTimeSuffix}`, yeniTarih, yeniSaat, loc).catch(() => {})
      }
    }

    return res.json({ message: 'Seans güncellendi!', session: updated })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// SALON RESİMLERİ GÜNCELLE — admin onayına gönderir (canlı resimler onaya kadar değişmez)
export const updateVenueImages = async (req: Request, res: Response) => {
  try {
    const venueId = (req as any).venueId
    const { images, coverImageUrl } = req.body
    // Girdi doğrulama: yalnızca http(s) URL, en fazla 10 görsel, her biri makul uzunlukta.
    // (Client Cloudinary URL gönderir.) Aksi halde bozuk/dizi-olmayan girdi onaydan sonra canlı
    // alana geçip venue sayfasının .map'ini çökertebilir + sınırsız girdi DB'yi şişirir.
    const isUrl = (u: unknown): u is string => typeof u === 'string' && u.length <= 500 && /^https?:\/\//i.test(u)
    const cleanImages = (Array.isArray(images) ? images : []).filter(isUrl).slice(0, 10)
    const cleanCover = isUrl(coverImageUrl) ? coverImageUrl : null
    const updated = await prisma.venue.update({
      where: { id: venueId },
      data: {
        // Canlı (images/coverImageUrl) alanlara DOKUNULMAZ; yeni set onaya gider
        pendingImages: cleanImages,
        pendingCoverImageUrl: cleanCover,
        imagesPendingReview: true,
      },
      select: { id: true, images: true, coverImageUrl: true, pendingImages: true, pendingCoverImageUrl: true, imagesPendingReview: true }
    })
    return res.json({ message: 'Resimleriniz admin onayına gönderildi. Onaylandıktan sonra sitede görünecek.', venue: updated })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// SALON ŞİFRE SIFIRLAMA - MAIL GÖNDER
export const venueForgotPassword = async (req: Request, res: Response) => {
  try {
    const { email } = req.body
    // E-postayi normalize et: Venue.email byte-exact @unique. Normalize edilmezse (a) 'Salon@X.com' ile
    // kayit olan salon 'salon@x.com' ile GIREMEZ ve sifre-sifirlama da sessizce mail atmaz (kalici kilit),
    // (b) ayni posta kutusu farkli harf duzeniyle IKI salon hesabi acabilir. User/Instructor zaten normalize ediyor.
    const cleanEmail = String(email || '').trim().toLowerCase()
    const venue = await prisma.venue.findUnique({ where: { email: cleanEmail } })
    // Güvenlik: email yoksa da aynı mesajı dön
    if (!venue || !venue.email) {
      return res.json({ message: 'Email gönderildi' })
    }
    const token = crypto.randomBytes(32).toString('hex')
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000)
    await prisma.venuePasswordResetToken.create({
      data: { venueId: venue.id, token, expiresAt }
    })
    // Kullanıcı reset maili ile aynı template, salon paneli linki
    sendVenuePasswordResetEmail(venue.email, venue.name, token).catch(err =>
      console.error('Venue reset mail gönderilemedi:', err)
    )
    return res.json({ message: 'Email gönderildi' })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// SALON ŞİFRE SIFIRLAMA - YENİ ŞİFRE BELİRLE
export const venueResetPassword = async (req: Request, res: Response) => {
  try {
    const { token, password } = req.body
    if (!token || typeof token !== 'string' || !password || password.length < MIN_PASSWORD) {
      return res.status(400).json({ error: 'Geçersiz istek veya şifre çok kısa.' })
    }
    const resetToken = await prisma.venuePasswordResetToken.findFirst({
      where: { token, used: false, expiresAt: { gt: new Date() } }
    })
    if (!resetToken) {
      return res.status(400).json({ error: 'Geçersiz veya süresi dolmuş link.' })
    }
    const passwordHash = await bcrypt.hash(password, 12)
    // CAS + parola yazması TEK TRANSACTION (user resetPassword ile aynı desen). Eskiden parola önce
    // commit'lenip token used=true AYRI yazılıyordu ve used üzerinde CAS yoktu → aynı sıfırlama
    // linkine iki kez tıklama iki kez parola yazabiliyor, ya da token yazması başarısızsa link
    // sonsuza dek "kullanılmadı" kalıyordu. (Salon token'ı 7-gün JWT, refresh yok → revoke gereksiz.)
    const ok = await prisma.$transaction(async (tx) => {
      const claim = await tx.venuePasswordResetToken.updateMany({
        where: { id: resetToken.id, used: false },
        data: { used: true },
      })
      if (claim.count === 0) return false
      await tx.venue.update({ where: { id: resetToken.venueId }, data: { passwordHash } })
      return true
    })
    if (!ok) return res.status(400).json({ error: 'Geçersiz veya süresi dolmuş link.' })
    return res.json({ message: 'Şifre güncellendi.' })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}
