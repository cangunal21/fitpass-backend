import { Request, Response, NextFunction } from 'express'
import { verifyToken } from '../utils/jwt'
import prisma from '../utils/prisma'
import { cached } from '../utils/cache'

export interface AuthRequest extends Request {
  userId?: number
  userEmail?: string
}

export const optionalAuthMiddleware = async (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1]
    try {
      const decoded = verifyToken(token) as any
      // Yalnız GERÇEK kullanıcı token'ı (userId taşıyan) → salon/eğitmen token'ı burada kullanıcı
      // sayılmasın (viewerId sızıntısı/karışması olmasın)
      if (decoded && decoded.userId) {
        // BAN KONTROLÜ: authMiddleware banlıyı reddediyor ama optionalAuth ETMİYORDU. Banlı kullanıcı
        // elindeki geçerli token'la, optionalAuth ile korunan okuma uçlarında "onaylı takipçi/giriş
        // yapmış" ayrıcalığını (gizli profil aktivitesi, takip-özel içerik) kullanmaya devam ediyordu.
        // Banlıysa viewer kimliğini DÜŞÜR → istek anonim/giriş-yapılmamış gibi işlenir.
        const banned = await cached(`banned:${decoded.userId}`, 60000, async () => {
          const u = await prisma.user.findUnique({ where: { id: decoded.userId }, select: { banned: true } })
          return u?.banned ?? false
        })
        if (!banned) (req as any).userId = decoded.userId
      }
    } catch {}
  }
  next()
}

export const authMiddleware = async (req: AuthRequest, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Giriş yapmanız gerekiyor.' })
  }

  const token = authHeader.split(' ')[1]

  try {
    const decoded = verifyToken(token)
    // GÜVENLİK: yalnız GERÇEK kullanıcı token'ı kabul edilir. Salon/eğitmen token'ı (userId taşımaz,
    // role='venue'|'instructor') buraya girmesin — aksi halde req.userId=undefined kalır ve
    // Prisma `where:{userId:undefined}` filtreyi YOK SAYIP tüm kullanıcıların verisini döndürür
    // (cross-user okuma/silme). Tek JWT_SECRET olduğu için realm izolasyonu bu kontrolle sağlanır.
    if (!decoded || !decoded.userId) {
      return res.status(401).json({ error: 'Geçersiz token.' })
    }
    // Banlanan kullanıcı geçerli token'la içeride kalmasın (60sn cache → ucuz; ban anında invalidate edilir)
    const banned = await cached(`banned:${decoded.userId}`, 60000, async () => {
      const u = await prisma.user.findUnique({ where: { id: decoded.userId }, select: { banned: true } })
      return u?.banned ?? false
    })
    if (banned) return res.status(403).json({ error: 'Hesabınız askıya alınmıştır.' })
    req.userId = decoded.userId
    req.userEmail = decoded.email
    next()
  } catch {
    return res.status(401).json({ error: 'Geçersiz veya süresi dolmuş token.' })
  }
}
