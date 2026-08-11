import { Request, Response, NextFunction } from 'express'
import { verifyToken } from '../utils/jwt'
import prisma from '../utils/prisma'
import { cached } from '../utils/cache'

export const venueAuthMiddleware = async (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Yetkilendirme token\'ı gerekli.' })
  }

  const token = authHeader.split(' ')[1]

  try {
    const decoded = verifyToken(token) as any
    // GÜVENLİK: venueId'nin VARLIĞINI de zorla (authMiddleware/instructorAuth ile aynı desen).
    // Yalnız role kontrol edilip venueId undefined kalırsa, tüm venue uçlarındaki `where:{venueId}`
    // filtresi Prisma'da YOK SAYILIR → tüm salonların verisi (rezervasyon/gelir/kupon/hoca/drop-in)
    // dökülür. venueId'siz token (forge/misconfig) burada reddedilerek beş uç birden korunur.
    if (!decoded || decoded.role !== 'venue' || !decoded.venueId) {
      return res.status(401).json({ error: 'Geçersiz token.' })
    }
    // HESAP-DURUMU TAZELE (instructorAuth ile aynı): venue token'ı 7 gün geçerli → login anındaki
    // duruma güvenme. Askıya alınan/pasif/silinen salonun token'ı OKUMA uçlarında (gelir/IBAN/TCKN/
    // rezervasyon) süresi dolana kadar kalmasın. 60sn cache (ucuz). suspendVenue cache'i geçersiz kılar.
    const state = await cached(`venueState:${decoded.venueId}`, 60000, async () => {
      const v = await prisma.venue.findUnique({ where: { id: decoded.venueId }, select: { isActive: true, isSuspended: true, passwordChangedAt: true } })
      if (!v) return { s: 'missing' as const, pwAt: null as number | null }
      return {
        s: (v.isSuspended || v.isActive === false) ? ('inactive' as const) : ('active' as const),
        // saniyeye yuvarla: JWT iat saniye cinsinden
        pwAt: v.passwordChangedAt ? Math.floor(v.passwordChangedAt.getTime() / 1000) : null,
      }
    })
    if (state.s === 'missing') return res.status(401).json({ error: 'Geçersiz token.' })
    if (state.s === 'inactive') return res.status(403).json({ error: 'Salonunuz askıya alınmış veya pasif.' })
    // PAROLA DEĞİŞİMİ ESKİ TOKEN'LARI İPTAL EDER. Salon token'ı 7 gün geçerli ve refresh-token
    // tablosu yok; bu karşılaştırma olmadan ele geçirilmiş bir oturum, parola sıfırlansa bile
    // 7 gün boyunca IBAN/TCKN okumaya ve ders silmeye devam ediyordu (kullanıcı realm'i bunu
    // zaten doğru yapıyor: authController parola yazmasıyla aynı transaction'da refresh'leri iptal ediyor).
    // Kesin küçüktür: parola değişimiyle AYNI saniyede alınan taze token geçerli kalsın.
    if (state.pwAt && typeof decoded.iat === 'number' && decoded.iat < state.pwAt) {
      return res.status(401).json({ error: 'Şifreniz değiştirildi, lütfen tekrar giriş yapın.' })
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
    const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { isApproved: true, isActive: true } })
    if (!venue?.isApproved) {
      return res.status(403).json({ error: 'Salonunuz henüz onaylanmadı. Onay sonrası ders ekleyebilirsiniz.' })
    }
    // Donmuş (askıya alınmış) salon, login sonrası suspend edilse ve elinde geçerli token
    // olsa bile YENİ ders/seans/dropin ekleyemez (venueLogin sadece yeni girişi engelliyordu).
    if (venue.isActive === false) {
      return res.status(403).json({ error: 'Salonunuz askıya alınmıştır. Destek için admin@sipsakspor.com ile iletişime geçin.' })
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
