import { Request, Response } from 'express'
import bcrypt from 'bcryptjs'
import crypto from 'crypto'
import prisma from '../utils/prisma'
import { generateToken } from '../utils/jwt'
import { sendWelcomeEmail, sendPasswordResetEmail } from '../utils/email'

// KAYIT OL
export const register = async (req: Request, res: Response) => {
  try {
    const { username, email, phone, password, fullName } = req.body

    if (!username || !email || !password || !fullName) {
      return res.status(400).json({ error: 'Tüm zorunlu alanları doldurun.' })
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Şifre en az 6 karakter olmalı.' })
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

    // Hoş geldin maili gönder (hata olsa bile kayıt tamamlanır)
    sendWelcomeEmail(user.email, user.fullName).catch(err => console.error('Mail gönderilemedi:', err))

    return res.status(201).json({
      message: 'Kayıt başarılı!',
      token,
      user,
    })
  } catch (error) {
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
        createdAt: true,
        neighborhood: { select: { name: true } },
        city: { select: { name: true } },
        tier: { select: { name: true, discountPercent: true, colorHex: true, iconUrl: true } },
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

// KENDİ REZERVASYONLARIMı GETİR
export const getMyBookingsAuth = async (req: Request & { userId?: number }, res: Response) => {
  try {
    const userId = req.userId!
    const bookings = await prisma.booking.findMany({
      where: { userId },
      include: {
        session: {
          include: {
            class: {
              include: {
                venue: { select: { id: true, name: true } }
              }
            }
          }
        }
      },
      orderBy: { createdAt: 'desc' },
    })
    const dropInParticipations = await prisma.dropInParticipant.findMany({
      where: { userId },
      include: {
        slot: {
          include: {
            venue: { select: { id: true, name: true } },
            sportCategory: { select: { name: true, iconUrl: true, colorHex: true } },
          }
        }
      },
      orderBy: { joinedAt: 'desc' },
    })
    return res.json({ bookings, dropInParticipations })
  } catch (err) {
    console.error(err)
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
