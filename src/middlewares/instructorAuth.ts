import { Request, Response, NextFunction } from 'express'
import { verifyToken } from '../utils/jwt'
import prisma from '../utils/prisma'
import { cached } from '../utils/cache'

// Eğitmen (instructor) realm auth — venueAuthMiddleware'in aynası.
// GÜVENLİK: tek JWT_SECRET olduğu için realm izolasyonu YALNIZCA payload.role ile sağlanır.
// role !== 'instructor' ise reddet → salon/kullanıcı token'ı eğitmen uçlarına giremez; aynı şekilde
// eğitmen token'ı (role='instructor') venueAuthMiddleware'in role!=='venue' kapısında reddedilir →
// eğitmen SALON finans/check-in uçlarına yapısal olarak erişemez.
export const instructorAuthMiddleware = async (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Yetkilendirme token\'ı gerekli.' })
  }

  const token = authHeader.split(' ')[1]

  try {
    const decoded = verifyToken(token) as any
    if (!decoded || decoded.role !== 'instructor' || !decoded.instructorId) {
      return res.status(401).json({ error: 'Geçersiz token.' })
    }
    // Token 7 gün geçerli → login anındaki isActive'e güvenme; her istekte tazele (60sn cache, ucuz).
    // Silinmiş ya da pasifleştirilmiş eğitmen token'ı, süresi dolana kadar içeride kalmasın.
    const state = await cached(`instructorActive:${decoded.instructorId}`, 60000, async () => {
      const inst = await prisma.instructor.findUnique({ where: { id: decoded.instructorId }, select: { isActive: true } })
      return inst ? (inst.isActive ? 'active' : 'inactive') : 'missing'
    })
    if (state === 'missing') return res.status(401).json({ error: 'Geçersiz token.' })
    if (state === 'inactive') return res.status(403).json({ error: 'Eğitmen hesabınız aktif değil.' })
    ;(req as any).instructorId = decoded.instructorId
    next()
  } catch {
    return res.status(401).json({ error: 'Geçersiz veya süresi dolmuş token.' })
  }
}
