import { Request, Response } from 'express'
import prisma from '../utils/prisma'
import { sendReportNotificationEmail } from '../utils/email'

// Kullanıcı başka bir kullanıcıyı (profil/avatar vb.) şikayet eder
export const reportUser = async (req: Request, res: Response) => {
  try {
    const reporterUserId = (req as any).userId
    const { username, reportedUserId, reason } = req.body

    // Hedefi username veya id ile bul
    let targetId: number | null = reportedUserId ? parseInt(reportedUserId) : null
    if (!targetId && username) {
      const target = await prisma.user.findFirst({
        where: { username: { equals: String(username).replace(/^@/, ''), mode: 'insensitive' } },
        select: { id: true },
      })
      targetId = target?.id ?? null
    }

    if (!targetId) return res.status(404).json({ error: 'Şikayet edilecek kullanıcı bulunamadı.' })
    if (targetId === reporterUserId) return res.status(400).json({ error: 'Kendinizi şikayet edemezsiniz.' })

    // Aynı kullanıcıya açık şikayet varsa tekrar oluşturma (spam önleme)
    const existing = await prisma.report.findFirst({
      where: { reporterUserId, reportedUserId: targetId, status: 'open' },
    })
    if (existing) return res.json({ message: 'Şikayetiniz zaten alındı, inceleniyor.' })

    const cleanReason = reason ? String(reason).slice(0, 500) : null
    await prisma.report.create({
      data: {
        reporterUserId,
        reportedUserId: targetId,
        reason: cleanReason,
      },
    })

    // Admin'e bildirim e-postası gönder (rezervasyonu/işlemi bloklama)
    try {
      const [reporter, reported] = await Promise.all([
        prisma.user.findUnique({ where: { id: reporterUserId }, select: { fullName: true, username: true } }),
        prisma.user.findUnique({ where: { id: targetId }, select: { fullName: true, username: true } }),
      ])
      await sendReportNotificationEmail(
        reporter?.fullName || 'Kullanıcı', reporter?.username || '',
        reported?.fullName || 'Kullanıcı', reported?.username || '',
        cleanReason,
      )
    } catch (mailErr) {
      console.error('Report mail error:', mailErr)
    }

    return res.status(201).json({ message: 'Şikayetiniz alındı. En kısa sürede incelenecek.' })
  } catch (err) {
    console.error('reportUser error:', err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// Admin: açık şikayetleri listele
export const getReports = async (req: Request, res: Response) => {
  try {
    const reports = await prisma.report.findMany({
      where: { status: 'open' },
      orderBy: { createdAt: 'asc' },
      include: {
        reporter: { select: { id: true, username: true, fullName: true } },
        reportedUser: { select: { id: true, username: true, fullName: true, avatarUrl: true, banned: true } },
      },
    })
    return res.json({ reports })
  } catch (err) {
    console.error('getReports error:', err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// Admin: şikayeti çöz (avatarı kaldır / kullanıcıyı banla / yoksay)
export const resolveReport = async (req: Request, res: Response) => {
  try {
    const reportId = parseInt(req.params.id as string)
    const { action } = req.body // 'remove_avatar' | 'ban' | 'dismiss'

    const report = await prisma.report.findUnique({ where: { id: reportId } })
    if (!report) return res.status(404).json({ error: 'Şikayet bulunamadı.' })

    if (action === 'remove_avatar') {
      await prisma.user.update({ where: { id: report.reportedUserId }, data: { avatarUrl: null } })
    } else if (action === 'ban') {
      await prisma.user.update({ where: { id: report.reportedUserId }, data: { banned: true } })
    } else if (action !== 'dismiss') {
      return res.status(400).json({ error: 'Geçersiz işlem.' })
    }

    const newStatus = action === 'dismiss' ? 'dismissed' : 'resolved'
    // Bu kullanıcıya ait tüm açık şikayetleri kapat (avatar kaldırma/ban hepsini çözer)
    if (action === 'remove_avatar' || action === 'ban') {
      await prisma.report.updateMany({
        where: { reportedUserId: report.reportedUserId, status: 'open' },
        data: { status: newStatus, resolvedAt: new Date() },
      })
    } else {
      await prisma.report.update({
        where: { id: reportId },
        data: { status: newStatus, resolvedAt: new Date() },
      })
    }

    return res.json({ message: 'Şikayet işleme alındı.' })
  } catch (err) {
    console.error('resolveReport error:', err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}
