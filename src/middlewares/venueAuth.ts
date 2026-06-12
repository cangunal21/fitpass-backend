import { Request, Response, NextFunction } from 'express'
import { verifyToken } from '../utils/jwt'

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
