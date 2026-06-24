import { Request, Response } from 'express'
import prisma from '../utils/prisma'
import crypto from 'crypto'

const REFERRAL_POINTS = 100

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
      select: { id: true, referralCode: true, rewardPoints: true, referralCount: true }
    })
    if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' })

    // Kod yoksa oluştur
    if (!user.referralCode) {
      const code = await generateUniqueCode()
      user = await prisma.user.update({
        where: { id: userId },
        data: { referralCode: code },
        select: { id: true, referralCode: true, rewardPoints: true, referralCount: true }
      })
    }

    const referrals = await prisma.referral.findMany({
      where: { referrerId: userId },
      include: { referred: { select: { fullName: true, username: true } } },
      orderBy: { createdAt: 'desc' }
    })

    return res.json({
      referralCode: user!.referralCode,
      rewardPoints: user!.rewardPoints,
      referralCount: user!.referralCount,
      maxReferrals: 3,
      creditAmount: REFERRAL_POINTS,
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

    // Referral kaydı oluştur + referrer sayacını artır (hesap başına max 3 davet).
    // NOT: Puan BURADA (kayıt anında) verilmez. Hem davet edene hem edilene puan, davet edilenin
    // İLK ÜCRETLİ DERSİNİ tamamlamasıyla verilir (bkz. completeReferral) — sahte hesap farming'i önler,
    // ödülü gerçek GMV'ye bağlar.
    await prisma.$transaction([
      prisma.referral.create({
        data: { referrerId: referrer.id, referredId: userId, creditAmount: REFERRAL_POINTS }
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

// Davet ödülü, davet edilenin ilk ÜCRETLİ dersini tamamlamasıyla hak edilir (kayıt anında DEĞİL).
// Hem davet EDENE hem davet EDİLENE verilir → sahte hesap farming'i kaynağında biter, ödül gerçek GMV'ye bağlanır.
// Idempotent: referral 'pending' → 'completed' olunca tekrar tetiklenmez.
export const completeReferral = async (userId: number) => {
  try {
    const referral = await prisma.referral.findFirst({
      where: { referredId: userId, status: 'pending' }
    })
    if (!referral) return

    await prisma.$transaction([
      prisma.referral.update({
        where: { id: referral.id },
        data: { status: 'completed', completedAt: new Date(), referredBonusGranted: true }
      }),
      // Davet eden
      prisma.user.update({
        where: { id: referral.referrerId },
        data: { rewardPoints: { increment: REFERRAL_POINTS } }
      }),
      prisma.rewardPoint.create({ data: { userId: referral.referrerId, points: REFERRAL_POINTS, source: 'referral_completed' } }),
      // Davet edilen
      prisma.user.update({
        where: { id: referral.referredId },
        data: { rewardPoints: { increment: REFERRAL_POINTS } }
      }),
      prisma.rewardPoint.create({ data: { userId: referral.referredId, points: REFERRAL_POINTS, source: 'referral_completed' } }),
    ])
  } catch (err) {
    console.error('Referral complete error:', err)
  }
}
