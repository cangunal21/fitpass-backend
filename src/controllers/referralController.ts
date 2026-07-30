import { Request, Response } from 'express'
import prisma from '../utils/prisma'
import crypto from 'crypto'
import { resetYearlyPointsIfNeeded } from '../utils/tier'

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
      // KOŞULLU YAZMA: eskiden koşulsuz update'ti. Aynı kullanıcının iki eşzamanlı isteği
      // (uygulama + web, ya da çift tık) ikisi de "kod yok" görüp FARKLI kod üretiyor, ikincisi
      // birincisini eziyordu. İlk isteğe gösterilen kod DB'de kalmadığı için o kodu paylaşan
      // kullanıcının davetleri applyReferralCode'da "geçersiz kod" alıyordu.
      const claim = await prisma.user.updateMany({
        where: { id: userId, referralCode: null },
        data: { referralCode: code },
      })
      // count=0 → başka bir istek bu arada kod yazdı; ONU oku, kendi kodumuzu dayatma.
      user = (await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, referralCode: true, rewardPoints: true, referralCount: true }
      }))!
      if (claim.count === 0) console.log(`referral kodu yarışı: user#${userId} mevcut kodu kullanıyor`)
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
    // ATOMİK 3-LİMİT: referralCount<3 iken artırabilen TEK çağrı daveti oluşturur. Kilitsiz
    // read-then-check-then-write olsaydı eşzamanlı iki kayıt limiti aşabilirdi (referrer 3'ten fazla puan).
    await prisma.$transaction(async (tx) => {
      const bump = await tx.user.updateMany({
        where: { id: referrer.id, referralCount: { lt: 3 } },
        data: { referralCount: { increment: 1 } },
      })
      if (bump.count === 0) return // limit dolu (yarışta kaybeden) → kayıt oluşturma
      // Çift-referral (aynı çift) unique kısıtı → P2002 fırlatırsa tüm tx (sayaç dahil) geri alınır
      await tx.referral.create({
        data: { referrerId: referrer.id, referredId: userId, creditAmount: REFERRAL_POINTS },
      })
    })
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

    // Yıllık puan sıfırlaması TEMBEL (lazy) çalışıyor ve yalnız getMe + createBooking'de tetikleniyor.
    // Davet EDENİN yıl damgası burada tazelenmezse, yeni yılda verilen +100 bir sonraki getMe'de
    // eski yıl bakiyesiyle birlikte sıfırlanır — ama RewardPoint defter satırı kalır (bakiye/defter çelişkisi).
    await resetYearlyPointsIfNeeded(referral.referrerId).catch(() => {})
    await resetYearlyPointsIfNeeded(referral.referredId).catch(() => {})

    // CAS: pending→completed geçişini yapabilen TEK çağrı puanı verir. Kilitsiz findFirst+update
    // olsaydı, davet edilenin eşzamanlı iki ücretli booking'i aynı pending referral'ı görüp ÇİFT +100
    // dağıtırdı. updateMany(where status='pending') count===0 → başka çağrı zaten tamamlamış.
    await prisma.$transaction(async (tx) => {
      const flip = await tx.referral.updateMany({
        where: { id: referral.id, status: 'pending' },
        data: { status: 'completed', completedAt: new Date(), referredBonusGranted: true },
      })
      if (flip.count === 0) return
      await tx.user.update({ where: { id: referral.referrerId }, data: { rewardPoints: { increment: REFERRAL_POINTS } } })
      await tx.rewardPoint.create({ data: { userId: referral.referrerId, points: REFERRAL_POINTS, source: 'referral_completed' } })
      await tx.user.update({ where: { id: referral.referredId }, data: { rewardPoints: { increment: REFERRAL_POINTS } } })
      await tx.rewardPoint.create({ data: { userId: referral.referredId, points: REFERRAL_POINTS, source: 'referral_completed' } })
    })
  } catch (err) {
    console.error('Referral complete error:', err)
  }
}
