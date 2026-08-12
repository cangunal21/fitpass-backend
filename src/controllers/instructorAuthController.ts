import { Request, Response } from 'express'
import bcrypt from 'bcryptjs'
import crypto from 'crypto'
import prisma from '../utils/prisma'
import { generateToken } from '../utils/jwt'
import { isValidEmail, MIN_PASSWORD } from '../utils/validate'
import { sendInstructorPasswordResetEmail } from '../utils/email'
import { invalidate } from '../utils/cache'
import { issuePanelRefreshToken, revokeAllPanelRefreshTokens, rotatePanelAccessToken, revokePanelRefreshToken } from '../utils/panelRefreshToken'

// Eğitmen (instructor) auth realm — venue realm'inin aynası. GÜVENLİK: token payload'ı SADECE
// {instructorId, email, role:'instructor'} taşır; venueId ASLA eklenmez → salon finans/check-in
// uçlarına (venueAuth, role='venue') yapısal olarak erişemez.

// Hesap bulunamayınca da bcrypt.compare çalıştırıp zamanlamayı eşitlemek için sabit dummy hash
// (kullanıcı-enumeration timing oracle'ını kapatır).
const DUMMY_HASH = bcrypt.hashSync('sipsakspor-timing-guard', 12)

// EĞİTMEN GİRİŞİ
export const instructorLogin = async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body
    if (!email || !password) {
      return res.status(400).json({ error: 'Email ve şifre gerekli.' })
    }
    // email @unique DEĞİL (prod db push için) → findFirst + orderBy (deterministik); küçük harf saklanır.
    // Tekillik uygulama düzeyinde (create/update/invite dupe kontrolü + DB partial unique index) sağlanır.
    const instructor = await prisma.instructor.findFirst({ where: { email: String(email).toLowerCase().trim() }, orderBy: { id: 'asc' } })
    if (!instructor || !instructor.passwordHash) {
      await bcrypt.compare(String(password), DUMMY_HASH).catch(() => {}) // timing'i eşitle (enumeration önleme)
      return res.status(401).json({ error: 'Email veya şifre hatalı.' })
    }
    const isValid = await bcrypt.compare(password, instructor.passwordHash)
    if (!isValid) {
      return res.status(401).json({ error: 'Email veya şifre hatalı.' })
    }
    if (!instructor.isActive) {
      return res.status(403).json({ error: 'Eğitmen hesabınız aktif değil. Salonunuzla iletişime geçin.' })
    }
    // SALON DURUM KAPISI: eğitmen bir salona bağlı; salon askıya alınmış/onayı geri alınmışsa
    // eğitmen de yeni token üretememeli (aksi halde donmuş salonun eğitmeni süresiz iş yapmaya
    // devam eder — check-in salon-durum bulgusunun kök nedeni buydu).
    const vGate = await prisma.venue.findUnique({ where: { id: instructor.venueId }, select: { isApproved: true, isActive: true, isSuspended: true } })
    if (!vGate || !vGate.isApproved || !vGate.isActive || vGate.isSuspended) {
      return res.status(403).json({ error: 'Bağlı olduğunuz salon şu anda aktif değil.' })
    }
    const token = generateToken({ instructorId: instructor.id, email: instructor.email || '', role: 'instructor' })
    // Access token artık 1 saat (eskiden 7 gün) → oturum kesintisiz sürsün diye refresh jetonu.
    const refreshToken = await issuePanelRefreshToken({ instructorId: instructor.id })
    return res.json({
      refreshToken,
      message: 'Giriş başarılı!',
      token,
      instructor: {
        id: instructor.id,
        fullName: instructor.fullName,
        email: instructor.email,
        avatarUrl: instructor.avatarUrl,
      },
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// EĞİTMEN ŞİFRE SIFIRLAMA TALEBİ (enumeration-safe)
export const instructorForgotPassword = async (req: Request, res: Response) => {
  try {
    const { email } = req.body
    const instructor = await prisma.instructor.findFirst({ where: { email: String(email || '').toLowerCase().trim() }, orderBy: { id: 'asc' } })
    // GÜVENLİK: forgot-password YALNIZCA zaten girişi kurulmuş (passwordHash olan) hesap için token
    // üretir. Aksi halde davet-kapısı atlatılıp self-provisioning yapılabilirdi (salon daveti olmadan
    // login kurma). İlk şifre belirleme yalnız salon davetiyle olur. Enumeration-safe: yine aynı mesaj.
    if (!instructor || !instructor.email || !instructor.passwordHash) {
      return res.json({ message: 'Email gönderildi' })
    }
    const token = crypto.randomBytes(32).toString('hex')
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000)
    await prisma.instructorPasswordResetToken.create({ data: { instructorId: instructor.id, token, expiresAt } })
    sendInstructorPasswordResetEmail(instructor.email, instructor.fullName, token).catch(err =>
      console.error('Instructor reset mail gönderilemedi:', err)
    )
    return res.json({ message: 'Email gönderildi' })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// EĞİTMEN ŞİFRE BELİRLE (hem DAVET hem RESET aynı token mekanizması + aynı sayfa)
export const instructorSetPassword = async (req: Request, res: Response) => {
  try {
    const { token } = req.body
    const password = req.body.password
    // typeof guard: string olmayan password bcrypt.hash'i patlatıp 500 vermesin (temiz 400)
    if (!token || typeof password !== 'string' || password.length < MIN_PASSWORD) {
      return res.status(400).json({ error: `Şifre en az ${MIN_PASSWORD} karakter olmalı.` })
    }
    const resetToken = await prisma.instructorPasswordResetToken.findFirst({
      where: { token, used: false, expiresAt: { gt: new Date() } },
    })
    if (!resetToken) {
      return res.status(400).json({ error: 'Geçersiz veya süresi dolmuş link.' })
    }
    const passwordHash = await bcrypt.hash(password, 12)
    // CAS + parola yazması TEK TRANSACTION. Eskiden token used=true AYRI commit'leniyor, sonra
    // instructor.update AYRI yazılıyordu → ikinci adım başarısız olursa token YANMIŞ ama parola
    // yazılmamış olur: link ölür, eğitmen parolayı bir daha belirleyemez. Atomik olunca ikisi
    // birlikte olur ya da hiç olmaz.
    const ok = await prisma.$transaction(async (tx) => {
      const claimed = await tx.instructorPasswordResetToken.updateMany({
        where: { id: resetToken.id, used: false },
        data: { used: true },
      })
      if (claimed.count === 0) return false
      // passwordChangedAt: bkz. Venue — eğitmen token'ı da 7 gün, refresh yok.
      await tx.instructor.update({ where: { id: resetToken.instructorId }, data: { passwordHash, inviteStatus: 'active', passwordChangedAt: new Date() } })
      return true
    })
    if (!ok) return res.status(400).json({ error: 'Geçersiz veya süresi dolmuş link.' })
    await revokeAllPanelRefreshTokens({ instructorId: resetToken.instructorId })
    invalidate(`instructorActive:${resetToken.instructorId}`) // eski token'lar ANINDA geçersiz olsun
    return res.json({ message: 'Şifre belirlendi. Artık giriş yapabilirsiniz.' })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// EĞİTMEN PROFİLİM (instructorAuth) — FİNANS YOK. venue yalnız id+name.
export const getInstructorMe = async (req: Request, res: Response) => {
  try {
    const instructorId = (req as any).instructorId
    const instructor = await prisma.instructor.findUnique({
      where: { id: instructorId },
      select: {
        id: true, fullName: true, specialty: true, specialtyEn: true,
        bio: true, bioEn: true, avatarUrl: true, phone: true, email: true,
        avgRating: true, totalReviews: true, verified: true, isActive: true,
        venue: { select: { id: true, name: true } },
      },
    })
    if (!instructor) return res.status(404).json({ error: 'Eğitmen bulunamadı.' })
    return res.json({ instructor })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// ACCESS TOKEN YENİLE (eğitmen) — bkz. venueRefresh; aynı gerekçe, aynı davranış.
export const instructorRefresh = async (req: Request, res: Response) => {
  try {
    const token = await rotatePanelAccessToken(String(req.body?.refreshToken || ''))
    if (!token) return res.status(401).json({ error: 'Oturum süresi doldu, lütfen tekrar giriş yapın.' })
    return res.json({ token })
  } catch (err) {
    console.error('instructorRefresh error:', err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// ÇIKIŞ (eğitmen) — refresh jetonunu iptal et.
export const instructorLogout = async (req: Request, res: Response) => {
  try {
    await revokePanelRefreshToken(String(req.body?.refreshToken || ''))
    return res.json({ message: 'Çıkış yapıldı.' })
  } catch (err) {
    console.error('instructorLogout error:', err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}
