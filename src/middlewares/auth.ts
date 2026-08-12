import { Request, Response, NextFunction } from 'express'
import { verifyToken } from '../utils/jwt'
import prisma from '../utils/prisma'
import { cached, invalidate } from '../utils/cache'
import { localeFromReq, Locale } from '../utils/locale'

export interface AuthRequest extends Request {
  userId?: number
  userEmail?: string
}

// Kullanıcı token'ının o anki durumu — 60sn cache (ucuz; ban/silme anında invalidate edilebilir).
// 'ok' geçerli, 'banned' askıda, 'missing' hesap silinmiş/yok. authMiddleware + optionalAuth ortak.
// locale de burada taşınır → dil senkronu için AYRI bir sorgu açılmaz.
type UserAuthState = 'ok' | 'banned' | 'missing'
type AuthSnapshot = { state: UserAuthState; locale: Locale | null; pwAt: number | null }
async function userAuthSnapshot(userId: number): Promise<AuthSnapshot> {
  return cached(`authstate:${userId}`, 60000, async () => {
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { banned: true, locale: true, passwordChangedAt: true } })
    if (!u) return { state: 'missing' as UserAuthState, locale: null, pwAt: null }
    return {
      state: (u.banned ? 'banned' : 'ok') as UserAuthState,
      locale: (u.locale as Locale) || 'tr',
      pwAt: u.passwordChangedAt ? Math.floor(u.passwordChangedAt.getTime() / 1000) : null,
    }
  })
}

// DİL SENKRONU: istemci her istekte `X-Locale` yollar. Kullanıcının kayıtlı dili DEĞİŞTİYSE
// güncelleriz — böylece e-posta/push kullanıcının o anki arayüz diliyle gider.
// DİRTY-CHECK ŞART: okuma yolunda koşulsuz User write yapmak (eski syncUserTier hatası) her
// istekte bir yazma demekti. Burada yazma yalnız dil GERÇEKTEN değişince olur (yılda birkaç kez).
async function syncLocale(userId: number, snap: AuthSnapshot, req: Request) {
  const want = localeFromReq(req)
  if (!req.headers['x-locale']) return          // istemci dil bildirmiyorsa dokunma
  if (snap.locale === null || snap.locale === want) return
  await prisma.user.update({ where: { id: userId }, data: { locale: want } }).catch(() => {})
  invalidate(`authstate:${userId}`)             // cache'i düşür → sonraki istek yeni dili görsün
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
        // SİLİNEN KULLANICI: hesap silindiyse (JWT ~1sa hâlâ geçerli olabilir) state 'missing' döner →
        // viewer kimliği düşürülür (silinmiş id ile "giriş yapmış" muamelesi görmesin).
        const snap = await userAuthSnapshot(decoded.userId)
        const pwEski = !!(snap.pwAt && typeof decoded.iat === 'number' && decoded.iat < snap.pwAt)
        if (snap.state === 'ok' && !pwEski) (req as any).userId = decoded.userId
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
    // Banlanan kullanıcı geçerli token'la içeride kalmasın (60sn cache → ucuz; ban anında invalidate edilir).
    // Silinen kullanıcı da içeride kalmasın: hesabı silinince JWT ~1sa daha imzalı-geçerli olur; DB'de yoksa
    // req.userId silinmiş bir id'ye set edilir ve `where:{userId}` sorguları o id ile çalışır (çoğu boş/404
    // döner ama yeni bir aynı-id kaydı olsaydı karışırdı) → 'missing' ise 401.
    const snap = await userAuthSnapshot(decoded.userId)
    if (snap.state === 'banned') return res.status(403).json({ error: 'Hesabınız askıya alınmıştır.' })
    if (snap.state === 'missing') return res.status(401).json({ error: 'Geçersiz token.' })
    // PAROLA DEĞİŞİMİ ESKİ ACCESS TOKEN'LARI DA İPTAL EDER. Refresh jetonları zaten iptal
    // ediliyordu ama DAĞITILMIŞ access token JWT olduğu için iptal edilemiyordu: kurban
    // parolasını değiştirip "değiştirildi" mesajını gördükten sonra bile, çalınmış jeton
    // BİR SAAT daha tam yetkiyle çalışıyordu. Salon/eğitmen realm'lerinde bu kapı vardı.
    // Kesin küçüktür: parola değişimiyle aynı saniyede alınan taze token geçerli kalsın.
    if (snap.pwAt && typeof decoded.iat === 'number' && decoded.iat < snap.pwAt) {
      return res.status(401).json({ error: 'Şifreniz değiştirildi, lütfen tekrar giriş yapın.' })
    }
    // Dil değiştiyse kaydet (dirty-check'li; yazma yalnız gerçek değişimde) — bildirimler güncel dille gitsin.
    syncLocale(decoded.userId, snap, req).catch(() => {})
    req.userId = decoded.userId
    req.userEmail = decoded.email
    next()
  } catch {
    return res.status(401).json({ error: 'Geçersiz veya süresi dolmuş token.' })
  }
}
