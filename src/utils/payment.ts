/*
 * Ödeme sağlayıcı adaptörü — şu an İyzico Pazaryeri (Marketplace), sağlayıcı-bağımsız arayüz.
 * Anahtarlar env'den gelir; tanımlı değilse isPaymentConfigured() false döner (kod kırılmaz).
 *   IYZICO_API_KEY, IYZICO_SECRET_KEY, IYZICO_BASE_URL (varsayılan: sandbox)
 * Sandbox anahtarları: https://sandbox-merchant.iyzipay.com → Ayarlar > Üye İşyeri > API Anahtarları
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Iyzipay = require('iyzipay')

const BASE_URL = process.env.IYZICO_BASE_URL || 'https://sandbox-api.iyzipay.com'
const API_KEY = process.env.IYZICO_API_KEY || ''
const SECRET_KEY = process.env.IYZICO_SECRET_KEY || ''

export const isPaymentConfigured = () => !!(API_KEY && SECRET_KEY)
export const isSandbox = () => BASE_URL.includes('sandbox')

function client(): any {
  if (!isPaymentConfigured()) {
    throw new Error('İyzico anahtarları tanımlı değil (IYZICO_API_KEY / IYZICO_SECRET_KEY).')
  }
  return new Iyzipay({ apiKey: API_KEY, secretKey: SECRET_KEY, uri: BASE_URL })
}

// SDK callback API'sini promise'e çevir
function call<T = any>(fn: (req: any, cb: (err: any, res: T) => void) => void, req: any): Promise<T> {
  return new Promise((resolve, reject) => fn(req, (err: any, res: T) => (err ? reject(err) : resolve(res))))
}

export type SubMerchantType = 'PERSONAL' | 'PRIVATE_COMPANY' | 'LIMITED_OR_JOINT_STOCK_COMPANY'

export interface SubMerchantInput {
  externalId: string            // bizim stabil referansımız ("venue-{id}")
  type: SubMerchantType
  address: string
  email: string
  gsmNumber: string             // +90...
  name: string                  // görünen ad (salon adı)
  iban: string
  // PERSONAL
  contactName?: string
  contactSurname?: string
  identityNumber?: string       // TCKN (PERSONAL & PRIVATE_COMPANY)
  // PRIVATE_COMPANY & LIMITED_OR_JOINT_STOCK_COMPANY
  taxOffice?: string
  taxNumber?: string            // LIMITED/AŞ vergi no
  legalCompanyTitle?: string    // ünvan
}

// Alt üye (sub-merchant) oluştur → subMerchantKey döner (GÜVENLİ sakla, ödeme anında şart)
export async function createSubMerchant(input: SubMerchantInput): Promise<{ subMerchantKey: string; raw: any }> {
  const c = client()
  const req: any = {
    locale: Iyzipay.LOCALE.TR,
    conversationId: input.externalId,
    subMerchantExternalId: input.externalId,
    subMerchantType: Iyzipay.SUB_MERCHANT_TYPE[input.type],
    address: input.address,
    email: input.email,
    gsmNumber: input.gsmNumber,
    name: input.name,
    iban: input.iban,
    currency: Iyzipay.CURRENCY.TRY,
  }
  if (input.type === 'PERSONAL') {
    req.contactName = input.contactName
    req.contactSurname = input.contactSurname
    req.identityNumber = input.identityNumber
  } else if (input.type === 'PRIVATE_COMPANY') {
    req.taxOffice = input.taxOffice
    req.legalCompanyTitle = input.legalCompanyTitle
    req.identityNumber = input.identityNumber
  } else {
    req.taxOffice = input.taxOffice
    req.taxNumber = input.taxNumber
    req.legalCompanyTitle = input.legalCompanyTitle
  }
  const res: any = await call(c.subMerchant.create.bind(c.subMerchant), req)
  if (res.status !== 'success') throw new Error(res.errorMessage || 'Alt üye oluşturulamadı.')
  return { subMerchantKey: res.subMerchantKey, raw: res }
}

// Alt üye durumu/bilgisi sorgula (onay durumu için)
export async function retrieveSubMerchant(externalId: string): Promise<any> {
  const c = client()
  return call(c.subMerchant.retrieve.bind(c.subMerchant), {
    locale: Iyzipay.LOCALE.TR,
    conversationId: externalId,
    subMerchantExternalId: externalId,
  })
}

export interface CheckoutInput {
  conversationId: string
  basketId: string
  price: string                 // ders fiyatı (string, ör. "300.0")
  paidPrice: string             // karttan çekilecek (kupon sonrası); puan sistemi → çoğunlukla = price
  callbackUrl: string
  buyer: {
    id: string; name: string; surname: string; email: string; gsmNumber?: string
    identityNumber: string; registrationAddress: string; ip: string; city: string; country: string
  }
  item: { id: string; name: string; category1: string; subMerchantKey: string; subMerchantPrice: string }
}

// Booking için ödeme formu başlat. Tek sepet kalemi → salonun alt-üyesine subMerchantPrice gider,
// komisyon (paidPrice - subMerchantPrice) iyzico tarafından otomatik platforma ayrılır.
export async function initCheckout(input: CheckoutInput): Promise<{ token: string; paymentPageUrl: string; checkoutFormContent: string; raw: any }> {
  const c = client()
  const addr = {
    contactName: `${input.buyer.name} ${input.buyer.surname}`,
    city: input.buyer.city, country: input.buyer.country, address: input.buyer.registrationAddress,
  }
  const req: any = {
    locale: Iyzipay.LOCALE.TR,
    conversationId: input.conversationId,
    price: input.price,
    paidPrice: input.paidPrice,
    currency: Iyzipay.CURRENCY.TRY,
    basketId: input.basketId,
    paymentGroup: Iyzipay.PAYMENT_GROUP.PRODUCT,
    callbackUrl: input.callbackUrl,
    buyer: { ...input.buyer },
    shippingAddress: addr,
    billingAddress: addr,
    basketItems: [{
      id: input.item.id,
      name: input.item.name,
      category1: input.item.category1,
      itemType: Iyzipay.BASKET_ITEM_TYPE.VIRTUAL,
      price: input.price,
      subMerchantKey: input.item.subMerchantKey,
      subMerchantPrice: input.item.subMerchantPrice,
    }],
  }
  const res: any = await call(c.checkoutFormInitialize.create.bind(c.checkoutFormInitialize), req)
  if (res.status !== 'success') throw new Error(res.errorMessage || 'Ödeme formu başlatılamadı.')
  return { token: res.token, paymentPageUrl: res.paymentPageUrl, checkoutFormContent: res.checkoutFormContent, raw: res }
}

// Ödeme sonucu doğrula (callback sonrası token ile)
export async function retrieveCheckout(token: string, conversationId: string): Promise<any> {
  const c = client()
  return call(c.checkoutForm.retrieve.bind(c.checkoutForm), {
    locale: Iyzipay.LOCALE.TR, conversationId, token,
  })
}
