import { Request, Response } from 'express'
import bcrypt from 'bcryptjs'
import crypto from 'crypto'
import prisma from '../utils/prisma'
import { generateToken } from '../utils/jwt'
import { issueRefreshToken, rotateAccessToken, revokeRefreshToken } from '../utils/refreshToken'
import { sendWelcomeEmail, sendPasswordResetEmail, sendEmailVerificationEmail, sendBadgeEmail } from '../utils/email'
import { applyReferralCode } from './referralController'
import { syncUserTier, resetYearlyPointsIfNeeded } from '../utils/tier'
import { syncUserBadges } from '../utils/badges'
import { seasonLabelsFromKey } from '../utils/season'
import { purgeUserReviews, purgeUserComments } from '../utils/moderation'
import { invalidate } from '../utils/cache'
import { sendPushNotification } from '../utils/push'
import { MIN_PASSWORD, clampStr, isValidEmail, parseIntSafe } from '../utils/validate'

// KAYIT OL
export const register = async (req: Request, res: Response) => {
  try {
    const { username, email, phone, password, fullName, referralCode, preferredSports, preferredNeighborhoods } = req.body
    const cleanSports = Array.isArray(preferredSports) ? preferredSports.filter((s: any) => typeof s === 'string').slice(0, 20) : []
    const cleanNeighborhoods = Array.isArray(preferredNeighborhoods) ? preferredNeighborhoods.map((n: any) => parseInt(n)).filter((n: any) => !isNaN(n)).slice(0, 20) : []

    if (!username || !email || !password || !fullName) {
      return res.status(400).json({ error: 'Tüm zorunlu alanları doldurun.' })
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Geçerli bir e-posta adresi girin.' })
    }

    if (password.length < MIN_PASSWORD) {
      return res.status(400).json({ error: `Şifre en az ${MIN_PASSWORD} karakter olmalı.` })
    }

    // Kullanıcı adı formatı: 3-30 karakter, sadece harf/rakam/nokta/alt çizgi.
    // (Boşluk, /, @, unicode vb. profil URL'lerini bozar + impersonation riski.)
    const uname = String(username).trim()
    if (!/^[a-zA-Z0-9._]{3,30}$/.test(uname)) {
      return res.status(400).json({ error: 'Kullanıcı adı 3-30 karakter olmalı; yalnızca harf, rakam, nokta ve alt çizgi.' })
    }
    // E-posta case-insensitive: normalize (Ali@X.com = ali@x.com) → çift hesap + giriş uyumsuzluğu önlenir
    const cleanEmail = String(email).trim().toLowerCase()

    // Mevcut kullanıcı kontrolü (case-insensitive — "Ali"/"ali" veya "A@x"/"a@x" çakışsın)
    const existingUser = await prisma.user.findFirst({
      where: { OR: [{ email: { equals: cleanEmail, mode: 'insensitive' } }, { username: { equals: uname, mode: 'insensitive' } }] }
    })

    if (existingUser) {
      if (existingUser.email.toLowerCase() === cleanEmail) {
        return res.status(400).json({ error: 'Bu e-posta zaten kullanılıyor.' })
      }
      return res.status(400).json({ error: 'Bu kullanıcı adı zaten alınmış.' })
    }

    const passwordHash = await bcrypt.hash(password, 12)

    const user = await prisma.user.create({
      data: {
        username: uname,
        email: cleanEmail,
        phone: clampStr(phone, 30) || null,
        passwordHash,
        fullName: clampStr(fullName, 80) || '',
        tierId: 1, // Aday tier (pointRate %1) — atanmazsa ilk getMe'ye kadar tier null → ilk booking pointRate 0
        tierSportCounts: {},
        preferredSports: cleanSports,
        preferredNeighborhoods: cleanNeighborhoods,
        // İlk tercih mahallesi varsa kullanıcının mahallesi olarak da ata
        neighborhoodId: cleanNeighborhoods[0] || undefined,
        cityId: cleanNeighborhoods[0] ? 1 : undefined,
      },
      select: {
        id: true,
        username: true,
        email: true,
        fullName: true,
        createdAt: true,
      }
    })

    const token = generateToken({ userId: user.id, email: user.email })

    // Email doğrulama tokeni oluştur ve gönder
    const verifyToken = crypto.randomBytes(32).toString('hex')
    const verifyExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000)
    await prisma.emailVerificationToken.create({
      data: { userId: user.id, token: verifyToken, expiresAt: verifyExpiresAt }
    })
    sendEmailVerificationEmail(user.email, user.fullName, verifyToken).catch(err => console.error('Verify mail gönderilemedi:', err))

    // Referral kodu varsa uygula
    if (referralCode) {
      applyReferralCode(user.id, referralCode.trim().toUpperCase()).catch(() => {})
    }

    const refreshToken = await issueRefreshToken(user.id)
    return res.status(201).json({
      message: 'Kayıt başarılı! Email adresinize doğrulama linki gönderildi.',
      token,
      refreshToken,
      user,
      emailVerificationSent: true,
    })
  } catch (error: any) {
    if (error?.code === 'P2002') {
      return res.status(400).json({ error: 'Bu e-posta veya kullanıcı adı zaten kullanılıyor.' })
    }
    console.error('Register error:', error)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// GİRİŞ YAP
const DUMMY_HASH = bcrypt.hashSync('sipsakspor-timing-guard', 12) // hesap-enumerasyonu timing oracle'ını kapatır

export const login = async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body

    if (!email || !password) {
      return res.status(400).json({ error: 'E-posta ve şifre gerekli.' })
    }

    // PERFORMANS: `mode:'insensitive'` Prisma'da ILIKE üretir ve User.email üzerindeki @unique btree
    // index'i KULLANILAMAZ → her giriş/şifre-sıfırlama isteği tüm User tablosunu tarardı.
    // Kayıt e-postayı küçük harfle sakladığından (cleanEmail) hızlı yol findUnique ile index'e düşer;
    // normalizasyon öncesi kalmış olabilecek eski karışık-harfli kayıtlar için insensitive yedek korunur.
    const cleanEmail = String(email).trim().toLowerCase()
    const user = await prisma.user.findUnique({ where: { email: cleanEmail } })
      ?? await prisma.user.findFirst({ where: { email: { equals: cleanEmail, mode: 'insensitive' } } })

    if (!user) {
      await bcrypt.compare(String(password), DUMMY_HASH).catch(() => {}) // timing'i eşitle (enumeration önleme — eğitmen realm'iyle aynı)
      return res.status(401).json({ error: 'E-posta veya şifre hatalı.' })
    }

    const isValid = await bcrypt.compare(password, user.passwordHash)

    if (!isValid) {
      return res.status(401).json({ error: 'E-posta veya şifre hatalı.' })
    }

    if (user.banned) {
      return res.status(403).json({ error: 'Hesabınız askıya alınmıştır. Destek ile iletişime geçin.' })
    }

    const token = generateToken({ userId: user.id, email: user.email })
    const refreshToken = await issueRefreshToken(user.id)

    return res.json({
      message: 'Giriş başarılı!',
      token,
      refreshToken,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        fullName: user.fullName,
        avatarUrl: user.avatarUrl,
      }
    })
  } catch (error) {
    console.error('Login error:', error)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// ACCESS TOKEN YENİLE — refresh token ile yeni access token (kullanıcı çıkış görmez)
export const refreshAccessToken = async (req: Request, res: Response) => {
  try {
    const { refreshToken } = req.body
    const newToken = await rotateAccessToken(String(refreshToken || ''))
    if (!newToken) return res.status(401).json({ error: 'Oturum süresi doldu, tekrar giriş yapın.' })
    return res.json({ token: newToken })
  } catch (err) {
    console.error('Refresh error:', err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// ÇIKIŞ — refresh token'ı iptal et (artık yenileme yapamaz)
export const logout = async (req: Request, res: Response) => {
  try {
    const { refreshToken } = req.body
    if (refreshToken) {
      // Cihazın push token'ını sahibinden temizle — çıkış sonrası bu cihaza bildirim gitmesin
      // (ve sonraki kullanıcı girip kendi token'ını kaydedene kadar boşta kalsın).
      const rt = await prisma.refreshToken.findUnique({ where: { token: String(refreshToken) }, select: { userId: true } }).catch(() => null)
      if (rt?.userId) await prisma.user.update({ where: { id: rt.userId }, data: { pushToken: null } }).catch(() => {})
      await revokeRefreshToken(String(refreshToken))
    }
    return res.json({ message: 'Çıkış yapıldı.' })
  } catch {
    return res.json({ message: 'Çıkış yapıldı.' })
  }
}

// BENİ GETİR
export const getMe = async (req: Request & { userId?: number }, res: Response) => {
  try {
    if (req.userId) {
      try {
        await syncUserTier(req.userId)
        await resetYearlyPointsIfNeeded(req.userId)
        const newBadges = await syncUserBadges(req.userId)
        // Yeni rozet kazanıldıysa bildir (push + e-posta + uygulama içi)
        if (newBadges.length > 0) {
          const u = await prisma.user.findUnique({ where: { id: req.userId }, select: { pushToken: true, email: true, fullName: true, emailReminders: true } })
          const msg = newBadges.length === 1
            ? `"${newBadges[0]}" rozetini kazandın! 🎉`
            : `${newBadges.length} yeni rozet kazandın! 🎉`
          await prisma.notification.create({ data: { userId: req.userId, type: 'badge', message: msg } }).catch(() => {})
          if (u?.pushToken) sendPushNotification(u.pushToken, 'Yeni rozet! 🏅', msg).catch(() => {})
          if (u?.email && u.emailReminders !== false) sendBadgeEmail(u.email, u.fullName, newBadges).catch(() => {}) // opt-out saygı (cashback/streak ile tutarlı)
        }
      } catch (e) {
        console.error('Tier/badge sync error:', e)
      }
    }

    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: {
        id: true,
        username: true,
        email: true,
        fullName: true,
        avatarUrl: true,
        bio: true,
        phone: true,
        totalLessonsCompleted: true,
        rewardPoints: true,
        recordStreak: true,
        profilePrivacy: true,
        activityPrivacy: true,
        emailReminders: true,
        isEmailVerified: true,
        createdAt: true,
        neighborhood: { select: { name: true } },
        neighborhoodId: true,
        preferredSports: true,
        preferredNeighborhoods: true,
        city: { select: { name: true } },
        tier: { select: { name: true, pointRate: true, colorHex: true, iconUrl: true } },
        badges: {
          select: {
            id: true,
            earnedAt: true,
            rank: true,
            seasonKey: true,
            scopeType: true,
            scopeId: true,
            badge: { select: { key: true, name: true, description: true, iconUrl: true } },
            sportCategory: { select: { name: true } },
          },
          orderBy: { earnedAt: 'desc' },
        },
      }
    })

    if (!user) {
      return res.status(404).json({ error: 'Kullanıcı bulunamadı.' })
    }

    // Sezon şampiyonu rozetlerine kapsam adı (il/ilçe) + sezon etiketi (TR/EN) ekle
    const champs = (user.badges as any[]).filter(b => b.badge?.key === 'season_champion')
    if (champs.length) {
      const nbIds = [...new Set(champs.filter(c => c.scopeType === 'district').map(c => c.scopeId))] as number[]
      const cityIds = [...new Set(champs.filter(c => c.scopeType === 'city').map(c => c.scopeId))] as number[]
      const [nbs, cities] = await Promise.all([
        nbIds.length ? prisma.neighborhood.findMany({ where: { id: { in: nbIds } }, select: { id: true, name: true } }) : Promise.resolve([]),
        cityIds.length ? prisma.city.findMany({ where: { id: { in: cityIds } }, select: { id: true, name: true } }) : Promise.resolve([]),
      ])
      const nbMap = new Map(nbs.map(n => [n.id, n.name]))
      const cityMap = new Map(cities.map(c => [c.id, c.name]))
      for (const c of champs) {
        c.scopeName = c.scopeType === 'district' ? (nbMap.get(c.scopeId) || '') : (cityMap.get(c.scopeId) || '')
        const s = seasonLabelsFromKey(c.seasonKey)
        c.seasonLabel = s.label
        c.seasonLabelEn = s.labelEn
      }
    }

    return res.json({ user })
  } catch (error) {
    console.error('GetMe error:', error)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// ŞİFRE SIFIRLAMA - EMAIL GÖNDER
export const forgotPassword = async (req: Request, res: Response) => {
  try {
    const { email } = req.body

    // PERFORMANS: `mode:'insensitive'` Prisma'da ILIKE üretir ve User.email üzerindeki @unique btree
    // index'i KULLANILAMAZ → her giriş/şifre-sıfırlama isteği tüm User tablosunu tarardı.
    // Kayıt e-postayı küçük harfle sakladığından (cleanEmail) hızlı yol findUnique ile index'e düşer;
    // normalizasyon öncesi kalmış olabilecek eski karışık-harfli kayıtlar için insensitive yedek korunur.
    const cleanEmail = String(email).trim().toLowerCase()
    const user = await prisma.user.findUnique({ where: { email: cleanEmail } })
      ?? await prisma.user.findFirst({ where: { email: { equals: cleanEmail, mode: 'insensitive' } } })

    if (!user) {
      return res.json({ message: 'Email gönderildi' })
    }

    const token = crypto.randomBytes(32).toString('hex')
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000)

    await prisma.passwordResetToken.create({
      data: { userId: user.id, token, expiresAt }
    })

    sendPasswordResetEmail(user.email, user.fullName, token).catch(err =>
      console.error('Reset mail gönderilemedi:', err)
    )

    return res.json({ message: 'Email gönderildi' })
  } catch (error) {
    console.error('ForgotPassword error:', error)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// ŞİFRE SIFIRLAMA - YENİ ŞİFRE BELİRLE
export const resetPassword = async (req: Request, res: Response) => {
  try {
    const { token, password } = req.body

    // GÜVENLİK: token doğrulanmazsa `where:{token:undefined}` Prisma'da filtreyi YOK SAYAR →
    // findFirst BAŞKA bir kullanıcının geçerli token'ını döndürür → o kurbanın şifresi ezilir
    // (hesap ele geçirme). Bu yüzden query'den ÖNCE token varlığı+tipi kesinlikle kontrol edilir.
    if (!token || typeof token !== 'string') {
      return res.status(400).json({ error: 'Geçersiz veya süresi dolmuş sıfırlama linki.' })
    }
    if (!password || password.length < MIN_PASSWORD) {
      return res.status(400).json({ error: `Şifre en az ${MIN_PASSWORD} karakter olmalı.` })
    }

    const resetToken = await prisma.passwordResetToken.findFirst({
      where: {
        token,
        used: false,
        expiresAt: { gt: new Date() }
      }
    })

    if (!resetToken) {
      return res.status(400).json({ error: 'Geçersiz veya süresi dolmuş token' })
    }

    const passwordHash = await bcrypt.hash(password, 12)

    // ÜÇÜ TEK TRANSACTION'DA. Eskiden üç ayrı otomatik-commit yazmaydı ve iki sorun vardı:
    //  1) Araya giren bir giriş: T2 eski parolayla doğrulamayı geçmişken T1 parolayı değiştirip
    //     süpürgeyi çalıştırıyor, T2 SÜPÜRGEDEN SONRA yeni bir refresh token yazıyordu. Sonuç:
    //     parola değiştirildikten sonra doğmuş, revoked=false, 180 gün geçerli bir oturum.
    //     rotateAccessToken (utils/refreshToken.ts) yalnız revoked/expiresAt bakar, parola
    //     sürümüne bakmaz → hesabı ele geçiren kişi parola sıfırlamasına RAĞMEN içeride kalıyordu.
    //  2) Süpürge `.catch(() => {})` ile sarılıydı: başarısız olursa SESSİZCE yutuluyor,
    //     kullanıcı "şifren güncellendi" görürken tüm eski oturumlar açık kalıyordu.
    // Token tüketimi de aynı transaction'da CAS ile yapılıyor (used:false koşulu) → aynı
    // sıfırlama bağlantısına iki kez tıklanması ikinci kez parola yazmaz.
    const ok = await prisma.$transaction(async (tx) => {
      const claim = await tx.passwordResetToken.updateMany({
        where: { id: resetToken.id, used: false },
        data: { used: true },
      })
      if (claim.count === 0) return false // token bu arada başka bir istekçe tüketildi
      await tx.user.update({ where: { id: resetToken.userId }, data: { passwordHash } })
      await tx.refreshToken.updateMany({ where: { userId: resetToken.userId, revoked: false }, data: { revoked: true } })
      return true
    })
    if (!ok) return res.status(400).json({ error: 'Geçersiz veya süresi dolmuş token' })

    // Süpürge transaction'ı commit ettikten SONRA doğmuş olabilecek oturumları da kapat:
    // eşzamanlı bir giriş, tx görünürlüğü dışında token yazmış olabilir. İkinci süpürge
    // ucuz ve idempotent; parola değişiminden sonra hiçbir eski oturum ayakta kalmamalı.
    await prisma.refreshToken.updateMany({ where: { userId: resetToken.userId, revoked: false }, data: { revoked: true } })

    return res.json({ message: 'Şifre güncellendi' })
  } catch (error) {
    console.error('ResetPassword error:', error)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// PROFİL GÜNCELLE
export const updateProfile = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId
    const { fullName, bio, neighborhoodId, avatarUrl } = req.body

    const data: any = {}
    if (fullName !== undefined) data.fullName = clampStr(fullName, 80)
    if (bio !== undefined) data.bio = clampStr(bio, 500)
    if (avatarUrl !== undefined) data.avatarUrl = clampStr(avatarUrl, 500)
    if (neighborhoodId !== undefined) {
      // parseInt yerine parseIntSafe: 'abc'/taşma/NaN doğrudan Prisma'ya gidip 500 veriyordu.
      const nb = parseIntSafe(neighborhoodId)
      if (nb === undefined) return res.status(400).json({ error: 'Geçersiz mahalle.' })
      data.neighborhoodId = nb
      data.cityId = 1
    }

    const user = await prisma.user.update({
      where: { id: userId },
      data,
      select: { id: true, fullName: true, bio: true, avatarUrl: true, neighborhoodId: true, neighborhood: { select: { name: true } } }
    })
    return res.json({ message: 'Profil güncellendi.', user })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// GİZLİLİK AYARINI GÜNCELLE
export const updatePrivacy = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId
    const { activityPrivacy, profilePrivacy } = req.body

    const data: any = {}
    if (activityPrivacy !== undefined) {
      if (!['public', 'private'].includes(activityPrivacy)) return res.status(400).json({ error: 'Geçersiz gizlilik ayarı.' })
      data.activityPrivacy = activityPrivacy
    }
    if (profilePrivacy !== undefined) {
      // Gizli hesap: yeni takipler istek (pending) olur; herkese açık: doğrudan kabul
      if (!['public', 'private'].includes(profilePrivacy)) return res.status(400).json({ error: 'Geçersiz gizlilik ayarı.' })
      data.profilePrivacy = profilePrivacy
    }
    if (Object.keys(data).length === 0) return res.status(400).json({ error: 'Geçersiz gizlilik ayarı.' })

    const user = await prisma.user.update({
      where: { id: userId },
      data,
      select: { id: true, activityPrivacy: true, profilePrivacy: true }
    })

    return res.json({ message: 'Gizlilik ayarı güncellendi.', user })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// HESAP SİL — kullanıcı kendi hesabını kalıcı siler. Parola onayı + tüm ilişkili veri temizliği.
export const deleteAccount = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId
    const { password } = req.body

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { passwordHash: true } })
    if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' })

    // Güvenlik: çalınan token'la silme olmasın → parola doğrulaması zorunlu
    if (!password || !(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).json({ error: 'Hesabı silmek için mevcut şifrenizi doğru girin.' })
    }

    await prisma.$transaction(async (tx) => {
      // Drop-in sayaçlarını düzelt (silinen katılımcı slotu dolu göstermesin)
      const dps = await tx.dropInParticipant.findMany({ where: { userId, status: 'confirmed' }, select: { slotId: true } })
      for (const dp of dps) {
        await tx.dropInSlot.update({ where: { id: dp.slotId }, data: { currentPlayers: { decrement: 1 } } }).catch(() => {})
      }

      // Booking'lerin FK'lı çocukları (Payment/Commission), review'lar bookingId'ye bağlı
      const bookings = await tx.booking.findMany({ where: { userId }, select: { id: true } })
      const bookingIds = bookings.map(b => b.id)
      if (bookingIds.length) {
        await tx.payment.deleteMany({ where: { bookingId: { in: bookingIds } } })
        await tx.commissionHistory.deleteMany({ where: { bookingId: { in: bookingIds } } })
      }
      // Kullanıcının yazdığı yorumlar (kendi booking'lerine ait) — bookingId FK'sından önce.
      // Salon/eğitmen puan ortalamaları da yeniden hesaplanır (hayalet puan kalmasın).
      await purgeUserReviews(tx, userId)

      // Kullanıcının feed yorumları — yanıtların parent'ı boşaltılıp silinir
      await purgeUserComments(tx, userId)

      // Doğrudan userId'ye bağlı tüm çocuklar (ActivityLog booking'lerden ÖNCE — bookingId FK'sı)
      await tx.activityLike.deleteMany({ where: { userId } })
      await tx.activityLog.deleteMany({ where: { userId } })
      await tx.userBadge.deleteMany({ where: { userId } })
      await tx.userTierHistory.deleteMany({ where: { userId } })
      await tx.monthlyLeaderboard.deleteMany({ where: { userId } })
      await tx.rewardPoint.deleteMany({ where: { userId } })
      await tx.rewardRedemption.deleteMany({ where: { userId } })
      await tx.waitlist.deleteMany({ where: { userId } })
      await tx.favoriteVenue.deleteMany({ where: { userId } })
      await tx.dropInParticipant.deleteMany({ where: { userId } })
      await tx.chatMessage.deleteMany({ where: { userId } })
      await tx.passwordResetToken.deleteMany({ where: { userId } })
      await tx.emailVerificationToken.deleteMany({ where: { userId } })
      // Refresh token'lar userId FK'sıyla User'a bağlı → kullanıcı silinmeden ÖNCE temizlenmeli.
      // (Aksi halde giriş/kayıt yapmış GERÇEK kullanıcı hesabını silerken FK ihlali → 500.
      //  Ana test kullanıcısı upsert'le token'sız oluştuğundan bu boşluk gizli kalmıştı.)
      await tx.refreshToken.deleteMany({ where: { userId } })

      // Çift yönlü ilişkiler
      await tx.follow.deleteMany({ where: { OR: [{ followerId: userId }, { followingId: userId }] } })
      await tx.notification.deleteMany({ where: { OR: [{ userId }, { relatedUserId: userId }] } })
      // Bu kullanıcıyı DAVET EDEN kişilerin referralCount'unu geri düş (davet hakkı iade edilsin;
      // aksi halde davet edilen hesabını silince davet eden kalıcı olarak davet slotu kaybederdi)
      const invitedBy = await tx.referral.findMany({ where: { referredId: userId }, select: { referrerId: true } })
      for (const rid of [...new Set(invitedBy.map(r => r.referrerId))]) {
        await tx.user.updateMany({ where: { id: rid, referralCount: { gt: 0 } }, data: { referralCount: { decrement: 1 } } })
      }
      // FARMING ENGELİ: silinen kullanıcı DAVET EDİLEN ve referral TAMAMLANMIŞSA, davet edene verilmiş +100 puanı
      // geri al. Aksi halde: davet-koduyla kayıt → ücretli ders (referrer +100) → hesabı sil → tekrarla = sınırsız
      // puan farming. Puanı negatife düşürmeden (clamp) geri alınır + ledger'a negatif kayıt (izlenebilirlik).
      const REFERRAL_POINTS = 100 // referralController ile senkron
      const completedAsReferred = await tx.referral.findMany({ where: { referredId: userId, status: 'completed' }, select: { referrerId: true } })
      for (const rr of completedAsReferred) {
        const ref = await tx.user.findUnique({ where: { id: rr.referrerId }, select: { rewardPoints: true } })
        if (!ref) continue
        const dec = Math.min(REFERRAL_POINTS, ref.rewardPoints)
        if (dec > 0) {
          await tx.user.update({ where: { id: rr.referrerId }, data: { rewardPoints: { decrement: dec } } })
          await tx.rewardPoint.create({ data: { userId: rr.referrerId, points: -dec, source: 'referral_reversed' } })
        }
      }
      await tx.referral.deleteMany({ where: { OR: [{ referrerId: userId }, { referredId: userId }] } })
      await tx.report.deleteMany({ where: { OR: [{ reporterUserId: userId }, { reportedUserId: userId }] } })

      // Booking'leri sil, sahip olunan salonların owner bağını boşalt, en son kullanıcıyı sil
      await tx.booking.deleteMany({ where: { userId } })
      await tx.venue.updateMany({ where: { ownerUserId: userId }, data: { ownerUserId: null } })
      await tx.user.delete({ where: { id: userId } })
    })

    // authMiddleware/optionalAuth 60sn cache'ini hemen düşür → silinen hesabın hâlâ imzalı-geçerli
    // JWT'si (kullanıcı access token'ı ~1sa) bir sonraki istekte 'missing' görülüp reddedilsin.
    invalidate(`authstate:${userId}`)

    return res.json({ message: 'Hesabınız ve tüm verileriniz kalıcı olarak silindi.' })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// ŞİFRE DEĞİŞTİR
export const changePassword = async (req: Request & { userId?: number }, res: Response) => {
  try {
    const { currentPassword, newPassword } = req.body

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Mevcut ve yeni şifre gerekli.' })
    }

    if (newPassword.length < MIN_PASSWORD) {
      return res.status(400).json({ error: `Yeni şifre en az ${MIN_PASSWORD} karakter olmalı.` })
    }

    const user = await prisma.user.findUnique({ where: { id: req.userId } })
    if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' })

    const isValid = await bcrypt.compare(currentPassword, user.passwordHash)
    if (!isValid) return res.status(401).json({ error: 'Mevcut şifre hatalı.' })

    const newHash = await bcrypt.hash(newPassword, 12)
    // TEK TRANSACTION + .catch YOK. resetPassword'de (satır ~361) düzeltilen aynı kalıp buradaydı:
    // parola yazması ayrı commit'lenip oturum-iptal süpürgesi `.catch(() => {})` ile yutuluyordu →
    // süpürge bir DB hıçkırığıyla başarısız olsa bile kullanıcı 200 "değiştirildi" görüyor, eski
    // cihaz oturumları (180 gün geçerli refresh token) açık kalıyordu. Süpürge güvenlik işlemidir,
    // best-effort DEĞİL: başarısızsa 500 dönmeli, "başarılı" DENMEMELİ.
    await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: req.userId }, data: { passwordHash: newHash } })
      await tx.refreshToken.updateMany({ where: { userId: req.userId, revoked: false }, data: { revoked: true } })
    })
    // Commit sonrası araya girmiş olabilecek oturumları da kapat (idempotent güvenlik ağı).
    await prisma.refreshToken.updateMany({ where: { userId: req.userId, revoked: false }, data: { revoked: true } })

    return res.json({ message: 'Şifre başarıyla değiştirildi.' })
  } catch (error) {
    console.error('ChangePassword error:', error)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// EMAIL DOĞRULA
export const verifyEmail = async (req: Request, res: Response) => {
  try {
    const { token } = req.body

    // GÜVENLİK: token yoksa `where:{token:undefined}` filtreyi yok sayar → başka birinin doğrulama
    // token'ı bulunup e-postası izinsiz doğrulanır. Query'den önce zorunlu kontrol.
    if (!token || typeof token !== 'string') {
      return res.status(400).json({ error: 'Geçersiz doğrulama linki.' })
    }

    const record = await prisma.emailVerificationToken.findFirst({
      where: { token, used: false, expiresAt: { gt: new Date() } }
    })

    if (!record) {
      return res.status(400).json({ error: 'Geçersiz veya süresi dolmuş doğrulama linki.' })
    }

    await prisma.user.update({ where: { id: record.userId }, data: { isEmailVerified: true } })
    await prisma.emailVerificationToken.update({ where: { id: record.id }, data: { used: true } })

    return res.json({ message: 'Email başarıyla doğrulandı!' })
  } catch (error) {
    console.error('VerifyEmail error:', error)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// EMAIL DOĞRULAMA YENİDEN GÖNDER
export const resendVerification = async (req: Request & { userId?: number }, res: Response) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.userId }, select: { email: true, fullName: true, isEmailVerified: true } })
    if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' })
    if (user.isEmailVerified) return res.status(400).json({ error: 'Email zaten doğrulanmış.' })

    // COOLDOWN: son 2 dk içinde token üretildiyse tekrar GÖNDERME — self-servis mail seli + token satır şişmesi
    // engeli (authLimiter'a ek). Kullanıcı akışını bozmaz (zaten gönderildi mesajı döner).
    const recent = await prisma.emailVerificationToken.findFirst({ where: { userId: req.userId!, createdAt: { gt: new Date(Date.now() - 2 * 60 * 1000) } }, select: { id: true } })
    if (recent) return res.json({ message: 'Doğrulama emaili yakın zamanda gönderildi. Birkaç dakika sonra tekrar deneyin.' })

    const verifyToken = crypto.randomBytes(32).toString('hex')
    const verifyExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000)
    await prisma.emailVerificationToken.create({ data: { userId: req.userId!, token: verifyToken, expiresAt: verifyExpiresAt } })
    sendEmailVerificationEmail(user.email, user.fullName, verifyToken).catch(err => console.error('Verify mail gönderilemedi:', err))

    return res.json({ message: 'Doğrulama emaili tekrar gönderildi.' })
  } catch (error) {
    console.error('ResendVerification error:', error)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

export const updateNotificationSettings = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId
    // ÖLÜ TERCİH TEMİZLİĞİ: smsReminders hiçbir zaman kullanılmıyordu — SMS altyapısı yok (Netgsm yapılmadı;
    // tüm hatırlatmalar e-posta + push). Ayarı kabul etmek/döndürmek kullanıcıya çalışmayan bir anahtar
    // gösteriyordu. Artık yalnız emailReminders yönetilir. (DB kolonu şemada dormant kalır — düşürmek
    // prod'da --accept-data-loss ister, değeri yok. SMS gerçekten gelirse tercih yeniden bağlanır.)
    const { emailReminders } = req.body

    const user = await prisma.user.update({
      where: { id: userId },
      data: {
        ...(typeof emailReminders === 'boolean' ? { emailReminders } : {}),
      },
      select: { id: true, emailReminders: true }
    })

    return res.json({ message: 'Bildirim tercihleri güncellendi.', user })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

export const registerPushToken = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId
    const { pushToken } = req.body
    if (!pushToken || typeof pushToken !== 'string') {
      return res.status(400).json({ error: 'pushToken gerekli.' })
    }
    // Aynı Expo token başka hesaba bağlıysa onu kopar — bir cihaz-token'ı TEK sahibe ait olmalı.
    // Yoksa paylaşılan cihazda A çıkıp B girince A'nın özel push bildirimleri B'nin cihazına düşer (çapraz-hesap sızıntısı).
    await prisma.user.updateMany({ where: { pushToken, NOT: { id: userId } }, data: { pushToken: null } })
    await prisma.user.update({ where: { id: userId }, data: { pushToken } })
    return res.json({ message: 'Push token kaydedildi.' })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}
