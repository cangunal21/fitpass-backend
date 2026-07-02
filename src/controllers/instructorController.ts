import { Request, Response } from 'express'
import prisma from '../utils/prisma'
import { translateInstructorBio, translateSpecialty } from '../utils/translate'
import { clampStr } from '../utils/validate'

// Hoca ekle
export const createInstructor = async (req: Request, res: Response) => {
  try {
    const venueId = (req as any).venueId
    const { fullName, specialty, bio, avatarUrl, phone, email } = req.body

    if (!fullName || !specialty) {
      return res.status(400).json({ error: 'Ad ve uzmanlık alanı zorunludur.' })
    }

    // Metinleri çeviriden/kayıttan ÖNCE sınırla (AI maliyeti + DB şişmesi)
    const sName = clampStr(fullName, 80) || ''
    const sSpecialty = clampStr(specialty, 120) || ''
    const sBio = clampStr(bio, 1000) || null
    const specialtyEn = await translateSpecialty(sSpecialty)
    const bioEn = sBio ? await translateInstructorBio(sBio) : null

    const instructor = await prisma.instructor.create({
      data: {
        fullName: sName,
        specialty: sSpecialty,
        specialtyEn,
        bio: sBio,
        bioEn,
        avatarUrl: clampStr(avatarUrl, 500) || null,
        phone: clampStr(phone, 30) || null,
        email: clampStr(email, 200) || null,
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

    // Metinleri sınırla (AI maliyeti + DB şişmesi)
    const sSpecialty = specialty !== undefined ? clampStr(specialty, 120) : undefined
    const sBio = bio !== undefined ? clampStr(bio, 1000) : undefined
    // Değişen alanları yeniden çevir
    const specialtyEn = (sSpecialty && sSpecialty !== existing.specialty) ? await translateSpecialty(sSpecialty) : undefined
    const bioEn = (sBio && sBio !== existing.bio) ? await translateInstructorBio(sBio) : undefined

    const updated = await prisma.instructor.update({
      where: { id: instructorId },
      data: {
        fullName: fullName !== undefined ? clampStr(fullName, 80) : undefined,
        specialty: sSpecialty,
        bio: sBio,
        avatarUrl: avatarUrl !== undefined ? clampStr(avatarUrl, 500) : undefined,
        phone: phone !== undefined ? clampStr(phone, 30) : undefined,
        email: email !== undefined ? clampStr(email, 200) : undefined,
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
