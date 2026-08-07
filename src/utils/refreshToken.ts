import crypto from 'crypto'
import prisma from './prisma'
import { generateToken } from './jwt'

// Uzun ömürlü yenileme jetonu — kısa ömürlü access token süresi dolunca sessizce
// yenisini almak için. Kullanıcı hiç "tekrar giriş yap" görmez.
const REFRESH_DAYS = 180

// AT-REST HASH: DB'de refresh token'ın KENDİSİ değil, SHA-256 parmak izi saklanır. Refresh token
// 180 gün geçerli bir "ana anahtar"dır; düz metin saklanırsa bir DB sızıntısı/yedek kaçağı/içeriden
// erişim TÜM kullanıcıların hesabını ele geçirmeye yeter (token'ı alıp doğrudan kullanır). Parola
// hash'i gibi: sadece parmak izini tutarız, sızsa bile geri çevrilemez → çalınan DB işe yaramaz.
// Ham token yalnız client'a döner, bir daha asla saklanmaz. (Rotation/reuse-detection ayrı iş → #30.)
function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex')
}

// Yeni refresh token üret + parmak izini DB'ye kaydet, HAM token'ı döndür (client saklar).
export async function issueRefreshToken(userId: number): Promise<string> {
  const raw = crypto.randomBytes(48).toString('hex')
  const token = hashToken(raw)
  const expiresAt = new Date(Date.now() + REFRESH_DAYS * 86400000)
  // Süresi geçmiş/iptal edilmiş eski token'ları temizle — kullanıcı başına sınırsız birikmesin (tablo şişmesi
  // + her biri bağımsız çalınabilir 180-günlük kimlik bilgisi olan hurda satırlar). Yeni token'dan önce süpür.
  await prisma.refreshToken.deleteMany({ where: { userId, OR: [{ expiresAt: { lt: new Date() } }, { revoked: true }] } }).catch(() => {})
  await prisma.refreshToken.create({ data: { token, userId, expiresAt } })
  return raw
}

// Geçerli refresh token → yeni access token. Geçersiz/süresi dolmuş/iptal → null.
export async function rotateAccessToken(refreshToken: string): Promise<string | null> {
  if (!refreshToken) return null
  const rt = await prisma.refreshToken.findUnique({
    where: { token: hashToken(refreshToken) },
    include: { user: { select: { id: true, email: true, banned: true } } },
  })
  if (!rt || rt.revoked || rt.expiresAt < new Date() || !rt.user) return null
  if (rt.user.banned) return null // banlı kullanıcı yeni access token alamaz
  return generateToken({ userId: rt.user.id, email: rt.user.email })
}

// Çıkışta refresh token'ı iptal et (artık yenileme yapamaz).
export async function revokeRefreshToken(refreshToken: string): Promise<void> {
  if (!refreshToken) return
  await prisma.refreshToken.updateMany({ where: { token: hashToken(refreshToken) }, data: { revoked: true } }).catch(() => {})
}
