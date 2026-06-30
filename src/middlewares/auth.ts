import { Request, Response, NextFunction } from 'express'
import { verifyToken } from '../utils/jwt'
import prisma from '../utils/prisma'
import { cached } from '../utils/cache'

export interface AuthRequest extends Request {
  userId?: number
  userEmail?: string
}

export const optionalAuthMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1]
    try {
      const decoded = verifyToken(token) as any
      if (decoded) (req as any).userId = decoded.userId
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
    // Banlanan kullanıcı geçerli token'la içeride kalmasın (60sn cache → ucuz; ban anında invalidate edilir)
    if (decoded.userId) {
      const banned = await cached(`banned:${decoded.userId}`, 60000, async () => {
        const u = await prisma.user.findUnique({ where: { id: decoded.userId }, select: { banned: true } })
        return u?.banned ?? false
      })
      if (banned) return res.status(403).json({ error: 'Hesabınız askıya alınmıştır.' })
    }
    req.userId = decoded.userId
    req.userEmail = decoded.email
    next()
  } catch {
    return res.status(401).json({ error: 'Geçersiz veya süresi dolmuş token.' })
  }
}
