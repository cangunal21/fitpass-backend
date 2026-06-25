import { Request, Response } from 'express'
import bcrypt from 'bcryptjs'
import crypto from 'crypto'
import prisma from '../utils/prisma'
import { generateToken } from '../utils/jwt'
import { sendWelcomeEmail, sendPasswordResetEmail, sendEmailVerificationEmail, sendBadgeEmail } from '../utils/email'
import { applyReferralCode } from './referralController'
import { syncUserTier, resetYearlyPointsIfNeeded } from '../utils/tier'
import { syncUserBadges } from '../utils/badges'
import { sendPushNotification } from '../utils/push'
import { isValidEmail, MIN_PASSWORD, clampStr } from '../utils/validate'

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

    // Mevcut kullanıcı kontrolü
    const existingUser = await prisma.user.findFirst({
      where: { OR: [{ email }, { username }] }
    })

    if (existingUser) {
      if (existingUser.email === email) {
        return res.status(400).json({ error: 'Bu e-posta zaten kullanılıyor.' })
      }
      return res.status(400).json({ error: 'Bu kullanıcı adı zaten alınmış.' })
    }

    const passwordHash = await bcrypt.hash(password, 12)

    const user = await prisma.user.create({
      data: {
        username,
        email,
        phone: phone || null,
        passwordHash,
        fullName,
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

    return res.status(201).json({
      message: 'Kayıt başarılı! Email adresinize doğrulama linki gönderildi.',
      token,
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
export const login = async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body

    if (!email || !password) {
      return res.status(400).json({ error: 'E-posta ve şifre gerekli.' })
    }

    const user = await prisma.user.findUnique({ where: { email } })

    if (!user) {
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

    return res.json({
      message: 'Giriş başarılı!',
      token,
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
          const u = await prisma.user.findUnique({ where: { id: req.userId }, select: { pushToken: true, email: true, fullName: true } })
          const msg = newBadges.length === 1
            ? `"${newBadges[0]}" rozetini kazandın! 🎉`
            : `${newBadges.length} yeni rozet kazandın! 🎉`
          await prisma.notification.create({ data: { userId: req.userId, type: 'badge', message: msg } }).catch(() => {})
          if (u?.pushToken) sendPushNotification(u.pushToken, 'Yeni rozet! 🏅', msg).catch(() => {})
          if (u?.email) sendBadgeEmail(u.email, u.fullName, newBadges).catch(() => {})
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

    const user = await prisma.user.findUnique({ where: { email } })

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

    if (!password || password.length < 6) {
      return res.status(400).json({ error: 'Şifre en az 6 karakter olmalı.' })
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

    await prisma.user.update({
      where: { id: resetToken.userId },
      data: { passwordHash }
    })

    await prisma.passwordResetToken.update({
      where: { id: resetToken.id },
      data: { used: true }
    })

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
      data.neighborhoodId = parseInt(neighborhoodId)
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
    const { activityPrivacy } = req.body

    if (!['public', 'private'].includes(activityPrivacy)) {
      return res.status(400).json({ error: 'Geçersiz gizlilik ayarı.' })
    }

    const user = await prisma.user.update({
      where: { id: userId },
      data: { activityPrivacy },
      select: { id: true, activityPrivacy: true }
    })

    return res.json({ message: 'Gizlilik ayarı güncellendi.', user })
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

    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'Yeni şifre en az 6 karakter olmalı.' })
    }

    const user = await prisma.user.findUnique({ where: { id: req.userId } })
    if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' })

    const isValid = await bcrypt.compare(currentPassword, user.passwordHash)
    if (!isValid) return res.status(401).json({ error: 'Mevcut şifre hatalı.' })

    const newHash = await bcrypt.hash(newPassword, 12)
    await prisma.user.update({ where: { id: req.userId }, data: { passwordHash: newHash } })

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
    const { emailReminders, smsReminders } = req.body

    const user = await prisma.user.update({
      where: { id: userId },
      data: {
        ...(typeof emailReminders === 'boolean' ? { emailReminders } : {}),
        ...(typeof smsReminders === 'boolean' ? { smsReminders } : {}),
      },
      select: { id: true, emailReminders: true, smsReminders: true }
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
    await prisma.user.update({ where: { id: userId }, data: { pushToken } })
    return res.json({ message: 'Push token kaydedildi.' })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}
