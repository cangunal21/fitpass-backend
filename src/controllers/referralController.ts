import { Request, Response } from 'express'
import prisma from '../utils/prisma'
import crypto from 'crypto'

const CREDIT_AMOUNT = 150

// Unique referral kodu üret (çakışma olursa tekrar dene)
async function generateUniqueCode(): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const code = crypto.randomBytes(4).toString('hex').toUpperCase()
    const existing = await prisma.user.findUnique({ where: { referralCode: code } })
    if (!existing) return code
  }
  // Fallback: daha uzun kod
  return crypto.randomBytes(6).toString('hex').toUpperCase()
}

// Kullanıcının referral kodunu getir (yoksa oluştur)
export const getReferralInfo = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId

    let user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, referralCode: true, creditBalance: true, referralCount: true }
    })
    if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' })

    // Kod yoksa oluştur
    if (!user.referralCode) {
      const code = await generateUniqueCode()
      user = await prisma.user.update({
        where: { id: userId },
        data: { referralCode: code },
        select: { id: true, referralCode: true, creditBalance: true, referralCount: true }
      })
    }

    const referrals = await prisma.referral.findMany({
      where: { referrerId: userId },
      include: { referred: { select: { fullName: true, username: true } } },
      orderBy: { createdAt: 'desc' }
    })

    return res.json({
      referralCode: user!.referralCode,
      creditBalance: user!.creditBalance,
      referralCount: user!.referralCount,
      maxReferrals: 3,
      creditAmount: CREDIT_AMOUNT,
      referrals: referrals.map(r => ({
        id: r.id,
        fullName: r.referred.fullName,
        username: r.referred.username,
        status: r.status,
        createdAt: r.createdAt,
      }))
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// Kayıt sırasında referral kodu uygula
export const applyReferralCode = async (userId: number, code: string) => {
  try {
    const referrer = await prisma.user.findUnique({
      where: { referralCode: code },
      select: { id: true, referralCount: true }
    })
    if (!referrer || referrer.id === userId) return
    if (referrer.referralCount >= 3) return // max 3 davet

    // Zaten referral varsa atla
    const existing = await prisma.referral.findUnique({
      where: { referrerId_referredId: { referrerId: referrer.id, referredId: userId } }
    })
    if (existing) return

    // Referral kaydı oluştur + referrer sayacını artır.
    // NOT: Davet edilene kredi BURADA (kayıt anında) verilmez — suistimali önlemek için
    // (sahte/atılır email'lerle kredi farm'lanmasın). Kredi, email doğrulandığında verilir
    // (bkz. grantReferredBonus, authController.verifyEmail'den çağrılır).
    await prisma.$transaction([
      prisma.referral.create({
        data: { referrerId: referrer.id, referredId: userId, creditAmount: CREDIT_AMOUNT }
      }),
      prisma.user.update({
        where: { id: referrer.id },
        data: { referralCount: { increment: 1 } }
      }),
    ])
  } catch (err) {
    console.error('Referral apply error:', err)
  }
}

// Davet edilen kullanıcı email'ini doğrulayınca kayıt bonusunu (150 TL kredi) ver.
// Tek seferlik: referredBonusGranted flag'i ile korunur. Atılır email'lerle suistimali engeller.
export const grantReferredBonus = async (userId: number) => {
  try {
    const referral = await prisma.referral.findFirst({
      where: { referredId: userId, referredBonusGranted: false },
    })
    if (!referral) return

    await prisma.$transaction([
      prisma.referral.update({
        where: { id: referral.id },
        data: { referredBonusGranted: true },
      }),
      prisma.user.update({
        where: { id: userId },
        data: { creditBalance: { increment: CREDIT_AMOUNT } },
      }),
    ])
  } catch (err) {
    console.error('Referred bonus grant error:', err)
  }
}

// İlk ödeme tamamlanınca davet edene kredi ver
export const completeReferral = async (userId: number) => {
  try {
    const referral = await prisma.referral.findFirst({
      where: { referredId: userId, status: 'pending' }
    })
    if (!referral) return

    await prisma.$transaction([
      prisma.referral.update({
        where: { id: referral.id },
        data: { status: 'completed', completedAt: new Date() }
      }),
      prisma.user.update({
        where: { id: referral.referrerId },
        data: { creditBalance: { increment: CREDIT_AMOUNT } }
      }),
    ])
  } catch (err) {
    console.error('Referral complete error:', err)
  }
}
