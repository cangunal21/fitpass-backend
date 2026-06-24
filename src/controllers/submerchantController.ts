import { Request, Response } from 'express'
import prisma from '../utils/prisma'
import { createSubMerchant, retrieveSubMerchant, isPaymentConfigured, SubMerchantType } from '../utils/payment'

const TYPES: SubMerchantType[] = ['PERSONAL', 'PRIVATE_COMPANY', 'LIMITED_OR_JOINT_STOCK_COMPANY']

// Salon paneli → alt-üye (sub-merchant) bilgileri + KYC belgeleri gönder.
// Önce admin onayı (venueApprovedMiddleware) gerekir; bu endpoint ödeme entegratörüne (iyzico/PayTR) iletir.
export const submitSubMerchant = async (req: Request, res: Response) => {
  try {
    const venueId = (req as any).venueId
    const {
      subMerchantType, legalCompanyTitle, iban, taxOffice, taxNumber, identityNumber,
      contactName, contactSurname, payoutGsm, ibanMatchConsent, kycDocs,
    } = req.body

    if (!TYPES.includes(subMerchantType)) {
      return res.status(400).json({ error: 'Geçerli bir işletme türü seçin.' })
    }
    if (!iban || !payoutGsm) {
      return res.status(400).json({ error: 'IBAN ve telefon zorunludur.' })
    }
    if (ibanMatchConsent !== true) {
      return res.status(400).json({ error: 'IBAN-kimlik eşleşmesi ve aktarım onayı gereklidir.' })
    }
    // Türe göre zorunlu alanlar
    if (subMerchantType === 'PERSONAL') {
      if (!contactName || !contactSurname || !identityNumber) {
        return res.status(400).json({ error: 'Ad, soyad ve TCKN zorunludur.' })
      }
    } else if (subMerchantType === 'PRIVATE_COMPANY') {
      if (!legalCompanyTitle || !taxOffice || (!taxNumber && !identityNumber)) {
        return res.status(400).json({ error: 'Ünvan, vergi dairesi ve vergi no/TCKN zorunludur.' })
      }
    } else {
      if (!legalCompanyTitle || !taxOffice || !taxNumber) {
        return res.status(400).json({ error: 'Ünvan, vergi dairesi ve vergi no zorunludur.' })
      }
    }

    const venue = await prisma.venue.findUnique({
      where: { id: venueId },
      select: { id: true, name: true, email: true, address: true },
    })
    if (!venue) return res.status(404).json({ error: 'Salon bulunamadı.' })

    // Bilgileri kaydet (status: submitted)
    await prisma.venue.update({
      where: { id: venueId },
      data: {
        subMerchantType, legalCompanyTitle: legalCompanyTitle || null, iban,
        taxOffice: taxOffice || null, taxNumber: taxNumber || null, identityNumber: identityNumber || null,
        contactName: contactName || null, contactSurname: contactSurname || null,
        payoutGsm, ibanMatchConsent: true, kycDocs: kycDocs || {},
        subMerchantStatus: 'submitted', subMerchantSubmittedAt: new Date(), subMerchantRejection: null,
      },
    })

    // Ödeme entegratörü tanımlıysa alt-üyeyi oluştur (anahtar yoksa 'submitted' kalır)
    if (isPaymentConfigured()) {
      try {
        const { subMerchantKey } = await createSubMerchant({
          externalId: `venue-${venue.id}`,
          type: subMerchantType,
          address: venue.address,
          email: venue.email || `venue-${venue.id}@sipsakspor.com`,
          gsmNumber: payoutGsm,
          name: venue.name,
          iban,
          contactName, contactSurname, identityNumber,
          taxOffice, taxNumber, legalCompanyTitle,
        })
        // Sandbox'ta alt-üye anında kullanılabilir → approved. (Prod'da belge incelemesi gerekebilir.)
        await prisma.venue.update({
          where: { id: venueId },
          data: { iyzicoSubMerchantKey: subMerchantKey, subMerchantStatus: 'approved', subMerchantApprovedAt: new Date() },
        })
        return res.json({ status: 'approved', message: 'Bilgileriniz onaylandı, artık ders ekleyip ödeme alabilirsiniz.' })
      } catch (e: any) {
        await prisma.venue.update({
          where: { id: venueId },
          data: { subMerchantStatus: 'rejected', subMerchantRejection: e?.message || 'Ödeme kuruluşu reddetti.' },
        })
        return res.status(400).json({ status: 'rejected', error: e?.message || 'Ödeme kuruluşu bilgileri reddetti.' })
      }
    }

    return res.json({ status: 'submitted', message: 'Bilgileriniz alındı, inceleniyor.' })
  } catch (err) {
    console.error('submitSubMerchant error:', err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// İyzico'dan alt-üye durumunu yeniden çek (panelde "Durumu yenile")
export const refreshSubMerchantStatus = async (req: Request, res: Response) => {
  try {
    const venueId = (req as any).venueId
    const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { iyzicoSubMerchantKey: true, subMerchantStatus: true } })
    if (!venue?.iyzicoSubMerchantKey || !isPaymentConfigured()) {
      return res.json({ status: venue?.subMerchantStatus || 'none' })
    }
    const r = await retrieveSubMerchant(`venue-${venueId}`)
    const ok = r?.status === 'success' && r?.subMerchantKey
    if (ok && venue.subMerchantStatus !== 'approved') {
      await prisma.venue.update({ where: { id: venueId }, data: { subMerchantStatus: 'approved', subMerchantApprovedAt: new Date() } })
    }
    return res.json({ status: ok ? 'approved' : (venue.subMerchantStatus || 'submitted') })
  } catch (err) {
    console.error('refreshSubMerchantStatus error:', err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}
