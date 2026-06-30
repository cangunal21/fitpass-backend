import crypto from 'crypto'
import prisma from './prisma'
import { generateToken } from './jwt'

// Uzun ömürlü yenileme jetonu — kısa ömürlü access token süresi dolunca sessizce
// yenisini almak için. Kullanıcı hiç "tekrar giriş yap" görmez.
const REFRESH_DAYS = 180

// Yeni refresh token üret + DB'ye kaydet, ham token'ı döndür.
export async function issueRefreshToken(userId: number): Promise<string> {
  const token = crypto.randomBytes(48).toString('hex')
  const expiresAt = new Date(Date.now() + REFRESH_DAYS * 86400000)
  await prisma.refreshToken.create({ data: { token, userId, expiresAt } })
  return token
}

// Geçerli refresh token → yeni access token. Geçersiz/süresi dolmuş/iptal → null.
export async function rotateAccessToken(refreshToken: string): Promise<string | null> {
  if (!refreshToken) return null
  const rt = await prisma.refreshToken.findUnique({
    where: { token: refreshToken },
    include: { user: { select: { id: true, email: true } } },
  })
  if (!rt || rt.revoked || rt.expiresAt < new Date() || !rt.user) return null
  return generateToken({ userId: rt.user.id, email: rt.user.email })
}

// Çıkışta refresh token'ı iptal et (artık yenileme yapamaz).
export async function revokeRefreshToken(refreshToken: string): Promise<void> {
  if (!refreshToken) return
  await prisma.refreshToken.updateMany({ where: { token: refreshToken }, data: { revoked: true } }).catch(() => {})
}
