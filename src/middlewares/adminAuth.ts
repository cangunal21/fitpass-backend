import { Request, Response, NextFunction } from 'express'
import crypto from 'crypto'

// Kaynağa GÖMÜLÜ varsayılan YOK — repo'ya commit'lenen bir default (ör. 'fitpass-admin-2024') NODE_ENV
// yanlış/eksik olan herhangi bir deploy'da admin'i herkese açardı. Secret yoksa aşağıda HER ortamda reddedilir.
const ADMIN_SECRET = process.env.ADMIN_SECRET || ''
const SECRET_CONFIGURED = ADMIN_SECRET.length > 0

// Uzunluk-güvenli + zamanlama-güvenli karşılaştırma (timing attack yüzeyini kapatır)
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return crypto.timingSafeEqual(ab, bb)
}

export const adminAuthMiddleware = (req: Request, res: Response, next: NextFunction) => {
  // ADMIN_SECRET set DEĞİLSE HER ortamda admin erişimini reddet (NODE_ENV'e bağlı değil — yanlış/eksik
  // NODE_ENV'li bir deploy'da gömülü default'la admin açığa çıkmasın). Operatörü gerçek secret koymaya zorlar.
  if (!SECRET_CONFIGURED) {
    return res.status(503).json({ error: 'Admin yapılandırılmamış.' })
  }
  const secret = req.headers['x-admin-secret']
  if (typeof secret !== 'string' || !safeEqual(secret, ADMIN_SECRET)) {
    return res.status(401).json({ error: 'Yetkisiz erişim.' })
  }
  next()
}
