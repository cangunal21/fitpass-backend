import { Request, Response } from 'express'
import bcrypt from 'bcryptjs'
import prisma from '../utils/prisma'
import { generateToken } from '../utils/jwt'

// SALON KAYIT
export const venueRegister = async (req: Request, res: Response) => {
  try {
    const { name, email, password, phone, address, description, cityId, neighborhoodId, sportCategories, instructor } = req.body

    if (!name || !email || !password || !phone || !address) {
      return res.status(400).json({ error: 'Ad, email, şifre, telefon ve adres zorunludur.' })
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Şifre en az 6 karakter olmalı.' })
    }

    const existing = await prisma.venue.findUnique({ where: { email } })
    if (existing) {
      return res.status(400).json({ error: 'Bu email adresi zaten kullanılıyor.' })
    }

    const passwordHash = await bcrypt.hash(password, 12)

    const venue = await prisma.venue.create({
      data: {
        name,
        email,
        passwordHash,
        phone,
        address,
        description: description || null,
        cityId: cityId || null,
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
      for (const catName of sportCategories) {
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
          fullName: instructor.fullName,
          bio: null,
        }
      })
    }

    const token = generateToken({ venueId: venue.id, email: venue.email, role: 'venue' })

    return res.status(201).json({ message: 'Salon kaydı oluşturuldu! Onay bekleniyor.', token, venue })
  } catch (err) {
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

    const venue = await prisma.venue.findUnique({ where: { email } })
    if (!venue || !venue.passwordHash) {
      return res.status(401).json({ error: 'Email veya şifre hatalı.' })
    }

    const isValid = await bcrypt.compare(password, venue.passwordHash)
    if (!isValid) {
      return res.status(401).json({ error: 'Email veya şifre hatalı.' })
    }

    const token = generateToken({ venueId: venue.id, email: venue.email, role: 'venue' })

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
        description: true, isApproved: true, avgRating: true, totalReviews: true, createdAt: true,
        classes: {
          select: {
            id: true, title: true, category: true, basePrice: true, isActive: true,
            sessions: { select: { id: true, startsAt: true, endsAt: true, availableSpots: true, _count: { select: { bookings: true } } } }
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

// DERS EKLE
export const createClass = async (req: Request, res: Response) => {
  try {
    const venueId = (req as any).venueId
    const { title, description, category, basePrice, duration, capacity, instructorId } = req.body

    if (!title || !category || !basePrice || !duration || !capacity) {
      return res.status(400).json({ error: 'Tüm zorunlu alanları doldurun.' })
    }

    const newClass = await prisma.class.create({
      data: {
        title,
        description: description || null,
        category,
        basePrice: parseFloat(basePrice),
        duration: parseInt(duration),
        durationMinutes: parseInt(duration),
        capacity: parseInt(capacity),
        venueId,
        instructorId: instructorId || null,
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

    const updated = await prisma.class.update({
      where: { id: classId },
      data: {
        title, description, category,
        basePrice: basePrice ? parseFloat(basePrice) : undefined,
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

    if (!date || !time || !capacity) {
      return res.status(400).json({ error: 'Tarih, saat ve kapasite zorunludur.' })
    }

    const cls = await prisma.class.findUnique({ where: { id: classId } })
    if (!cls || cls.venueId !== venueId) {
      return res.status(403).json({ error: 'Bu derse seans ekleme yetkiniz yok.' })
    }

    const startsAt = new Date(`${date}T${time}:00`)
    const endsAt = new Date(startsAt.getTime() + (cls.durationMinutes || cls.duration || 60) * 60000)

    const session = await prisma.class_Session.create({
      data: {
        classId,
        startsAt,
        endsAt,
        availableSpots: parseInt(capacity),
      }
    })

    return res.status(201).json({ message: 'Seans oluşturuldu!', session })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// SALON RESERVASYONLARİ
export const getVenueBookings = async (req: Request, res: Response) => {
  try {
    const venueId = (req as any).venueId

    const bookings = await prisma.booking.findMany({
      where: { session: { class: { venueId } } },
      include: {
        user: { select: { id: true, fullName: true, email: true, username: true } },
        session: { include: { class: { select: { title: true, category: true } } } }
      },
      orderBy: { createdAt: 'desc' },
    })

    return res.json({ bookings })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}
