import crypto from 'crypto'
import prisma from './prisma'
import { generateToken } from './jwt'

/**
 * SALON / EĞİTMEN YENİLEME JETONU (task #30)
 *
 * NEDEN: kullanıcı realm'inde kısa access token (1 saat) + refresh vardı; panel realm'lerinde
 * YOKTU. Bu yüzden salon/eğitmen access token'ı 7 GÜN yaşıyordu — kısaltmak, refresh olmadığı
 * için salonları saat başı dışarı atmak demekti. Salon paneli IBAN, vergi no, TCKN, KYC
 * belgeleri ve gelir raporu taşıdığı için çalınan bir token'ın 7 gün geçerli kalması en büyük
 * açıklardan biriydi. Refresh mekanizmasıyla artık access token 1 saat, oturum ise kesintisiz.
 *
 * Tasarım kullanıcı realm'iyle (utils/refreshToken.ts) BİLEREK aynı:
 *  • DB'de ham token değil SHA-256 parmak izi durur (sızan yedek işe yaramaz)
 *  • yeni jeton üretilirken o hesabın süresi dolmuş/iptal edilmiş satırları süpürülür
 *  • parola değişince tüm jetonlar iptal edilir
 */

const REFRESH_DAYS = 180

export type PanelRealm = { venueId: number } | { instructorId: number }

function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex')
}

/** Yeni refresh token üret + parmak izini kaydet, HAM token'ı döndür (yalnız client saklar). */
export async function issuePanelRefreshToken(realm: PanelRealm): Promise<string> {
  const raw = crypto.randomBytes(48).toString('hex')
  const token = hashToken(raw)
  const expiresAt = new Date(Date.now() + REFRESH_DAYS * 86400000)
  const sahip = 'venueId' in realm ? { venueId: realm.venueId } : { instructorId: realm.instructorId }

  // Hurda satırları süpür: her biri bağımsız çalınabilir 180 günlük bir kimlik bilgisidir.
  await prisma.panelRefreshToken
    .deleteMany({ where: { ...sahip, OR: [{ expiresAt: { lt: new Date() } }, { revoked: true }] } })
    .catch(() => {})
  await prisma.panelRefreshToken.create({ data: { token, expiresAt, ...sahip } })
  return raw
}

/**
 * Geçerli refresh token → yeni access token. Geçersiz/süresi dolmuş/iptal → null.
 * Hesap durumu HER YENİLEMEDE tazelenir: askıya alınmış/pasif salon ya da pasif eğitmen
 * yeni token ALAMAZ (aksi halde moderasyon kararı 180 gün boyunca baypas edilebilirdi).
 */
export async function rotatePanelAccessToken(refreshToken: string): Promise<string | null> {
  if (!refreshToken) return null
  const rt = await prisma.panelRefreshToken.findUnique({
    where: { token: hashToken(refreshToken) },
    include: {
      venue: { select: { id: true, email: true, isActive: true, isSuspended: true } },
      instructor: { select: { id: true, email: true, isActive: true } },
    },
  })
  if (!rt || rt.revoked || rt.expiresAt < new Date()) return null

  if (rt.venue) {
    if (rt.venue.isSuspended || rt.venue.isActive === false) return null
    return generateToken({ venueId: rt.venue.id, email: rt.venue.email ?? '', role: 'venue' })
  }
  if (rt.instructor) {
    if (rt.instructor.isActive === false) return null
    return generateToken({ instructorId: rt.instructor.id, email: rt.instructor.email ?? '', role: 'instructor' })
  }
  return null
}

/** Çıkışta tek jetonu iptal et. */
export async function revokePanelRefreshToken(refreshToken: string): Promise<void> {
  if (!refreshToken) return
  await prisma.panelRefreshToken
    .updateMany({ where: { token: hashToken(refreshToken) }, data: { revoked: true } })
    .catch(() => {})
}

/**
 * Bir hesabın TÜM jetonlarını iptal et. Parola değişiminde çağrılır: access token zaten
 * passwordChangedAt damgasıyla geçersiz kılınıyor, ama refresh jetonu iptal edilmezse
 * saldırgan onunla yeni access token üretmeye devam ederdi (180 gün).
 */
export async function revokeAllPanelRefreshTokens(realm: PanelRealm): Promise<void> {
  const sahip = 'venueId' in realm ? { venueId: realm.venueId } : { instructorId: realm.instructorId }
  await prisma.panelRefreshToken.updateMany({ where: sahip, data: { revoked: true } }).catch(() => {})
}
