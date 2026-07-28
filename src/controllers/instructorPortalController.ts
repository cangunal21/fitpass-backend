import { Request, Response } from 'express'
import prisma from '../utils/prisma'
import { clampStr, parseIntSafe } from '../utils/validate'
import { translateClassTitle, translateSpecialty, translateInstructorBio } from '../utils/translate'

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

// POST /api/instructor/classes — kendi salonuna, kendi üzerine ders oluştur.
// venueId DB'den (instructor.venueId), instructorId ZORLA req'den. Salon onaysız/askıdaysa 403.
export const createInstructorClass = async (req: Request, res: Response) => {
  try {
    const instructorId = (req as any).instructorId
    const inst = await prisma.instructor.findUnique({
      where: { id: instructorId },
      select: { venueId: true, venue: { select: { isApproved: true, isActive: true } } },
    })
    if (!inst) return res.status(404).json({ error: 'Eğitmen bulunamadı.' })
    if (!inst.venue?.isApproved || inst.venue?.isActive === false) {
      return res.status(403).json({ error: 'Salonunuz henüz onaylı/aktif değil. Ders ekleyemezsiniz.' })
    }

    const { title, description, category } = req.body
    if (!title || !category) {
      return res.status(400).json({ error: 'Ders adı ve branş zorunludur.' })
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
      select: { id: true },
    })

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
        venueId: inst.venueId,     // DB'den — gövdeden ALINMAZ
        instructorId,              // ZORLA giriş yapan eğitmen — başka hoca adına açılamaz
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

    const cls = await prisma.class.findUnique({ where: { id: classId }, select: { instructorId: true, durationMinutes: true, duration: true, venue: { select: { isApproved: true, isActive: true, isSuspended: true } } } })
    // instructorId nullable → kesin eşitlik; sadece KENDİ dersine seans ekleyebilir
    if (!cls || cls.instructorId !== instructorId) {
      return res.status(403).json({ error: 'Bu derse seans ekleme yetkiniz yok.' })
    }
    // Salon onaysız/askıdaysa seans ekleme (createInstructorClass ile aynı kapı) — askıdaki salonda
    // eğitmenin yeni bookable seans üretip moderasyonu veri katmanında atlamasını engelle.
    if (!cls.venue?.isApproved || cls.venue?.isActive === false || cls.venue?.isSuspended) {
      return res.status(403).json({ error: 'Salonunuz onaylı/aktif değil. Seans ekleyemezsiniz.' })
    }

    const startsAt = new Date(`${date}T${time}:00+03:00`) // TR (UTC+3) duvar-saati — sunucu TZ'inden bağımsız doğru an
    if (isNaN(startsAt.getTime()) || startsAt <= new Date()) {
      return res.status(400).json({ error: 'Geçmiş/geçersiz tarihli seans eklenemez. Gelecekteki bir tarih ve saat seçin.' })
    }
    const endsAt = new Date(startsAt.getTime() + (cls.durationMinutes || cls.duration || 60) * 60000)

    const session = await prisma.class_Session.create({
      data: { classId, startsAt, endsAt, availableSpots: cap },
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
        sessions: {
          where: { startsAt: { gte: now } },
          orderBy: { startsAt: 'asc' },
          select: { id: true, startsAt: true, endsAt: true, availableSpots: true, status: true },
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
        session: { include: { class: { select: { title: true, instructorId: true } } } },
      },
    })
    if (!booking) return res.status(404).json({ error: 'Geçersiz kod. Rezervasyon bulunamadı.' })

    // SAHİPLİK: yalnız KENDİ dersinin öğrencisini check-in yapabilir (instructorId nullable → kesin eşitlik).
    // Sahip-olunmayan kod, BULUNAMAYAN kodla AYNI 404 döner → "kod platformda var mı?" existence-oracle'ı kapatılır.
    if (booking.session?.class?.instructorId !== instructorId) {
      return res.status(404).json({ error: 'Geçersiz kod. Rezervasyon bulunamadı.' })
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
    return res.json({ success: true, message: 'Check-in başarılı!', booking: { ...payload, checkedInAt: new Date() } })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}
