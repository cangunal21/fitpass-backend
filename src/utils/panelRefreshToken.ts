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

/**
 * DÖNDÜRME (rotation) + REPLAY TESPİTİ
 *
 * Her yenilemede refresh jetonu da değişir; eskisi iptal edilir. Böylece çalınan bir jeton
 * yalnız BİR kez işe yarar. Asıl kazanç şu: meşru istemci eski jetonuyla döndüğünde sunucu
 * "bu jeton zaten kullanılmıştı" der — yani hırsızlık ANLAŞILIR ve o hesabın TÜM jetonları
 * iptal edilir. Döndürme olmasaydı hırsız 180 gün boyunca sessizce oturum yenilerdi.
 *
 * GRACE (yarış payı): iki sekme/istek aynı anda yenilemeye kalkarsa ikisi de eski jetonu
 * gönderir — bu hırsızlık değil, yarıştır. Döndürmenin üstünden GRACE_MS geçmediyse replay
 * alarmı çalmaz, taze bir çift verilir. Aksi halde kullanıcılar rastgele dışarı atılırdı.
 *
 * MUTLAK OTURUM ÖMRÜ: yeni jeton eskinin expiresAt'ini DEVRALIR. Yoksa sonsuz yenilenen
 * bir oturum 180 günlük sınırı hiç görmezdi.
 */
const GRACE_MS = 60_000
const DETECTION_WINDOW_MS = 48 * 3600_000 // döndürülmüş satırlar bu kadar süre replay kanıtı olarak durur

export type PanelPair = { token: string; refreshToken: string }

export type PanelRealm = { venueId: number } | { instructorId: number }

function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex')
}

function sahibi(realm: PanelRealm) {
  return 'venueId' in realm ? { venueId: realm.venueId } : { instructorId: realm.instructorId }
}

/**
 * Hurda satırları süpür. DÖNDÜRÜLMÜŞ satırlar hemen silinemez — onlar replay kanıtıdır;
 * silinirse çalınan jeton "bulunamadı" diye sessizce reddedilir, hırsızlık fark edilmez.
 * DETECTION_WINDOW_MS sonra silinir (meşru istemci çok daha önce yenilemiş olur).
 */
async function supur(realm: PanelRealm) {
  const simdi = new Date()
  await prisma.panelRefreshToken
    .deleteMany({
      where: {
        ...sahibi(realm),
        OR: [
          { expiresAt: { lt: simdi } },
          { revoked: true, rotatedAt: null }, // çıkış/parola iptali: kanıt değeri yok
          { rotatedAt: { lt: new Date(simdi.getTime() - DETECTION_WINDOW_MS) } },
        ],
      },
    })
    .catch(() => {})
}

/**
 * Yeni refresh token üret + parmak izini kaydet, HAM token'ı döndür (yalnız client saklar).
 * family/expiresAt verilirse DEVRALINIR (döndürme); verilmezse yeni oturum zinciri başlar (giriş).
 */
export async function issuePanelRefreshToken(realm: PanelRealm, devral?: { family: string; expiresAt: Date }): Promise<string> {
  const raw = crypto.randomBytes(48).toString('hex')
  const token = hashToken(raw)
  const sonGecerlilik = devral?.expiresAt ?? new Date(Date.now() + REFRESH_DAYS * 86400000)

  await supur(realm)
  await prisma.panelRefreshToken.create({
    data: { token, expiresAt: sonGecerlilik, ...(devral ? { family: devral.family } : {}), ...sahibi(realm) },
  })
  return raw
}

/**
 * Geçerli refresh token → yeni access token. Geçersiz/süresi dolmuş/iptal → null.
 * Hesap durumu HER YENİLEMEDE tazelenir: askıya alınmış/pasif salon ya da pasif eğitmen
 * yeni token ALAMAZ (aksi halde moderasyon kararı 180 gün boyunca baypas edilebilirdi).
 */
