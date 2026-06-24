import { Request, Response, NextFunction } from 'express'
import { verifyToken } from '../utils/jwt'
import prisma from '../utils/prisma'

export const venueAuthMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Yetkilendirme token\'ı gerekli.' })
  }

  const token = authHeader.split(' ')[1]

  try {
    const decoded = verifyToken(token) as any
    if (!decoded || decoded.role !== 'venue') {
      return res.status(401).json({ error: 'Geçersiz token.' })
    }
    ;(req as any).venueId = decoded.venueId
    next()
  } catch {
    return res.status(401).json({ error: 'Geçersiz veya süresi dolmuş token.' })
  }
}

// Sadece onaylanmış salonlar ders/seans/dropin ekleyebilir
export const venueApprovedMiddleware = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const venueId = (req as any).venueId
    const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { isApproved: true } })
    if (!venue?.isApproved) {
      return res.status(403).json({ error: 'Salonunuz henüz onaylanmadı. Onay sonrası ders ekleyebilirsiniz.' })
    }
    next()
  } catch {
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// İyzico alt-üye onayı ("verified") gerektiren işlemler (ders/seans/dropin ekleme, ödeme).
// Kapı yalnızca ödeme CANLI iken (PAYMENTS_LIVE=true) devreye girer; pre-launch'ta açık (test/demo serbest).
export const venueVerifiedMiddleware = async (req: Request, res: Response, next: NextFunction) => {
  if (process.env.PAYMENTS_LIVE !== 'true') return next()
  try {
    const venueId = (req as any).venueId
    const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { subMerchantStatus: true } })
    if (venue?.subMerchantStatus !== 'approved') {
      return res.status(403).json({ error: 'Ödeme/işyeri bilgileriniz onaylanmadan ders ekleyip ödeme alamazsınız. Panelden ödeme bilgilerinizi tamamlayın.' })
    }
    next()
  } catch {
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}
