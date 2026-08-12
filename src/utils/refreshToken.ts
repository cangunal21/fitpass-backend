import crypto from 'crypto'
import prisma from './prisma'
import { generateToken } from './jwt'

// Uzun ömürlü yenileme jetonu — kısa ömürlü access token süresi dolunca sessizce
// yenisini almak için. Kullanıcı hiç "tekrar giriş yap" görmez.
const REFRESH_DAYS = 180
// Döndürme parametreleri — gerekçe ve tasarım notları utils/panelRefreshToken.ts'te (ikiz uygulama).
const GRACE_MS = 5 * 60_000
const DETECTION_WINDOW_MS = 48 * 3600_000

export type TokenPair = { token: string; refreshToken: string }

// AT-REST HASH: DB'de refresh token'ın KENDİSİ değil, SHA-256 parmak izi saklanır. Refresh token
// 180 gün geçerli bir "ana anahtar"dır; düz metin saklanırsa bir DB sızıntısı/yedek kaçağı/içeriden
// erişim TÜM kullanıcıların hesabını ele geçirmeye yeter (token'ı alıp doğrudan kullanır). Parola
// hash'i gibi: sadece parmak izini tutarız, sızsa bile geri çevrilemez → çalınan DB işe yaramaz.
// Ham token yalnız client'a döner, bir daha asla saklanmaz. Döndürme + replay tespiti aşağıda (#30).
function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex')
}

// Hurda satırları süpür. DÖNDÜRÜLMÜŞ satırlar hemen silinmez: onlar replay kanıtıdır (bkz. rotateAccessToken).
async function supur(userId: number) {
  const simdi = new Date()
  await prisma.refreshToken
    .deleteMany({
      where: {
        userId,
        OR: [
          { expiresAt: { lt: simdi } },
          { revoked: true, rotatedAt: null },
          { rotatedAt: { lt: new Date(simdi.getTime() - DETECTION_WINDOW_MS) } },
        ],
      },
    })
    .catch(() => {})
}

// Yeni refresh token üret + parmak izini DB'ye kaydet, HAM token'ı döndür (client saklar).
// devral verilirse aile + son-geçerlilik DEVRALINIR: döndürülen oturum mutlak 180 günlük
// sınırı aşmasın ve aynı oturum zincirinde kalsın diye (bkz. utils/panelRefreshToken.ts).
export async function issueRefreshToken(userId: number, devral?: { family: string; expiresAt: Date }): Promise<string> {
  const raw = crypto.randomBytes(48).toString('hex')
  const token = hashToken(raw)
  const sonGecerlilik = devral?.expiresAt ?? new Date(Date.now() + REFRESH_DAYS * 86400000)
  await supur(userId)
  await prisma.refreshToken.create({
    data: { token, userId, expiresAt: sonGecerlilik, ...(devral ? { family: devral.family } : {}) },
  })
  return raw
}

/**
 * Geçerli refresh token → YENİ access + YENİ refresh (döndürme). Geçersiz/süresi dolmuş → null.
 * Döndürülmüş bir jeton grace penceresinden sonra geri gelirse REPLAY sayılır: jeton çalınmış
 * demektir, kullanıcının tüm oturumları kapatılır. Ayrıntılı gerekçe: utils/panelRefreshToken.ts.
 */
export async function rotateAccessToken(refreshToken: string): Promise<TokenPair | null> {
  if (!refreshToken) return null
  const rt = await prisma.refreshToken.findUnique({
    where: { token: hashToken(refreshToken) },
    include: { user: { select: { id: true, email: true, banned: true } } },
  })
  if (!rt || rt.expiresAt < new Date() || !rt.user) return null
  if (rt.revoked) {
    if (!rt.rotatedAt) return null // çıkış/iptal → sessiz ret
    if (Date.now() - rt.rotatedAt.getTime() > GRACE_MS) {
      console.warn('[guvenlik] refresh replay tespit edildi, oturum zinciri iptal: user', rt.userId)
      await prisma.refreshToken
        .updateMany({ where: { family: rt.family }, data: { revoked: true, rotatedAt: null } })
        .catch(() => {})
      return null
    }
  }
  if (rt.user.banned) return null // banlı kullanıcı yeni access token alamaz

  await prisma.refreshToken
    .update({ where: { id: rt.id }, data: { revoked: true, rotatedAt: rt.rotatedAt ?? new Date() } })
    .catch(() => {})
  const yeniRefresh = await issueRefreshToken(rt.userId, { family: rt.family, expiresAt: rt.expiresAt })
  return { token: generateToken({ userId: rt.user.id, email: rt.user.email }), refreshToken: yeniRefresh }
}


// Çıkışta o cihazın OTURUM ZİNCİRİNİ iptal et (halef jeton hayatta kalmasın — bkz. panelRefreshToken).
export async function revokeRefreshToken(refreshToken: string): Promise<void> {
  if (!refreshToken) return
  const rt = await prisma.refreshToken
    .findUnique({ where: { token: hashToken(refreshToken) }, select: { family: true } })
    .catch(() => null)
  if (!rt) return
  await prisma.refreshToken.updateMany({ where: { family: rt.family }, data: { revoked: true, rotatedAt: null } }).catch(() => {})
}

// Ham refresh token → sahibinin userId'si (yoksa null). Çıkışta cihazın push token'ını temizlemek için.
// AYRI FONKSİYON OLMASININ SEBEBİ: token'ın DB'de HASH'li saklandığı bilgisi bu modülde kapsüllü kalmalı.
// Daha önce authController.logout ham token'la doğrudan `refreshToken.findUnique` yapıyordu; at-rest
// hash'e geçince o sorgu SESSİZCE hep null dönmeye başladı (push token hiç temizlenmiyordu). Çağıranın
// hash'leme detayını bilmesi gerekmesin diye erişim buradan veriliyor.
export async function userIdForRefreshToken(refreshToken: string): Promise<number | null> {
  if (!refreshToken) return null
  const rt = await prisma.refreshToken
    .findUnique({ where: { token: hashToken(refreshToken) }, select: { userId: true } })
    .catch(() => null)
  return rt?.userId ?? null
}
