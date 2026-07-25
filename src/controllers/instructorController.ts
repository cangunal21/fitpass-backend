import { Request, Response } from 'express'
import crypto from 'crypto'
import prisma from '../utils/prisma'
import { translateInstructorBio, translateSpecialty } from '../utils/translate'
import { clampStr, isValidEmail } from '../utils/validate'
import { sendInstructorInviteEmail } from '../utils/email'

// Hoca ekle
export const createInstructor = async (req: Request, res: Response) => {
  try {
    const venueId = (req as any).venueId
    const { fullName, specialty, bio, avatarUrl, phone, email } = req.body

    if (!fullName || !specialty) {
      return res.status(400).json({ error: 'Ad ve uzmanlık alanı zorunludur.' })
    }

    // E-posta login kimliği → normalize + format + tekillik (login findFirst deterministik kalsın)
    const normEmail = clampStr(email, 200)?.toLowerCase().trim() || null
    if (normEmail && !isValidEmail(normEmail)) {
      return res.status(400).json({ error: 'Geçerli bir e-posta girin.' })
    }
    if (normEmail) {
      const dupe = await prisma.instructor.findFirst({ where: { email: normEmail }, select: { id: true } })
      if (dupe) return res.status(409).json({ error: 'Bu e-posta başka bir eğitmene ait.' })
    }

    // Metinleri çeviriden/kayıttan ÖNCE sınırla (AI maliyeti + DB şişmesi)
    const sName = clampStr(fullName, 80) || ''
    const sSpecialty = clampStr(specialty, 200) || ''
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
        email: normEmail,
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

    // select (include DEĞİL) → passwordHash salon sahibine SIZMASIN; davet için email/inviteStatus döner
    const instructors = await prisma.instructor.findMany({
      where: { venueId },
      select: {
        id: true, fullName: true, specialty: true, specialtyEn: true, bio: true, bioEn: true,
        avatarUrl: true, phone: true, email: true, inviteStatus: true,
        avgRating: true, totalReviews: true, isActive: true, verified: true, createdAt: true,
        _count: { select: { classes: true } },
      },
      orderBy: { createdAt: 'desc' },
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

    // E-posta değişiyorsa: normalize + format + BAŞKA eğitmene ait olmama (login tekilliği/kilitlenme
    // önleme). email login kimliği olduğu için invite/login ile aynı guard'lara tabi.
    let emailUpdate: string | null | undefined = undefined
    if (email !== undefined) {
      const norm = clampStr(email, 200)?.toLowerCase().trim() || null
      if (norm && !isValidEmail(norm)) {
        return res.status(400).json({ error: 'Geçerli bir e-posta girin.' })
      }
      if (norm) {
        const dupe = await prisma.instructor.findFirst({ where: { email: norm, id: { not: instructorId } }, select: { id: true } })
        if (dupe) return res.status(409).json({ error: 'Bu e-posta başka bir eğitmene ait.' })
      }
      emailUpdate = norm
    }

    // Metinleri sınırla (AI maliyeti + DB şişmesi)
    const sSpecialty = specialty !== undefined ? clampStr(specialty, 200) : undefined
    const sBio = bio !== undefined ? clampStr(bio, 1000) : undefined
    // EN karşılığı TR ile senkron: TEMİZLENİRSE null, dolu+değişmişse çevir, dolu+aynıysa dokunma
    const specialtyEn = sSpecialty === undefined ? undefined
      : (sSpecialty ? (sSpecialty !== existing.specialty ? await translateSpecialty(sSpecialty) : undefined) : null)
    const bioEn = sBio === undefined ? undefined
      : (sBio ? (sBio !== existing.bio ? await translateInstructorBio(sBio) : undefined) : null)

    const updated = await prisma.instructor.update({
      where: { id: instructorId },
      data: {
        fullName: fullName !== undefined ? clampStr(fullName, 80) : undefined,
        specialty: sSpecialty,
        bio: sBio,
        avatarUrl: avatarUrl !== undefined ? clampStr(avatarUrl, 500) : undefined,
        phone: phone !== undefined ? clampStr(phone, 30) : undefined,
        email: emailUpdate,
        ...(specialtyEn !== undefined ? { specialtyEn } : {}),
        ...(bioEn !== undefined ? { bioEn } : {}),
      },
      // select (include DEĞİL) → passwordHash salon sahibine SIZMASIN (getVenueInstructors ile aynı shape)
      select: {
        id: true, fullName: true, specialty: true, specialtyEn: true, bio: true, bioEn: true,
        avatarUrl: true, phone: true, email: true, inviteStatus: true,
        avgRating: true, totalReviews: true, isActive: true, verified: true, createdAt: true,
      },
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
      // Eğitmen giriş/davet token'ları FK ile bağlı → önce sil
      await tx.instructorPasswordResetToken.deleteMany({ where: { instructorId } })
      await tx.instructor.delete({ where: { id: instructorId } })
    })

    return res.json({ message: 'Hoca silindi.' })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// Eğitmene GİRİŞ DAVETİ gönder (venueAuth). Salon sahibi hocaya login açar: e-posta belirlenir,
// bir davet token'ı üretilir, davet maili gider. Davet linki yanıtta da döner (mail ulaşmazsa
// salon sahibi WhatsApp vb. ile paylaşabilir — salon sahibi zaten hocanın kaydını yönetiyor).
export const inviteInstructor = async (req: Request, res: Response) => {
  try {
    const venueId = (req as any).venueId
    const instructorId = parseInt(req.params.id as string)
    if (!instructorId || isNaN(instructorId)) return res.status(400).json({ error: 'Geçersiz hoca.' })

    const existing = await prisma.instructor.findUnique({ where: { id: instructorId } })
    if (!existing || existing.venueId !== venueId) {
      return res.status(403).json({ error: 'Bu hocaya davet gönderme yetkiniz yok.' })
    }

    const rawEmail = String(req.body.email ?? existing.email ?? '').toLowerCase().trim()
    if (!rawEmail || !isValidEmail(rawEmail)) {
      return res.status(400).json({ error: 'Geçerli bir e-posta gerekli.' })
    }
    // E-posta tekilliği UYGULAMA düzeyinde: başka bir eğitmene ait olmasın (login tekilliği için)
    const dupe = await prisma.instructor.findFirst({ where: { email: rawEmail, id: { not: instructorId } } })
    if (dupe) return res.status(409).json({ error: 'Bu e-posta başka bir eğitmene ait.' })

    const token = crypto.randomBytes(32).toString('hex')
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000)
    await prisma.$transaction([
      prisma.instructor.update({ where: { id: instructorId }, data: { email: rawEmail, inviteStatus: 'pending' } }),
      prisma.instructorPasswordResetToken.create({ data: { instructorId, token, expiresAt } }),
    ])

    const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { name: true } })
    sendInstructorInviteEmail(rawEmail, existing.fullName, venue?.name || 'Salonunuz', token).catch(e =>
      console.error('Instructor invite mail gönderilemedi:', e)
    )

    // GÜVENLİK: davet token'ı (tek-kullanımlık kimlik bilgisi — şifre belirleme yetkisi verir)
    // yanıtta DÖNMEZ, yalnız e-postayla iletilir. Salon sahibi tekrar göndermek isterse yeniden davet
    // eder (yeni token üretilir). Böylece token log/tarayıcı geçmişi/enumeration'a sızmaz.
    return res.json({ message: `Davet e-postası gönderildi: ${rawEmail}`, inviteStatus: 'pending' })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}
