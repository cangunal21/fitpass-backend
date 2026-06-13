import { Request, Response, NextFunction } from 'express'

const ADMIN_SECRET = process.env.ADMIN_SECRET || 'fitpass-admin-2024'

export const adminAuthMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const secret = req.headers['x-admin-secret']
  if (!secret || secret !== ADMIN_SECRET) {
    return res.status(401).json({ error: 'Yetkisiz erişim.' })
  }
  next()
}
