/// <reference types="node" />
/*
 * İyzico Pazaryeri sandbox bağlantı testi.
 * Çalıştır:  IYZICO_API_KEY=... IYZICO_SECRET_KEY=... npm run iyzico:test
 * (Anahtarlar: https://sandbox-merchant.iyzipay.com → Ayarlar > Üye İşyeri > API Anahtarları)
 *
 * Ne yapar:
 *  1) Test bir PERSONAL alt-üye (sub-merchant) oluşturur → subMerchantKey alır
 *  2) O alt-üyeye giden bir ödeme formu (checkout) başlatır → paymentPageUrl alır
 *  Her ikisi de 'success' dönerse sandbox bağlantısı ÇALIŞIYOR demektir.
 */
import 'dotenv/config'
import { isPaymentConfigured, isSandbox, createSubMerchant, initCheckout } from '../src/utils/payment'

async function main() {
  console.log('\n=== İYZİCO SANDBOX TEST ===')
  if (!isPaymentConfigured()) {
    console.log('❌ Anahtar yok. Şöyle çalıştır:')
    console.log('   IYZICO_API_KEY=sandbox-xxx IYZICO_SECRET_KEY=sandbox-yyy npm run iyzico:test')
    console.log('   (ücretsiz: https://sandbox-merchant.iyzipay.com → Ayarlar > Üye İşyeri > API Anahtarları)')
    process.exit(1)
  }
  console.log('Ortam:', isSandbox() ? 'SANDBOX ✅' : '⚠️ PRODUCTION (dikkat!)')

  // 1) Alt üye oluştur
  const externalId = `test-venue-${Date.now()}`
  console.log('\n[1] Alt üye (PERSONAL) oluşturuluyor...')
  const sm = await createSubMerchant({
    externalId,
    type: 'PERSONAL',
    address: 'Merdivenköy Mah. Bora Sok. No:1, Kadıköy/İstanbul',
    email: 'test@sipsakspor.com',
    gsmNumber: '+905350000000',
    name: 'Test Salon',
    iban: 'TR180006200119000006672315',
    contactName: 'Test',
    contactSurname: 'Salon',
    identityNumber: '11111111110',
  })
  console.log('   ✅ subMerchantKey:', sm.subMerchantKey)

  // 2) Bu alt üyeye giden ödeme formu başlat
  console.log('\n[2] Ödeme formu (checkout) başlatılıyor...')
  const co = await initCheckout({
    conversationId: externalId,
    basketId: `BK-${Date.now()}`,
    price: '300.0',
    paidPrice: '300.0',
    callbackUrl: 'https://sipsakspor.com/odeme/callback',
    buyer: {
      id: 'BUYER-1', name: 'Ali', surname: 'Veli', email: 'ali@example.com',
      gsmNumber: '+905350000001', identityNumber: '11111111110',
      registrationAddress: 'Kadıköy, İstanbul', ip: '85.34.78.112', city: 'Istanbul', country: 'Turkey',
    },
    // Salonun payı: 300 ders, %5 komisyon → 285 salona; 15 platforma (iyzico otomatik ayırır)
    item: { id: 'CLASS-1', name: 'Vinyasa Yoga', category1: 'Spor', subMerchantKey: sm.subMerchantKey, subMerchantPrice: '285.0' },
  })
  console.log('   ✅ token:', co.token)
  console.log('   ✅ Ödeme sayfası URL:', co.paymentPageUrl)

  console.log('\n🎉 SANDBOX BAĞLANTISI ÇALIŞIYOR — alt üye + ödeme formu başarıyla oluşturuldu.')
  console.log('   (paymentPageUrl tarayıcıda açılıp test kartıyla denenebilir: 5528790000000008, son kullanma 12/30, CVC 123, OTP 123456)')
}

main().catch((e) => {
  console.error('\n❌ HATA:', e?.message || e)
  process.exit(1)
})
