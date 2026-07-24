import { Request, Response } from 'express'
import prisma from '../utils/prisma'

// Salon: kupon oluştur
export const createCoupon = async (req: Request, res: Response) => {
  try {
    const venueId = (req as any).venueId
    const { code, discountType, discountValue, maxUses, perUserLimit, expiresAt } = req.body

    if (!code || !discountType || !discountValue) {
      return res.status(400).json({ error: 'Kod, indirim tipi ve değeri zorunludur.' })
    }
    if (!['percent', 'fixed'].includes(discountType)) {
      return res.status(400).json({ error: 'İndirim tipi "percent" veya "fixed" olmalıdır.' })
    }
    if (discountType === 'percent' && (discountValue <= 0 || discountValue > 100)) {
      return res.status(400).json({ error: 'Yüzde indirim 1-100 arasında olmalıdır.' })
    }
    // Sabit (fixed) indirim pozitif olmalı — negatif değer fiyatı artırırdı (finalAmount = base − discount)
    if (discountType === 'fixed' && !(discountValue > 0)) {
      return res.status(400).json({ error: 'Sabit indirim 0’dan büyük olmalıdır.' })
    }

    const existing = await prisma.coupon.findUnique({ where: { code: code.toUpperCase() } })
    if (existing) return res.status(400).json({ error: 'Bu kupon kodu zaten kullanılıyor.' })

    const coupon = await prisma.coupon.create({
      data: {
        venueId,
        code: code.toUpperCase(),
        discountType,
        discountValue: parseFloat(discountValue),
        maxUses: maxUses ? parseInt(maxUses) : null,
        perUserLimit: perUserLimit != null && perUserLimit !== '' && parseInt(perUserLimit) > 0 ? parseInt(perUserLimit) : null,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
        isActive: true,
      }
    })

    return res.status(201).json({ message: 'Kupon oluşturuldu.', coupon })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// Salon: kuponlarını listele
export const getVenueCoupons = async (req: Request, res: Response) => {
  try {
    const venueId = (req as any).venueId
    const coupons = await prisma.coupon.findMany({
      where: { venueId },
      orderBy: { createdAt: 'desc' }
    })
    return res.json({ coupons })
  } catch (err) {
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// Salon: kuponu sil/deaktive et
export const deleteCoupon = async (req: Request, res: Response) => {
  try {
    const venueId = (req as any).venueId
    const id = parseInt(req.params.id as string)
    const coupon = await prisma.coupon.findUnique({ where: { id } })
    if (!coupon || coupon.venueId !== venueId) {
      return res.status(403).json({ error: 'Yetki yok.' })
    }
    await prisma.coupon.update({ where: { id }, data: { isActive: false } })
    return res.json({ message: 'Kupon deaktive edildi.' })
  } catch (err) {
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// Kullanıcı: kupon doğrula (booking öncesi)
export const validateCoupon = async (req: Request, res: Response) => {
  try {
    const { code, venueId } = req.body
    if (!code || !venueId) return res.status(400).json({ error: 'Kod ve salon gerekli.' })

    const coupon = await prisma.coupon.findUnique({ where: { code: String(code).toUpperCase() } })

    if (!coupon || !coupon.isActive) return res.status(404).json({ error: 'Geçersiz kupon kodu.' })
    if (coupon.venueId !== parseInt(venueId)) return res.status(400).json({ error: 'Bu kupon bu salona ait değil.' })
    if (coupon.expiresAt && coupon.expiresAt < new Date()) return res.status(400).json({ error: 'Kupon süresi dolmuş.' })
    if (coupon.maxUses && coupon.usedCount >= coupon.maxUses) return res.status(400).json({ error: 'Kupon kullanım limiti dolmuş.' })

    return res.json({
      valid: true,
      coupon: {
        id: coupon.id,
        code: coupon.code,
        discountType: coupon.discountType,
        discountValue: coupon.discountValue,
      }
    })
  } catch (err) {
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}
