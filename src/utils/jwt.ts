import jwt from 'jsonwebtoken'

const JWT_SECRET = process.env.JWT_SECRET || 'fitpass-secret-key-change-in-production'

// Kullanıcı access token'ı KISA (1 saat): client 401'de refresh token ile sessizce yeniler,
// böylece çıkış / şifre değişimi / token sızması penceresi 7 gün yerine ~1 saat olur
// (JWT stateless — iptal edilemez, tek koruma kısa ömür). Venue (salon) token'ı UZUN (7 gün)
// çünkü salon panelinde henüz refresh mekanizması yok; kısaltmak salonları saat başı atardı.
export const generateToken = (payload: { userId?: number; venueId?: number; email: string; role?: string }) => {
  const expiresIn = payload.venueId ? '7d' : '1h'
  return jwt.sign(payload, JWT_SECRET, { expiresIn })
}

export const verifyToken = (token: string) => {
  return jwt.verify(token, JWT_SECRET) as { userId?: number; venueId?: number; email: string; role?: string }
}
