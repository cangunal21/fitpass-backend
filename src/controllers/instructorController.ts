import { Request, Response } from 'express'
import prisma from '../utils/prisma'
import { translateInstructorBio, translateSpecialty } from '../utils/translate'

// Hoca ekle
export const createInstructor = async (req: Request, res: Response) => {
  try {
    const venueId = (req as any).venueId
    const { fullName, specialty, bio, avatarUrl, phone, email } = req.body

    if (!fullName || !specialty) {
      return res.status(400).json({ error: 'Ad ve uzmanlık alanı zorunludur.' })
    }

    // İngilizce kullanıcılar için otomatik AI çevirisi (best-effort; anahtar yoksa null)
    const specialtyEn = await translateSpecialty(specialty)
    const bioEn = bio ? await translateInstructorBio(bio) : null

    const instructor = await prisma.instructor.create({
      data: {
        fullName,
        specialty,
        specialtyEn,
        bio: bio || null,
        bioEn,
        avatarUrl: avatarUrl || null,
        phone: phone || null,
        email: email || null,
        venueId,
      }
    })

    return res.status(201).json({ message: 'Hoca eklendi!', instructor })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// Salonun hocalarını getir
export const getVenueInstructors = async (req: Request, res: Response) => {
  try {
    const venueId = (req as any).venueId

    const instructors = await prisma.instructor.findMany({
      where: { venueId },
      include: {
        _count: { select: { classes: true } }
      },
      orderBy: { createdAt: 'desc' }
    })

    return res.json({ instructors })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// Hoca güncelle
export const updateInstructor = async (req: Request, res: Response) => {
  try {
    const venueId = (req as any).venueId
    const instructorId = parseInt(req.params.id as string)
    const { fullName, specialty, bio, avatarUrl, phone, email } = req.body

    const existing = await prisma.instructor.findUnique({ where: { id: instructorId } })
    if (!existing || existing.venueId !== venueId) {
      return res.status(403).json({ error: 'Bu hocayı düzenleme yetkiniz yok.' })
    }

    // Değişen alanları yeniden çevir
    const specialtyEn = (specialty && specialty !== existing.specialty) ? await translateSpecialty(specialty) : undefined
    const bioEn = (bio && bio !== existing.bio) ? await translateInstructorBio(bio) : undefined

    const updated = await prisma.instructor.update({
      where: { id: instructorId },
      data: {
        fullName, specialty, bio, avatarUrl, phone, email,
        ...(specialtyEn !== undefined ? { specialtyEn } : {}),
        ...(bioEn !== undefined ? { bioEn } : {}),
      }
    })

    return res.json({ message: 'Hoca güncellendi!', instructor: updated })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// Hoca sil — bu hocaya bağlı ders/komisyon/yorum kayıtlarının instructorId'sini boşaltır
// (hepsi nullable FK), sonra hocayı siler. Dersler/kayıtlar DURUR, yalnızca hoca bağlantısı
// kalkar (salon o dersi başka hocaya atayabilir). Sahiplik kontrollü.
export const deleteInstructor = async (req: Request, res: Response) => {
  try {
    const venueId = (req as any).venueId
    const instructorId = parseInt(req.params.id as string)
    if (!instructorId || isNaN(instructorId)) return res.status(400).json({ error: 'Geçersiz hoca.' })

    const existing = await prisma.instructor.findUnique({ where: { id: instructorId }, select: { venueId: true } })
    if (!existing || existing.venueId !== venueId) {
      return res.status(403).json({ error: 'Bu hocayı silme yetkiniz yok.' })
    }

    await prisma.$transaction(async (tx) => {
      await tx.class.updateMany({ where: { instructorId }, data: { instructorId: null } })
      await tx.commissionHistory.updateMany({ where: { instructorId }, data: { instructorId: null } })
      await tx.review.updateMany({ where: { instructorId }, data: { instructorId: null } })
      await tx.instructor.delete({ where: { id: instructorId } })
    })

    return res.json({ message: 'Hoca silindi.' })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}
