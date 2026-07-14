import { Request, Response, NextFunction } from 'express'
import crypto from 'crypto'

const ADMIN_SECRET = process.env.ADMIN_SECRET || 'fitpass-admin-2024'
const SECRET_CONFIGURED = !!process.env.ADMIN_SECRET

// Uzunluk-güvenli + zamanlama-güvenli karşılaştırma (timing attack yüzeyini kapatır)
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return crypto.timingSafeEqual(ab, bb)
}

export const adminAuthMiddleware = (req: Request, res: Response, next: NextFunction) => {
  // Prod'da ADMIN_SECRET set edilmemişse zayıf VARSAYILAN geçerli olur → admin fiilen herkese açık
  // kalır. Bu durumda tüm admin erişimini reddet (operatörü gerçek secret koymaya zorla).
  if (process.env.NODE_ENV === 'production' && !SECRET_CONFIGURED) {
    return res.status(503).json({ error: 'Admin yapılandırılmamış.' })
  }
  const secret = req.headers['x-admin-secret']
  if (typeof secret !== 'string' || !safeEqual(secret, ADMIN_SECRET)) {
    return res.status(401).json({ error: 'Yetkisiz erişim.' })
  }
  next()
}
