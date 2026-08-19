import { Request, Response } from 'express'
import prisma from '../utils/prisma'
import { gorselUrlGecerliMi, toplantiUrlGecerliMi } from '../utils/sanitize'
import { sellerBlocked } from '../utils/seller'
import { clampStr, parseIntSafe } from '../utils/validate'
import { translateClassTitle, translateSpecialty, translateInstructorBio } from '../utils/translate'
import { awardAttendanceOnCheckin } from './bookingController'

// Eğitmen portalı — kendi profili + kendi dersleri + kendi öğrencilerini check-in.
// GÜVENLİK: hepsi instructorAuthMiddleware (role='instructor', req.instructorId) arkasında; JWT venueId
// TAŞIMAZ → venueId DB'den türetilir, instructorId gövdeden ASLA alınmaz, sahiplik hep instructorId
// ile kurulur. Hiçbir uç FİNANS (venuePayout/commission/finalAmount) döndürmez; drop-in check-in yok
// (drop-in'in hoca sahibi yoktur).

// PUT /api/instructor/me — kendi profilini düzenle (yalnız fullName/specialty/bio/avatarUrl).
// email/phone/verified/isActive/venueId ASLA değiştirilemez (login kimliği + tekillik/güven kolonları).
export const updateInstructorMe = async (req: Request, res: Response) => {
  try {
    const instructorId = (req as any).instructorId
    const { fullName, specialty, bio, avatarUrl } = req.body
    // Bkz. utils/sanitize.gorselUrlGecerliMi — saldırgan-kontrollü avatar adresi izleme pikseline döner.
    if (avatarUrl !== undefined && !gorselUrlGecerliMi(avatarUrl)) {
      return res.status(400).json({ error: 'Geçersiz profil fotoğrafı adresi.' })
    }

    const existing = await prisma.instructor.findUnique({ where: { id: instructorId } })
    if (!existing) return res.status(404).json({ error: 'Eğitmen bulunamadı.' })

    const sSpecialty = specialty !== undefined ? clampStr(specialty, 200) : undefined // çoklu branş birleşimi → 200
    const sBio = bio !== undefined ? clampStr(bio, 1000) : undefined
    // EN karşılığı TR ile senkron kalmalı: alan TEMİZLENİRSE (boş) EN'i de null'a çek, aksi halde eski EN
    // hayalet kalırdı. Dolu+değişmişse çevir; dolu+aynıysa dokunma (undefined).
    const specialtyEn = sSpecialty === undefined ? undefined
      : (sSpecialty ? (sSpecialty !== existing.specialty ? await translateSpecialty(sSpecialty) : undefined) : null)
    const bioEn = sBio === undefined ? undefined
      : (sBio ? (sBio !== existing.bio ? await translateInstructorBio(sBio) : undefined) : null)

    const updated = await prisma.instructor.update({
      where: { id: instructorId },
      data: {
        // fullName NOT NULL — boş string'e düşürme
        fullName: fullName !== undefined ? (clampStr(fullName, 80) || existing.fullName) : undefined,
        specialty: sSpecialty,
        bio: sBio,
        avatarUrl: avatarUrl !== undefined ? (clampStr(avatarUrl, 500) || null) : undefined,
        ...(specialtyEn !== undefined ? { specialtyEn } : {}),
        ...(bioEn !== undefined ? { bioEn } : {}),
      },
      select: {
        id: true, fullName: true, specialty: true, specialtyEn: true, bio: true, bioEn: true,
        avatarUrl: true, phone: true, email: true, avgRating: true, totalReviews: true,
        verified: true, isActive: true, venue: { select: { id: true, name: true } },
      },
    })
    return res.json({ message: 'Profil güncellendi!', instructor: updated })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

/**
 * Eğitmenin ŞU AN ders/seans açmaya yetkili olup olmadığı. İki tür eğitmen var:
 *  • salona bağlı  → kapı SALONUN onayı/aktifliği (eskiden tek durum buydu)
 *  • mekânsız      → kapı EĞİTMENİN KENDİ `isApproved`'ı (salonun karşılığı, admin verir)
 * Engelliyse mesaj, değilse `null` döner.
 */
async function satisKapisi(instructorId: number) {
  const inst = await prisma.instructor.findUnique({
    where: { id: instructorId },
    select: {
      venueId: true,
      isActive: true,
      isApproved: true,
      venue: { select: { isApproved: true, isActive: true, isSuspended: true } },
    },
  })
  if (!inst) return { inst: null, hata: 'Eğitmen bulunamadı.', kod: 404 as const }
  if (inst.isActive === false) return { inst, hata: 'Hesabınız aktif değil.', kod: 403 as const }
  if (inst.venueId != null) {
    const v = inst.venue
    if (!v || !v.isApproved || v.isActive === false || v.isSuspended) {
      return { inst, hata: 'Salonunuz henüz onaylı/aktif değil. Ders ekleyemezsiniz.', kod: 403 as const }
    }
    return { inst, hata: null, kod: 200 as const }
  }
  if (!inst.isApproved) {
    return { inst, hata: 'Başvurunuz henüz onaylanmadı. Onaylanınca ders ekleyebilirsiniz.', kod: 403 as const }
  }
  return { inst, hata: null, kod: 200 as const }
}

// POST /api/instructor/classes — kendi üzerine ders oluştur.
// venueId DB'den (instructor.venueId — mekânsız hocada NULL), instructorId ZORLA req'den.
// Mekânsız hoca yalnız ONLINE ders açabilir (adresi yok); DB'de CHECK ile de garanti altında.
export const createInstructorClass = async (req: Request, res: Response) => {
  try {
    const instructorId = (req as any).instructorId
    const kapi = await satisKapisi(instructorId)
    if (kapi.hata || !kapi.inst) return res.status(kapi.kod).json({ error: kapi.hata })
    const inst = kapi.inst

    const { title, description, category } = req.body
    if (!title || !category) {
      return res.status(400).json({ error: 'Ders adı ve branş zorunludur.' })
    }

    // TESLİM BİÇİMİ. Mekânsız hocada seçim YOK — zorla 'online'. Salona bağlı hoca ikisini de
    // açabilir; gövdeden gelen tanınmayan değer sessizce 'in_person'a düşmez, 400 döner
    // (sessiz düşüş, hocanın online sandığı dersin yüz yüze yayımlanması demekti).
    const rawMode = typeof req.body.deliveryMode === 'string' ? req.body.deliveryMode.trim() : ''
    let deliveryMode: 'in_person' | 'online'
    if (inst.venueId == null) {
      deliveryMode = 'online'
      if (rawMode && rawMode !== 'online') {
        return res.status(400).json({ error: 'Salona bağlı olmayan eğitmen yalnızca online ders açabilir.' })
      }
    } else {
      if (rawMode && rawMode !== 'online' && rawMode !== 'in_person') {
        return res.status(400).json({ error: 'Geçersiz teslim biçimi.' })
      }
      deliveryMode = rawMode === 'online' ? 'online' : 'in_person'
    }

    const meetingUrlRaw = typeof req.body.meetingUrl === 'string' ? req.body.meetingUrl.trim() : ''
    if (deliveryMode === 'online') {
      if (!toplantiUrlGecerliMi(meetingUrlRaw)) {
        return res.status(400).json({ error: 'Ders bağlantısı https ile başlayan geçerli bir adres olmalı.' })
      }
    } else if (meetingUrlRaw) {
      return res.status(400).json({ error: 'Yüz yüze derse bağlantı eklenemez.' })
    }
    // Sayısal alanlar POZİTİF olmalı: `!basePrice` guard'ı negatif/NaN'ı geçirirdi; negatif süre
    // endsAt'i startsAt'ten öne çekip puanlama penceresini bozardı. `!(x > 0)` → NaN/0/negatif hepsini yakalar.
    const price = Number(req.body.basePrice)
    const dur = parseInt(req.body.duration)
    const cap = parseInt(req.body.capacity)
    if (!(price > 0) || !(dur > 0) || !(cap > 0)) {
      return res.status(400).json({ error: 'Fiyat, süre ve kapasite pozitif bir sayı olmalı.' })
    }

    const sportCat = await prisma.sportCategory.findFirst({
      where: { name: { equals: category, mode: 'insensitive' } },
      select: { id: true, onlineAllowed: true },
    })

    // ONLINE KATEGORİ KAPISI — kural DB'de (SportCategory.onlineAllowed). FAIL-CLOSED: kategori
    // çözülemediyse de reddediyoruz, aksi halde serbest-metin bir kategori adıyla yüzme/binicilik
    // gibi fiziksel olarak imkânsız bir ders online yayımlanabilirdi. venueController.createClass
    // ile AYNI kural — kardeş yolların ayrışması bu repoda en sık bulunan kök nedendir.
    if (deliveryMode === 'online' && !sportCat?.onlineAllowed) {
      return res.status(400).json({ error: 'Bu branş online derse uygun değil.' })
    }

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
        basePrice: price,
        duration: dur,
        durationMinutes: dur,
        capacity: cap,
        venueId: inst.venueId,     // DB'den — gövdeden ALINMAZ (mekânsız hocada null)
        instructorId,              // ZORLA giriş yapan eğitmen — başka hoca adına açılamaz
        deliveryMode,
        meetingUrl: deliveryMode === 'online' ? meetingUrlRaw || null : null,
        isActive: true,
      },
    })

    return res.status(201).json({ message: 'Ders oluşturuldu!', class: newClass })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// POST /api/instructor/classes/:classId/sessions — kendi dersine seans ekle.
// Sahiplik: cls.instructorId === req.instructorId (venueId DEĞİL).
export const createInstructorSession = async (req: Request, res: Response) => {
  try {
    const instructorId = (req as any).instructorId
    const classId = parseIntSafe(req.params.classId)
    const { date, time, capacity } = req.body

    // Kapasite POZİTİF tamsayı olmalı: truthy guard'ı -5 (dead seans) ve "abc"→parseInt NaN→Prisma 500'ü geçirirdi
    const cap = parseInt(capacity)
    if (!classId || !date || !time || !(cap > 0)) {
      return res.status(400).json({ error: 'Tarih, saat ve pozitif kapasite zorunludur.' })
    }

    const cls = await prisma.class.findUnique({
      where: { id: classId },
      select: {
        instructorId: true, durationMinutes: true, duration: true, deliveryMode: true,
        venueId: true,
        venue: { select: { isApproved: true, isActive: true, isSuspended: true } },
        instructor: { select: { isApproved: true, isActive: true } },
      },
    })
    // instructorId nullable → kesin eşitlik; sadece KENDİ dersine seans ekleyebilir
    if (!cls || cls.instructorId !== instructorId) {
      return res.status(403).json({ error: 'Bu derse seans ekleme yetkiniz yok.' })
    }
    // SATICI KAPISI (createInstructorClass ile AYNI kural): askıdaki satıcının yeni bookable
    // seans üretip moderasyonu veri katmanında atlamasını engelle. Mekânsız hocada kapı kendi
    // onayıdır — eski hâl `venue` istediği için mekânsız hoca hiç seans EKLEYEMEZDİ.
    const kapali = sellerBlocked(cls)
    if (kapali) {
      return res.status(403).json({ error: 'Hesabınız şu anda onaylı/aktif değil. Seans ekleyemezsiniz.' })
    }

    // SEANS BAĞLANTISI (opsiyonel) — yalnız online derste. Boşsa dersin kendi linkine düşülür.
    const sMeetingRaw = typeof req.body.meetingUrl === 'string' ? req.body.meetingUrl.trim() : ''
    if (sMeetingRaw && cls.deliveryMode !== 'online') {
      return res.status(400).json({ error: 'Yüz yüze derse bağlantı eklenemez.' })
    }
    if (!toplantiUrlGecerliMi(sMeetingRaw)) {
      return res.status(400).json({ error: 'Ders bağlantısı https ile başlayan geçerli bir adres olmalı.' })
    }

    const startsAt = new Date(`${date}T${time}:00+03:00`) // TR (UTC+3) duvar-saati — sunucu TZ'inden bağımsız doğru an
    if (isNaN(startsAt.getTime()) || startsAt <= new Date()) {
      return res.status(400).json({ error: 'Geçmiş/geçersiz tarihli seans eklenemez. Gelecekteki bir tarih ve saat seçin.' })
    }
    const endsAt = new Date(startsAt.getTime() + (cls.durationMinutes || cls.duration || 60) * 60000)

    const session = await prisma.class_Session.create({
      data: { classId, startsAt, endsAt, capacity: cap, meetingUrl: sMeetingRaw || null },
    })

    return res.status(201).json({ message: 'Seans oluşturuldu!', session })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// GET /api/instructor/classes — YALNIZ kendi derslerin (+ yaklaşan seansları). Salon geneli DÖNDÜRMEZ.
export const getMyInstructorClasses = async (req: Request, res: Response) => {
  try {
    const instructorId = (req as any).instructorId
    const now = new Date()
    const classes = await prisma.class.findMany({
      where: { instructorId },
      select: {
        id: true, title: true, category: true, basePrice: true, durationMinutes: true,
        capacity: true, isActive: true,
        // Portal, online derse özel alanları (seans bazlı bağlantı) ancak bunu bilirse çizebilir.
        // `meetingUrl` de DÖNÜYOR ve dönmesi DOĞRU: bu uç dersin SAHİBİNE cevap veriyor —
        // public uçlarda strip ediliyor (bkz. utils/seller.ts yorumu ve publicController).
        deliveryMode: true, meetingUrl: true,
        sessions: {
          where: { startsAt: { gte: now } },
          orderBy: { startsAt: 'asc' },
          select: { id: true, startsAt: true, endsAt: true, capacity: true, status: true, meetingUrl: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    })
    return res.json({ classes })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// POST /api/instructor/checkin — öğrenciyi kendi dersinde check-in yap (öğrenci QR kodunu okutur).
// Sahiplik: booking.session.class.instructorId === req.instructorId. FİNANS DÖNDÜRMEZ.
export const checkInInstructorBooking = async (req: Request, res: Response) => {
  try {
    const instructorId = (req as any).instructorId
    const { code } = req.body
    if (!code?.trim()) return res.status(400).json({ error: 'Check-in kodu gerekli.' })

    const booking = await prisma.booking.findFirst({
      where: { checkInCode: code.trim().toUpperCase() },
      include: {
        user: { select: { fullName: true, username: true, avatarUrl: true } },
        session: { include: { class: { select: { title: true, instructorId: true, venueId: true, venue: { select: { isApproved: true, isActive: true, isSuspended: true } }, instructor: { select: { isApproved: true, isActive: true } } } } } },
      },
    })
    if (!booking) return res.status(404).json({ error: 'Geçersiz kod. Rezervasyon bulunamadı.' })

    // SAHİPLİK: yalnız KENDİ dersinin öğrencisini check-in yapabilir (instructorId nullable → kesin eşitlik).
    // Sahip-olunmayan kod, BULUNAMAYAN kodla AYNI 404 döner → "kod platformda var mı?" existence-oracle'ı kapatılır.
    if (booking.session?.class?.instructorId !== instructorId) {
      return res.status(404).json({ error: 'Geçersiz kod. Rezervasyon bulunamadı.' })
    }
    // SALON DURUM KAPISI: kardeş uçlar (createInstructorClass/Session) bunu kontrol ediyor, check-in
    // ETMİYORDU → askıya alınmış/onayı geri alınmış salonun eğitmeni öğrenci check-in'leyip streak/
    // rozet/tier ilerletebiliyor ve o salona yeni puan yazılmasının önünü açıyordu. Salonun kendi
    // token'ı bu işlemde 403 alırken eğitmen realm'i etkilenmiyordu.
    // Kapı iki kaynaklı (salon ya da mekânsız hoca) → tek yardımcıdan; eski hâl `venue` zorunlu
    // saydığı için mekânsız hocanın check-in'i HER ZAMAN 403 olurdu.
    if (sellerBlocked(booking.session?.class ?? null)) {
      return res.status(403).json({ error: 'Hesabınız şu anda aktif değil; check-in yapılamaz.' })
    }
    if (booking.status !== 'confirmed') {
      return res.status(400).json({ error: 'Rezervasyon onaylı değil.' })
    }

    // ZAMAN PENCERESİ: yalnız ders saati civarında (başlangıç−1sa .. bitiş+3sa) — gelecekteki dersi
    // erkenden check-in'leyip öğrencinin streak/rozetini şişirme engellenir (salon check-in ile aynı kural).
    const st = booking.session?.startsAt ? new Date(booking.session.startsAt).getTime() : null
    const en = booking.session?.endsAt ? new Date(booking.session.endsAt).getTime() : null
    const nowMs = Date.now()
    if (st != null && nowMs < st - 60 * 60000) return res.status(400).json({ error: 'Check-in ders saatine yakın açılır (henüz erken).' })
    if (en != null && nowMs > en + 180 * 60000) return res.status(400).json({ error: 'Check-in süresi doldu.' })

    const payload = {
      user: booking.user,
      classTitle: booking.session?.class?.title,
      groupSize: booking.groupSize,
      checkedInAt: booking.checkedInAt,
    }
    if (booking.checkedIn) {
      return res.json({ alreadyCheckedIn: true, message: 'Bu rezervasyon zaten check-in yapılmış.', booking: payload })
    }
    // ATOMİK: checkedIn=false→true çevirebilen TEK istek başarılı sayılır. Eşzamanlı çift-okutmada
    // (çift-tık/retry) ikinci istek count=0 alır → "zaten check-in" döner (stale-read yarışı kapalı).
    const claim = await prisma.booking.updateMany({ where: { id: booking.id, checkedIn: false }, data: { checkedIn: true, checkedInAt: new Date() } })
    if (claim.count === 0) {
      return res.json({ alreadyCheckedIn: true, message: 'Bu rezervasyon zaten check-in yapılmış.', booking: payload })
    }
    // Attendance puani + referral (check-in'de kredilenir; salon ve egitmen check-in'i ayni davranis).
    awardAttendanceOnCheckin(booking.id).catch(() => {})
    return res.json({ success: true, message: 'Check-in başarılı!', booking: { ...payload, checkedInAt: new Date() } })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}
