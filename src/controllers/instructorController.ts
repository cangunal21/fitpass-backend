import { Request, Response } from 'express'
import prisma from '../utils/prisma'

// Hoca ekle
export const createInstructor = async (req: Request, res: Response) => {
  try {
    const venueId = (req as any).venueId
    const { fullName, specialty, bio, avatarUrl, phone, email } = req.body

    if (!fullName || !specialty) {
      return res.status(400).json({ error: 'Ad ve uzmanlık alanı zorunludur.' })
    }

    const instructor = await prisma.instructor.create({
      data: {
        fullName,
        specialty,
        bio: bio || null,
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

    const updated = await prisma.instructor.update({
      where: { id: instructorId },
      data: { fullName, specialty, bio, avatarUrl, phone, email }
    })

    return res.json({ message: 'Hoca güncellendi!', instructor: updated })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}
