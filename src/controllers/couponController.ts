import { Request, Response } from 'express'
import prisma from '../utils/prisma'
import { parseIntSafe, parseDateSafe } from '../utils/validate'

// Salon: kupon oluştur
export const createCoupon = async (req: Request, res: Response) => {
  try {
    const venueId = (req as any).venueId
    const { code, discountType, discountValue, maxUses, perUserLimit, expiresAt } = req.body

    if (!code || !discountType || discountValue == null) {
      return res.status(400).json({ error: 'Kod, indirim tipi ve değeri zorunludur.' })
    }
    if (!['percent', 'fixed'].includes(discountType)) {
      return res.status(400).json({ error: 'İndirim tipi "percent" veya "fixed" olmalıdır.' })
    }
    // SAYISAL doğrula: 'abc' gibi non-numeric değer parseFloat→NaN olup booking'de money kolonlarına NaN
    // yazardı (gevşek </> karşılaştırmaları NaN'ı geçiriyordu). Number.isFinite + pozitiflik ile kesin kapat.
    const dv = parseFloat(discountValue)
    if (!Number.isFinite(dv) || dv <= 0) {
      return res.status(400).json({ error: 'İndirim değeri geçerli, 0’dan büyük bir sayı olmalıdır.' })
    }
    if (discountType === 'percent' && dv > 100) {
      return res.status(400).json({ error: 'Yüzde indirim 1-100 arasında olmalıdır.' })
    }

    // maxUses / expiresAt güvenli ayrıştır — 'abc'→NaN Prisma 500'ünü ve negatif maxUses'in kuponu
    // kalıcı brick'lemesini (0 >= -5 → "limit dolmuş" sonsuza dek) önle.
    let maxUsesVal: number | null = null
    if (maxUses != null && maxUses !== '') {
      const m = parseIntSafe(maxUses)
      if (m === undefined) return res.status(400).json({ error: 'Maksimum kullanım geçerli, pozitif bir tamsayı olmalıdır.' })
      maxUsesVal = m
    }
    let expiresAtVal: Date | null = null
    if (expiresAt) {
      const d = parseDateSafe(expiresAt)
      if (d === undefined) return res.status(400).json({ error: 'Son kullanım tarihi geçersiz.' })
      expiresAtVal = d
    }

    const existing = await prisma.coupon.findUnique({ where: { code: code.toUpperCase() } })
    if (existing) return res.status(400).json({ error: 'Bu kupon kodu zaten kullanılıyor.' })

    const coupon = await prisma.coupon.create({
      data: {
        venueId,
        code: code.toUpperCase(),
        discountType,
        discountValue: dv,
        maxUses: maxUsesVal,
        perUserLimit: perUserLimit != null && perUserLimit !== '' && parseInt(perUserLimit) > 0 ? parseInt(perUserLimit) : null,
        expiresAt: expiresAtVal,
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

    // ENUMERASYON/ORACLE ENGELİ: kod-yok · yanlış-salon · süresi-dolmuş · limit-dolmuş AYIRT EDİLMEZ →
    // hepsi tek "geçersiz" döner. Aksi halde 404-vs-400 farkı platform-genelinde "bu kod var mı?" oracle'ı
    // olur ve başka salonun kupon VARLIĞI sızardı. Yalnız kod+salon+aktif+geçerli tam eşleşirse indirim döner.
    const invalid = () => res.status(400).json({ valid: false, error: 'Geçersiz veya kullanılamaz kupon kodu.' })
    if (!coupon || !coupon.isActive) return invalid()
    if (coupon.venueId !== parseInt(venueId)) return invalid()
    if (coupon.expiresAt && coupon.expiresAt < new Date()) return invalid()
    if (coupon.maxUses && coupon.usedCount >= coupon.maxUses) return invalid()

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
