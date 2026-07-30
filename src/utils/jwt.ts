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

// Kullanıcı access token'ı KISA (1 saat): client 401'de refresh token ile sessizce yeniler,
// böylece çıkış / şifre değişimi / token sızması penceresi 7 gün yerine ~1 saat olur
// (JWT stateless — iptal edilemez, tek koruma kısa ömür). Venue (salon) token'ı UZUN (7 gün)
// çünkü salon panelinde henüz refresh mekanizması yok; kısaltmak salonları saat başı atardı.
export const generateToken = (payload: { userId?: number; venueId?: number; instructorId?: number; email: string; role?: string }) => {
  // Salon ve eğitmen panellerinde refresh mekanizması yok → 7 gün (aksi halde saat başı atılırlar).
  // Kullanıcı access token'ı kısa (1 saat) çünkü client refresh ile sessizce yeniler.
  const expiresIn = payload.venueId || payload.instructorId ? '7d' : '1h'
  return jwt.sign(payload, JWT_SECRET, { expiresIn })
}

export const verifyToken = (token: string) => {
  return jwt.verify(token, JWT_SECRET) as { userId?: number; venueId?: number; instructorId?: number; email: string; role?: string }
}
