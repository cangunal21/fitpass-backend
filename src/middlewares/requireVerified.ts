import { Request, Response, NextFunction } from 'express'
import prisma from '../utils/prisma'
import { cached } from '../utils/cache'

/**
 * E-POSTA DOĞRULAMA KAPISI
 *
 * NEDEN VAR: `isEmailVerified` tutuluyordu ama HİÇBİR uç onu sormuyordu. Yani biri BAŞKASININ
 * e-posta adresiyle kayıt olup platformu tam kullanabiliyordu: rezervasyon yapar, salonlara
 * yorum/puan yazar, sosyal akışta görünür, liderliğe çıkar. Kurban sonradan kendi adresiyle
 * kayıt olmaya çalıştığında "bu e-posta kullanımda" duvarına toslardı (adres işgali).
 *
 * NEREYE UYGULANIR — sadece BAŞKASINI ETKİLEYEN ya da KAYNAK TÜKETEN yazma uçlarına:
 * rezervasyon, yorum/puan, sosyal yazma, bekleme listesi. Okuma, profil düzenleme, çıkış ve
 * "kodu tekrar gönder" AÇIK kalır — aksi halde kodu ulaşmayan kullanıcı kendi hesabında
 * hiçbir şey yapamaz, kod bile isteyemez hâle gelirdi.
 *
 * NEDEN authMiddleware'e GÖMÜLMEDİ: gömülseydi kapsam "tüm girişli uçlar" olurdu ve doğrulama
 * bekleyen kullanıcı kendi profilini bile göremezdi. Kapı, kapsamı açıkça görünsün diye ayrı.
 *
 * PERFORMANS: durum 60 sn cache'lenir (authMiddleware'in authstate cache'iyle aynı desen).
 * Doğrulama anında invalidate edilir, kullanıcı beklemez.
 */
export const requireVerifiedEmail = async (req: Request, res: Response, next: NextFunction) => {
  const userId = (req as any).userId
  // Kimlik yoksa bu kapının işi yok — authMiddleware zaten önce koşuyor ve 401 veriyor.
  if (!userId) return next()

  try {
    const dogrulanmis = await cached(`emailverified:${userId}`, 60000, async () => {
      const u = await prisma.user.findUnique({ where: { id: userId }, select: { isEmailVerified: true } })
      return u?.isEmailVerified === true
    })
    if (!dogrulanmis) {
      // 403 + makine-okunur kod: istemci bunu görüp doğrulama kodu ekranını açar.
      return res.status(403).json({
        error: 'Bu işlem için e-posta adresini doğrulaman gerekiyor.',
        code: 'EMAIL_NOT_VERIFIED',
      })
    }
    return next()
  } catch {
    // DB hıçkırığında kullanıcıyı kilitlemektense geçir: bu kapı kimlik doğrulaması DEĞİL,
    // kötüye kullanımı zorlaştıran ikinci katman. authMiddleware zaten kimliği doğruladı.
    return next()
  }
}
