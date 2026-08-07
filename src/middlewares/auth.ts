import { Request, Response, NextFunction } from 'express'
import { verifyToken } from '../utils/jwt'
import prisma from '../utils/prisma'
import { cached } from '../utils/cache'

export interface AuthRequest extends Request {
  userId?: number
  userEmail?: string
}

// Kullanıcı token'ının o anki durumu — 60sn cache (ucuz; ban/silme anında invalidate edilebilir).
// 'ok' geçerli, 'banned' askıda, 'missing' hesap silinmiş/yok. authMiddleware + optionalAuth ortak.
type UserAuthState = 'ok' | 'banned' | 'missing'
async function userAuthState(userId: number): Promise<UserAuthState> {
  return cached(`authstate:${userId}`, 60000, async () => {
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { banned: true } })
    if (!u) return 'missing'
    return u.banned ? 'banned' : 'ok'
  })
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
        const state = await userAuthState(decoded.userId)
        if (state === 'ok') (req as any).userId = decoded.userId
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
    const state = await userAuthState(decoded.userId)
    if (state === 'banned') return res.status(403).json({ error: 'Hesabınız askıya alınmıştır.' })
    if (state === 'missing') return res.status(401).json({ error: 'Geçersiz token.' })
    req.userId = decoded.userId
    req.userEmail = decoded.email
    next()
  } catch {
    return res.status(401).json({ error: 'Geçersiz veya süresi dolmuş token.' })
  }
}
