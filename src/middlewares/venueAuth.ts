import { Request, Response, NextFunction } from 'express'
import { verifyToken } from '../utils/jwt'
import prisma from '../utils/prisma'

export const venueAuthMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Yetkilendirme token\'ı gerekli.' })
  }

  const token = authHeader.split(' ')[1]
  const decoded = verifyToken(token) as any

  if (!decoded || decoded.role !== 'venue') {
    return res.status(401).json({ error: 'Geçersiz token.' })
  }

  ;(req as any).venueId = decoded.venueId
  next()
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
