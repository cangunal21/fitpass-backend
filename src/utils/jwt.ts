import jwt from 'jsonwebtoken'

// Kaynağa GÖMÜLÜ varsayılan YOK. Eskiden 'fitpass-secret-key-change-in-production' vardı ve bu
// repo (cangunal21/fitpass-backend) PUBLIC — yani imzalama anahtarının yedek değeri herkese açıktı.
// Tek koruma index.ts'teki `NODE_ENV === 'production'` TAM EŞİTLİĞİYDİ: NODE_ENV set edilmemişse
// ya da 'Production'/'prod' yazılmışsa fail-fast HİÇ çalışmıyor, sunucu bu bilinen anahtarla token
// imzalamaya devam ediyordu. O durumda herkes {userId:N} ya da {venueId:N, role:'venue'} token'ı
// üretip her hesabı ele geçirebilir (salon /me ucu iban, taxNumber, identityNumber, kycDocs döner).
// adminAuth.ts ve cronController.ts bu tedaviyi çoktan görmüştü; jwt.ts geride kalmıştı.
// Artık ortamdan bağımsız: anahtar yoksa modül yüklenirken patlar, sunucu hiç açılmaz.
const JWT_SECRET = process.env.JWT_SECRET || ''
if (!JWT_SECRET) {
  throw new Error('FATAL: JWT_SECRET set edilmeli. Gömülü varsayılan YOK (public repo). .env dosyanıza ekleyin.')
}

// TÜM realm'lerde access token KISA (1 saat): client 401'de refresh token ile sessizce yeniler.
// JWT stateless'tır — tek tek iptal edilemez, tek gerçek koruma kısa ömürdür.
//
// SALON/EĞİTMEN eskiden 7 GÜNDÜ çünkü panel realm'lerinde refresh mekanizması yoktu (kısaltmak
// onları saat başı dışarı atardı). Salon paneli IBAN, vergi no, TCKN, KYC belgeleri ve gelir
// raporu taşıdığı için çalınan bir token'ın 7 gün geçerli kalması en büyük açıklardan biriydi.
// utils/panelRefreshToken.ts ile refresh eklendi → artık üç realm de 1 saat.
export const generateToken = (payload: { userId?: number; venueId?: number; instructorId?: number; email: string; role?: string }) => {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' })
}

export const verifyToken = (token: string) => {
  return jwt.verify(token, JWT_SECRET) as { userId?: number; venueId?: number; instructorId?: number; email: string; role?: string }
}