export async function rotatePanelAccessToken(refreshToken: string): Promise<PanelPair | null> {
  if (!refreshToken) return null
  const rt = await prisma.panelRefreshToken.findUnique({
    where: { token: hashToken(refreshToken) },
    include: {
      venue: { select: { id: true, email: true, isActive: true, isSuspended: true } },
      instructor: { select: { id: true, email: true, isActive: true } },
    },
  })
  if (!rt || rt.expiresAt < new Date()) return null

  const realm: PanelRealm | null = rt.venueId
    ? { venueId: rt.venueId }
    : rt.instructorId
      ? { instructorId: rt.instructorId }
      : null
  if (!realm) return null

  if (rt.revoked) {
    // Çıkış/parola değişimi iptali (rotatedAt boş) → sessiz ret.
    if (!rt.rotatedAt) return null
    // Döndürülmüş jeton geri geldi. Yarış payı içindeyse meşru kabul et; değilse REPLAY:
    // jeton çalınmış demektir, hesabın tüm oturumlarını kapat (hırsız da dışarı atılır).
    if (Date.now() - rt.rotatedAt.getTime() > GRACE_MS) {
      // O OTURUM ZİNCİRİNİ kapat. Hesabın tamamını değil: jeton çalınmış olabilir ama diğer
      // cihazların oturumları bundan etkilenmemeli (aksi halde bir replay kullanıcıyı her
      // yerden dışarı atardı). Hırsız zaten bu ailenin içinde — ailenin kapanması onu kilitler.
      console.warn('[guvenlik] panel refresh replay tespit edildi, oturum zinciri iptal:', sahibi(realm))
      await prisma.panelRefreshToken
        .updateMany({ where: { family: rt.family }, data: { revoked: true, rotatedAt: null } })
        .catch(() => {})
      return null
    }
  }

  let token: string | null = null
  if (rt.venue) {
    if (rt.venue.isSuspended || rt.venue.isActive === false) return null
    token = generateToken({ venueId: rt.venue.id, email: rt.venue.email ?? '', role: 'venue' })
  } else if (rt.instructor) {
    if (rt.instructor.isActive === false) return null
    token = generateToken({ instructorId: rt.instructor.id, email: rt.instructor.email ?? '', role: 'instructor' })
  }
  if (!token) return null

  // Eskisini döndürülmüş olarak damgala, yenisini AYNI son-geçerlilikle üret.
  await prisma.panelRefreshToken
    // rotatedAt İLK döndürmede sabitlenir. Her replay'de tazelenseydi, saldırgan aynı jetonu
    // 60 saniyeden sık kullanarak grace penceresini sonsuza kadar açık tutabilirdi.
    .update({ where: { id: rt.id }, data: { revoked: true, rotatedAt: rt.rotatedAt ?? new Date() } })
    .catch(() => {})
  const yeniRefresh = await issuePanelRefreshToken(realm, { family: rt.family, expiresAt: rt.expiresAt })
  return { token, refreshToken: yeniRefresh }
}

/**
 * Çıkışta o cihazın OTURUM ZİNCİRİNİ kapat. Yalnız gönderilen satır iptal edilseydi, döndürme
 * yüzünden aynı zincirdeki halef jeton hayatta kalır ve "çıkış yaptım" diyen kullanıcının
 * oturumu açık kalırdı. rotatedAt sıfırlanır: iptal edilen jeton grace penceresiyle dirilmesin.
 */
export async function revokePanelRefreshToken(refreshToken: string): Promise<void> {
  if (!refreshToken) return
  const rt = await prisma.panelRefreshToken
    .findUnique({ where: { token: hashToken(refreshToken) }, select: { family: true } })
    .catch(() => null)
  if (!rt) return
  await prisma.panelRefreshToken
    .updateMany({ where: { family: rt.family }, data: { revoked: true, rotatedAt: null } })
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
