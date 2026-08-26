import { Request, Response } from 'express'
import bcrypt from 'bcryptjs'
import crypto from 'crypto'
import prisma from '../utils/prisma'
import { generateToken } from '../utils/jwt'
import { issueRefreshToken, rotateAccessToken, revokeRefreshToken, userIdForRefreshToken } from '../utils/refreshToken'
import { sendWelcomeEmail, sendPasswordResetEmail, sendEmailVerificationEmail, sendBadgeEmail } from '../utils/email'
import { applyReferralCode } from './referralController'
import { syncUserTier, resetYearlyPointsIfNeeded } from '../utils/tier'
import { syncUserBadges } from '../utils/badges'
import { seasonLabelsFromKey } from '../utils/season'
import { purgeUserReviews, purgeUserComments } from '../utils/moderation'
import { invalidate } from '../utils/cache'
import { gorselUrlGecerliMi } from '../utils/sanitize'
import { dogrulamaKoduUret, dogrulamaKoduDogrula, KOD_OMRU_DK } from '../utils/verificationCode'
import { localeFromReq, Locale } from '../utils/locale'
import { cityIdOfNeighborhood } from '../utils/geo'
import { notifyFields, notifyPush, NotifyParams } from '../utils/notifyText'
import { sendPushNotification } from '../utils/push'
import { MIN_PASSWORD, clampStr, isValidEmail, parseIntSafe } from '../utils/validate'
import { eksikZorunluOnaylar, eksikOnayMesaji, onaylariKaydet } from '../utils/consent'
import { finansalArsivle } from '../utils/finansalArsiv'

// KAYIT OL
export const register = async (req: Request, res: Response) => {
  try {
    const { username, email, phone, password, fullName, referralCode, preferredSports, preferredNeighborhoods, onaylar } = req.body
    const cleanSports = Array.isArray(preferredSports) ? preferredSports.filter((s: any) => typeof s === 'string').slice(0, 20) : []
    const cleanNeighborhoods = Array.isArray(preferredNeighborhoods) ? preferredNeighborhoods.map((n: any) => parseInt(n)).filter((n: any) => !isNaN(n)).slice(0, 20) : []

    if (!username || !email || !password || !fullName) {
      return res.status(400).json({ error: 'Tüm zorunlu alanları doldurun.' })
    }

    // Sözleşme onayı HESAP AÇILMADAN ÖNCE doğrulanır. Sonra kontrol etmek, onaysız bir
    // hesabın bir an için var olmasına izin vermek demektir.
    const eksik = eksikZorunluOnaylar('user', onaylar)
    if (eksik.length) {
      return res.status(400).json({ error: eksikOnayMesaji(eksik), eksikOnaylar: eksik })
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Geçerli bir e-posta adresi girin.' })
    }

    if (password.length < MIN_PASSWORD) {
      return res.status(400).json({ error: `Şifre en az ${MIN_PASSWORD} karakter olmalı.` })
    }

    // Kullanıcı adı formatı: 3-30 karakter, sadece harf/rakam/nokta/alt çizgi.
    // (Boşluk, /, @, unicode vb. profil URL'lerini bozar + impersonation riski.)
    const uname = String(username).trim()
    if (!/^[a-zA-Z0-9._]{3,30}$/.test(uname)) {
      return res.status(400).json({ error: 'Kullanıcı adı 3-30 karakter olmalı; yalnızca harf, rakam, nokta ve alt çizgi.' })
    }
    // E-posta case-insensitive: normalize (Ali@X.com = ali@x.com) → çift hesap + giriş uyumsuzluğu önlenir
    const cleanEmail = String(email).trim().toLowerCase()

    // Mevcut kullanıcı kontrolü (case-insensitive — "Ali"/"ali" veya "A@x"/"a@x" çakışsın)
    const existingUser = await prisma.user.findFirst({
      where: { OR: [{ email: { equals: cleanEmail, mode: 'insensitive' } }, { username: { equals: uname, mode: 'insensitive' } }] }
    })

    if (existingUser) {
      if (existingUser.email.toLowerCase() === cleanEmail) {
        return res.status(400).json({ error: 'Bu e-posta zaten kullanılıyor.' })
      }
      return res.status(400).json({ error: 'Bu kullanıcı adı zaten alınmış.' })
    }

    const passwordHash = await bcrypt.hash(password, 12)

    const user = await prisma.user.create({
      data: {
        username: uname,
        email: cleanEmail,
        phone: clampStr(phone, 30) || null,
        passwordHash,
        fullName: clampStr(fullName, 80) || '',
        // Kayıt anındaki arayüz dili: hoş geldin + doğrulama e-postası bu dille gider. Sonra her
        // istekte X-Locale ile senkron kalır (authMiddleware.syncLocale).
        locale: localeFromReq(req),
        tierId: 1, // Aday tier (pointRate %1) — atanmazsa ilk getMe'ye kadar tier null → ilk booking pointRate 0
        preferredSports: cleanSports,
        preferredNeighborhoods: cleanNeighborhoods,
        // İlk tercih mahallesi varsa kullanıcının mahallesi olarak da ata
        neighborhoodId: cleanNeighborhoods[0] || undefined,
        // cityId SABİT 1 yazılıyordu → seçilen ilk mahalleden türet (bkz. utils/geo.ts).
        cityId: (await cityIdOfNeighborhood(cleanNeighborhoods[0])) ?? undefined,
      },
      select: {
        id: true,
        username: true,
        email: true,
        fullName: true,
        createdAt: true,
      }
    })

    // Onay kaydı — hesap açıldıktan HEMEN sonra, ispat yükü bizde olduğu için.
    await onaylariKaydet(req, 'user', user.id, onaylar)

    const token = generateToken({ userId: user.id, email: user.email })

    // DOĞRULAMA KODU (link değil — bkz. utils/verificationCode.ts). Kayıt tamamlanmış sayılmaz:
    // kullanıcı kodu girene kadar hesap DOĞRULANMAMIŞ kalır ve yazma uçları kapalıdır
    // (middlewares/requireVerified.ts). Böylece başkasının e-postasıyla kayıt olan biri
    // o hesapla hiçbir şey yapamaz.
    const kod = await dogrulamaKoduUret(user.id)
    // SONUÇ BEKLENİYOR — ateşle-unut DEĞİL.
    //
    // Eskiden bu çağrı beklenmiyor, `emailVerificationSent: true` SABİT dönüyordu. Resend
    // düşerse (kota, domain doğrulaması, 5xx) ya da RESEND_API_KEY hiç yoksa gönderici
    // sessizce dönüyordu: kullanıcı "kod gönderdik" ekranını görüyor, kod hiç gelmiyor,
    // "tekrar gönder" aynı sessiz yolu izliyordu. E-posta doğrulaması rezervasyonun ÖN KOŞULU
    // olduğu için tüm dönüşüm hunisi sessizce duruyordu.
    //
    // Gönderim ~8sn timeout'lu (utils/email.ts) — kaydı süresiz bekletmez. Başarısızsa
    // kullanıcıya DÜRÜST bir bayrak dönüyoruz; istemci "kod gönderilemedi, tekrar dene"
    // gösterebiliyor. Hesap yine oluşturuldu, kod yine üretildi: kullanıcı "tekrar gönder"
    // ile devam edebilir.
    const postaSonucu = await sendEmailVerificationEmail(user.email, user.fullName, kod, localeFromReq(req))
      .catch((err) => { console.error('Verify mail gönderilemedi:', err); return { error: { message: String(err?.message || err) } } })
    const postaGitti = !(postaSonucu as any)?.error

    // Referral kodu varsa uygula
    if (referralCode) {
      applyReferralCode(user.id, referralCode.trim().toUpperCase()).catch(() => {})
    }

    const refreshToken = await issueRefreshToken(user.id)
    return res.status(201).json({
      message: postaGitti
        ? `Kayıt alındı! E-posta adresine 6 haneli doğrulama kodu gönderdik (${KOD_OMRU_DK} dakika geçerli).`
        : 'Kayıt alındı ancak doğrulama e-postası gönderilemedi. Lütfen kod ekranından "tekrar gönder" deneyin.',
      token,
      refreshToken,
      user,
      // ARTIK SABİT DEĞİL: gönderim gerçekten başarılı olduysa true. İstemci false görürse
      // kullanıcıya "gelmedi mi? tekrar gönder" yolunu öne çıkarabilir.
      emailVerificationSent: postaGitti,
      // İstemci bu bayrağa bakıp kod ekranını açar. Kod girilmeden yazma uçları 403 döner.
      requiresEmailVerification: true,
    })
  } catch (error: any) {
    if (error?.code === 'P2002') {
      return res.status(400).json({ error: 'Bu e-posta veya kullanıcı adı zaten kullanılıyor.' })
    }
    console.error('Register error:', error)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// GİRİŞ YAP
const DUMMY_HASH = bcrypt.hashSync('sipsakspor-timing-guard', 12) // hesap-enumerasyonu timing oracle'ını kapatır

export const login = async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body

    if (!email || !password) {
      return res.status(400).json({ error: 'E-posta ve şifre gerekli.' })
    }

    // PERFORMANS: `mode:'insensitive'` Prisma'da ILIKE üretir ve User.email üzerindeki @unique btree
    // index'i KULLANILAMAZ → her giriş/şifre-sıfırlama isteği tüm User tablosunu tarardı.
    // Kayıt e-postayı küçük harfle sakladığından (cleanEmail) hızlı yol findUnique ile index'e düşer;
    // normalizasyon öncesi kalmış olabilecek eski karışık-harfli kayıtlar için insensitive yedek korunur.
    const cleanEmail = String(email).trim().toLowerCase()
    const user = await prisma.user.findUnique({ where: { email: cleanEmail } })
      ?? await prisma.user.findFirst({ where: { email: { equals: cleanEmail, mode: 'insensitive' } } })

    if (!user) {
      await bcrypt.compare(String(password), DUMMY_HASH).catch(() => {}) // timing'i eşitle (enumeration önleme — eğitmen realm'iyle aynı)
      return res.status(401).json({ error: 'E-posta veya şifre hatalı.' })
    }

    const isValid = await bcrypt.compare(password, user.passwordHash)

    if (!isValid) {
      return res.status(401).json({ error: 'E-posta veya şifre hatalı.' })
    }

    if (user.banned) {
      return res.status(403).json({ error: 'Hesabınız askıya alınmıştır. Destek ile iletişime geçin.' })
    }

    const token = generateToken({ userId: user.id, email: user.email })
    const refreshToken = await issueRefreshToken(user.id)

    return res.json({
      message: 'Giriş başarılı!',
      token,
      refreshToken,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        fullName: user.fullName,
        avatarUrl: user.avatarUrl,
        // neighborhoodId: web/mobil "Bana yakın" sıralaması bu alanı istemciden gönderiyor
        // (params.userNeighborhoodId). Login yanıtında YOKTU → getUser() hep undefined
        // döndürüyor, parametre hiç gitmiyor ve sunucu mesafeye göre sıralamayı SESSİZCE
        // atlayıp normal sıralama uyguluyordu: özellik hiç çalışmıyordu.
        neighborhoodId: user.neighborhoodId ?? null,
        // Doğrulanmamış hesap girişte kod ekranına yönlendirilmeli: kayıt yarım kaldıysa
        // kullanıcı sebebini anlamadan rezervasyon uçlarından 403 alırdı.
        isEmailVerified: user.isEmailVerified,
      },
      requiresEmailVerification: !user.isEmailVerified,
    })
  } catch (error) {
    console.error('Login error:', error)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// ACCESS TOKEN YENİLE — refresh token ile yeni access token (kullanıcı çıkış görmez)
export const refreshAccessToken = async (req: Request, res: Response) => {
  try {
    const { refreshToken } = req.body
    const cift = await rotateAccessToken(String(refreshToken || ''))
    if (!cift) return res.status(401).json({ error: 'Oturum süresi doldu, tekrar giriş yapın.' })
    // refreshToken da DEĞİŞİR: client yenisini saklamalı (çalınan jeton tek kullanımlık olsun diye).
    return res.json({ token: cift.token, refreshToken: cift.refreshToken })
  } catch (err) {
    console.error('Refresh error:', err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// ÇIKIŞ — refresh token'ı iptal et (artık yenileme yapamaz)
export const logout = async (req: Request, res: Response) => {
  try {
    const { refreshToken } = req.body
    if (refreshToken) {
      // Cihazın push token'ını sahibinden temizle — çıkış sonrası bu cihaza bildirim gitmesin
      // (ve sonraki kullanıcı girip kendi token'ını kaydedene kadar boşta kalsın).
      const ownerId = await userIdForRefreshToken(String(refreshToken))
      if (ownerId) await prisma.user.update({ where: { id: ownerId }, data: { pushToken: null } }).catch(() => {})
      await revokeRefreshToken(String(refreshToken))
    }
    return res.json({ message: 'Çıkış yapıldı.' })
  } catch {
    return res.json({ message: 'Çıkış yapıldı.' })
  }
}

// BENİ GETİR
export const getMe = async (req: Request & { userId?: number }, res: Response) => {
  try {
    if (req.userId) {
      try {
        await syncUserTier(req.userId)
        await resetYearlyPointsIfNeeded(req.userId)
        const newBadges = await syncUserBadges(req.userId)
        // Yeni rozet kazanıldıysa bildir (push + e-posta + uygulama içi)
        if (newBadges.length > 0) {
          const u = await prisma.user.findUnique({ where: { id: req.userId }, select: { pushToken: true, email: true, fullName: true, emailReminders: true, locale: true } })
          const bLoc = (u?.locale || 'tr') as Locale
          // NOT: rozet ADLARI veritabanında Türkçe seed'li (ensureBadges) — bu parametre çevrilmez.
          // Rozet adlarının da çevrilmesi ayrı iş (badges.ts'in ad yerine anahtar döndürmesi gerekir;
          // "spor ustası" gibi dinamik adlar sabit anahtara oturmuyor).
          const bKey = newBadges.length === 1 ? 'badge_one' : 'badge_many'
          const bParams: NotifyParams = newBadges.length === 1 ? { badge: newBadges[0] } : { count: newBadges.length }
          await prisma.notification.create({ data: { userId: req.userId, type: 'badge', ...notifyFields(bLoc, bKey, bParams) } }).catch(() => {})
          const bPush = notifyPush(bLoc, bKey, bParams)
          if (u?.pushToken && bPush) sendPushNotification(u.pushToken, bPush.title, bPush.body).catch(() => {})
          if (u?.email && u.emailReminders !== false) sendBadgeEmail(u.email, u.fullName, newBadges, bLoc).catch(() => {}) // opt-out saygı (cashback/streak ile tutarlı)
        }
      } catch (e) {
        console.error('Tier/badge sync error:', e)
      }
    }

    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: {
        id: true,
        username: true,
        email: true,
        fullName: true,
        avatarUrl: true,
        bio: true,
        phone: true,
        totalLessonsCompleted: true,
        rewardPoints: true,
        recordStreak: true,
        profilePrivacy: true,
        activityPrivacy: true,
        emailReminders: true,
        isEmailVerified: true,
        createdAt: true,
        neighborhood: { select: { name: true } },
        neighborhoodId: true,
        preferredSports: true,
        preferredNeighborhoods: true,
        city: { select: { name: true } },
        tier: { select: { name: true, pointRate: true, colorHex: true, iconUrl: true } },
        badges: {
          select: {
            id: true,
            earnedAt: true,
            rank: true,
            seasonKey: true,
            scopeType: true,
            scopeId: true,
            badge: { select: { key: true, name: true, description: true, iconUrl: true } },
            sportCategory: { select: { name: true } },
          },
          orderBy: { earnedAt: 'desc' },
        },
      }
    })

    if (!user) {
      return res.status(404).json({ error: 'Kullanıcı bulunamadı.' })
    }

    // Sezon şampiyonu rozetlerine kapsam adı (il/ilçe) + sezon etiketi (TR/EN) ekle
    const champs = (user.badges as any[]).filter(b => b.badge?.key === 'season_champion')
    if (champs.length) {
      const nbIds = [...new Set(champs.filter(c => c.scopeType === 'district').map(c => c.scopeId))] as number[]
      const cityIds = [...new Set(champs.filter(c => c.scopeType === 'city').map(c => c.scopeId))] as number[]
      const [nbs, cities] = await Promise.all([
        nbIds.length ? prisma.neighborhood.findMany({ where: { id: { in: nbIds } }, select: { id: true, name: true } }) : Promise.resolve([]),
        cityIds.length ? prisma.city.findMany({ where: { id: { in: cityIds } }, select: { id: true, name: true } }) : Promise.resolve([]),
      ])
      const nbMap = new Map(nbs.map(n => [n.id, n.name]))
      const cityMap = new Map(cities.map(c => [c.id, c.name]))
      for (const c of champs) {
        c.scopeName = c.scopeType === 'district' ? (nbMap.get(c.scopeId) || '') : (cityMap.get(c.scopeId) || '')
        const s = seasonLabelsFromKey(c.seasonKey)
        c.seasonLabel = s.label
        c.seasonLabelEn = s.labelEn
      }
    }

    return res.json({ user })
  } catch (error) {
    console.error('GetMe error:', error)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// ŞİFRE SIFIRLAMA - EMAIL GÖNDER
export const forgotPassword = async (req: Request, res: Response) => {
  try {
    const { email } = req.body

    // PERFORMANS: `mode:'insensitive'` Prisma'da ILIKE üretir ve User.email üzerindeki @unique btree
    // index'i KULLANILAMAZ → her giriş/şifre-sıfırlama isteği tüm User tablosunu tarardı.
    // Kayıt e-postayı küçük harfle sakladığından (cleanEmail) hızlı yol findUnique ile index'e düşer;
    // normalizasyon öncesi kalmış olabilecek eski karışık-harfli kayıtlar için insensitive yedek korunur.
    const cleanEmail = String(email).trim().toLowerCase()
    const user = await prisma.user.findUnique({ where: { email: cleanEmail } })
      ?? await prisma.user.findFirst({ where: { email: { equals: cleanEmail, mode: 'insensitive' } } })

    if (!user) {
      return res.json({ message: 'Email gönderildi' })
    }

    // HESAP BAŞINA SOĞUMA. IP limiti (authLimiter 10/dk) saldırganı yavaşlatıyor ama KURBANI
    // korumuyordu: tek IP'den dakikada 10 istekle kurbanın kutusuna saatte 600 "şifre sıfırlama"
    // maili düşürülebiliyor, DB'ye o kadar token satırı yazılıyordu. Sayaç HEDEF HESAPTA tutulur,
    // böylece saldırgan IP/hesap değiştirse de kurban korunur.
    // 3/saat: gerçekten şifresini unutan biri için fazlasıyla yeterli.
    const sonSaat = new Date(Date.now() - 3600_000)
    const yakinIstek = await prisma.passwordResetToken.count({ where: { userId: user.id, createdAt: { gt: sonSaat } } })
    if (yakinIstek >= 3) {
      // Aynı nötr yanıt: hesabın var olup olmadığı ya da limite takıldığı DIŞARIYA sızmasın.
      return res.json({ message: 'Email gönderildi' })
    }

    const token = crypto.randomBytes(32).toString('hex')
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000)

    await prisma.passwordResetToken.create({
      data: { userId: user.id, token, expiresAt }
    })

    sendPasswordResetEmail(user.email, user.fullName, token, (user.locale as any) || localeFromReq(req)).catch(err =>
      console.error('Reset mail gönderilemedi:', err)
    )

    return res.json({ message: 'Email gönderildi' })
  } catch (error) {
    console.error('ForgotPassword error:', error)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// ŞİFRE SIFIRLAMA - YENİ ŞİFRE BELİRLE
export const resetPassword = async (req: Request, res: Response) => {
  try {
    const { token, password } = req.body

    // GÜVENLİK: token doğrulanmazsa `where:{token:undefined}` Prisma'da filtreyi YOK SAYAR →
    // findFirst BAŞKA bir kullanıcının geçerli token'ını döndürür → o kurbanın şifresi ezilir
    // (hesap ele geçirme). Bu yüzden query'den ÖNCE token varlığı+tipi kesinlikle kontrol edilir.
    if (!token || typeof token !== 'string') {
      return res.status(400).json({ error: 'Geçersiz veya süresi dolmuş sıfırlama linki.' })
    }
    if (!password || password.length < MIN_PASSWORD) {
      return res.status(400).json({ error: `Şifre en az ${MIN_PASSWORD} karakter olmalı.` })
    }

    const resetToken = await prisma.passwordResetToken.findFirst({
      where: {
        token,
        used: false,
        expiresAt: { gt: new Date() }
      }
    })

    if (!resetToken) {
      return res.status(400).json({ error: 'Geçersiz veya süresi dolmuş token' })
    }

    const passwordHash = await bcrypt.hash(password, 12)

    // ÜÇÜ TEK TRANSACTION'DA. Eskiden üç ayrı otomatik-commit yazmaydı ve iki sorun vardı:
    //  1) Araya giren bir giriş: T2 eski parolayla doğrulamayı geçmişken T1 parolayı değiştirip
    //     süpürgeyi çalıştırıyor, T2 SÜPÜRGEDEN SONRA yeni bir refresh token yazıyordu. Sonuç:
    //     parola değiştirildikten sonra doğmuş, revoked=false, 180 gün geçerli bir oturum.
    //     rotateAccessToken (utils/refreshToken.ts) yalnız revoked/expiresAt bakar, parola
    //     sürümüne bakmaz → hesabı ele geçiren kişi parola sıfırlamasına RAĞMEN içeride kalıyordu.
    //  2) Süpürge `.catch(() => {})` ile sarılıydı: başarısız olursa SESSİZCE yutuluyor,
    //     kullanıcı "şifren güncellendi" görürken tüm eski oturumlar açık kalıyordu.
    // Token tüketimi de aynı transaction'da CAS ile yapılıyor (used:false koşulu) → aynı
    // sıfırlama bağlantısına iki kez tıklanması ikinci kez parola yazmaz.
    const ok = await prisma.$transaction(async (tx) => {
      const claim = await tx.passwordResetToken.updateMany({
        where: { id: resetToken.id, used: false },
        data: { used: true },
      })
      if (claim.count === 0) return false // token bu arada başka bir istekçe tüketildi
      // passwordChangedAt: DAĞITILMIŞ access token'ları da geçersiz kılar (middlewares/auth.ts).
      // Refresh iptali tek başına yetmiyordu; çalınmış JWT bir saat daha çalışıyordu.
      await tx.user.update({ where: { id: resetToken.userId }, data: { passwordHash, passwordChangedAt: new Date() } })
      // TÜM satırlar + rotatedAt: null. `revoked: false` filtresi DÖNDÜRÜLMÜŞ satırları atlıyordu:
      // onlar revoked=true ama rotatedAt dolu olduğu için yarış payı (grace) penceresinde HÂLÂ
      // kabul ediliyor ve taze bir zincir üretebiliyorlardı. Yani jetonu ele geçiren saldırgan,
      // parola sıfırlandıktan sonra elindeki bir önceki jetonla geri girebiliyordu — parola
      // sıfırlama, ele geçirilmiş hesabın ÇÖZÜMÜ olduğu için bu boşluk onu işlevsiz kılıyordu.
      // rotatedAt sıfırlanınca satır "çıkışta iptal edildi" sınıfına düşer ve sessizce reddedilir.
      await tx.refreshToken.updateMany({ where: { userId: resetToken.userId }, data: { revoked: true, rotatedAt: null } })
      return true
    })
    if (!ok) return res.status(400).json({ error: 'Geçersiz veya süresi dolmuş token' })

    // Süpürge transaction'ı commit ettikten SONRA doğmuş olabilecek oturumları da kapat:
    // eşzamanlı bir giriş, tx görünürlüğü dışında token yazmış olabilir. İkinci süpürge
    // ucuz ve idempotent; parola değişiminden sonra hiçbir eski oturum ayakta kalmamalı.
    await prisma.refreshToken.updateMany({ where: { userId: resetToken.userId }, data: { revoked: true, rotatedAt: null } })
    invalidate(`authstate:${resetToken.userId}`) // 60sn cache → parola damgası ANINDA etki etsin

    return res.json({ message: 'Şifre güncellendi' })
  } catch (error) {
    console.error('ResetPassword error:', error)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// PROFİL GÜNCELLE
export const updateProfile = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId
    const { fullName, bio, neighborhoodId, avatarUrl } = req.body

    const data: any = {}
    if (fullName !== undefined) data.fullName = clampStr(fullName, 80)
    if (bio !== undefined) data.bio = clampStr(bio, 500)
    if (avatarUrl !== undefined) {
      // Bkz. utils/sanitize.gorselUrlGecerliMi — saldırgan-kontrollü avatar adresi, görüntüleyen
      // herkesin (admin dahil) IP'sini saldırgana sızdıran bir izleme pikseli hâline gelir.
      if (!gorselUrlGecerliMi(avatarUrl)) {
        return res.status(400).json({ error: 'Geçersiz profil fotoğrafı adresi.' })
      }
      data.avatarUrl = clampStr(avatarUrl, 500)
    }
    if (neighborhoodId !== undefined) {
      // parseInt yerine parseIntSafe: 'abc'/taşma/NaN doğrudan Prisma'ya gidip 500 veriyordu.
      const nb = parseIntSafe(neighborhoodId)
      if (nb === undefined) return res.status(400).json({ error: 'Geçersiz mahalle.' })
      data.neighborhoodId = nb
      // cityId SABİT 1 yazılıyordu → mahalleden türet (bkz. utils/geo.ts).
      data.cityId = await cityIdOfNeighborhood(nb)
    }

    const user = await prisma.user.update({
      where: { id: userId },
      data,
      select: { id: true, fullName: true, bio: true, avatarUrl: true, neighborhoodId: true, neighborhood: { select: { name: true } } }
    })
    return res.json({ message: 'Profil güncellendi.', user })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// GİZLİLİK AYARINI GÜNCELLE
export const updatePrivacy = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId
    const { activityPrivacy, profilePrivacy } = req.body

    const data: any = {}
    if (activityPrivacy !== undefined) {
      if (!['public', 'private'].includes(activityPrivacy)) return res.status(400).json({ error: 'Geçersiz gizlilik ayarı.' })
      data.activityPrivacy = activityPrivacy
    }
    if (profilePrivacy !== undefined) {
      // Gizli hesap: yeni takipler istek (pending) olur; herkese açık: doğrudan kabul
      if (!['public', 'private'].includes(profilePrivacy)) return res.status(400).json({ error: 'Geçersiz gizlilik ayarı.' })
      data.profilePrivacy = profilePrivacy
    }
    if (Object.keys(data).length === 0) return res.status(400).json({ error: 'Geçersiz gizlilik ayarı.' })

    const user = await prisma.user.update({
      where: { id: userId },
      data,
      select: { id: true, activityPrivacy: true, profilePrivacy: true }
    })

    return res.json({ message: 'Gizlilik ayarı güncellendi.', user })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// HESAP SİL — kullanıcı kendi hesabını kalıcı siler. Parola onayı + tüm ilişkili veri temizliği.
export const deleteAccount = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId
    // GÖVDESİZ İSTEK 500 VERMESİN: Express 5'te body-parser gövde yoksa `req.body`yi undefined
    // bırakıyor; `const { password } = req.body` doğrudan TypeError fırlatıp 500 üretiyordu.
    // Doğru cevap 401 (parola yok = doğrulanamaz), sunucu hatası değil.
    const { password } = (req.body ?? {}) as { password?: string }

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { passwordHash: true } })
    if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' })

    // Güvenlik: çalınan token'la silme olmasın → parola doğrulaması zorunlu
    if (!password || !(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).json({ error: 'Hesabı silmek için mevcut şifrenizi doğru girin.' })
    }

    await prisma.$transaction(async (tx) => {
      // Drop-in sayaçlarını düzelt (silinen katılımcı slotu dolu göstermesin)
      const dps = await tx.dropInParticipant.findMany({ where: { userId, status: 'confirmed' }, select: { slotId: true } })
      for (const dp of dps) {
        await tx.dropInSlot.update({ where: { id: dp.slotId }, data: { currentPlayers: { decrement: 1 } } }).catch(() => {})
      }

      // ÖNCE ARŞİVLE, SONRA SİL. Gizlilik Politikası 11.3 vergi/ticaret mevzuatı gereği
      // saklanması zorunlu işlem kayıtlarının anonimleştirilerek saklanacağını taahhüt ediyor;
      // burası hepsini hard-delete ediyordu. Arşiv kişiyi değil işlemi tutar (utils/finansalArsiv.ts).
      // Arşiv ile silme AYNI transaction'da: arasında bir hata olursa ikisi de geri alınır.
      const bookings = await tx.booking.findMany({
        where: { userId },
        select: {
          id: true, bookingNumber: true, baseAmount: true, commissionAmount: true,
          userCommission: true, venueCommission: true, finalAmount: true, venuePayout: true,
          groupSize: true, refundType: true, refundAmount: true, createdAt: true,
          session: { select: { startsAt: true, class: { select: { venueId: true, instructorId: true } } } },
          payment: { select: { status: true } },
        },
      })
      const bookingIds = bookings.map(b => b.id)
      await finansalArsivle(tx as any, bookings, 'hesap_silindi')
      if (bookingIds.length) {
        await tx.payment.deleteMany({ where: { bookingId: { in: bookingIds } } })
        await tx.commissionHistory.deleteMany({ where: { bookingId: { in: bookingIds } } })
      }
      // Kullanıcının yazdığı yorumlar (kendi booking'lerine ait) — bookingId FK'sından önce.
      // Salon/eğitmen puan ortalamaları da yeniden hesaplanır (hayalet puan kalmasın).
      await purgeUserReviews(tx, userId)

      // Kullanıcının feed yorumları — yanıtların parent'ı boşaltılıp silinir
      await purgeUserComments(tx, userId)

      // Doğrudan userId'ye bağlı tüm çocuklar (ActivityLog booking'lerden ÖNCE — bookingId FK'sı)
      await tx.activityLike.deleteMany({ where: { userId } })
      await tx.activityLog.deleteMany({ where: { userId } })
      await tx.userBadge.deleteMany({ where: { userId } })
      await tx.userTierHistory.deleteMany({ where: { userId } })
      await tx.monthlyLeaderboard.deleteMany({ where: { userId } })
      await tx.rewardPoint.deleteMany({ where: { userId } })
      await tx.rewardRedemption.deleteMany({ where: { userId } })
      await tx.waitlist.deleteMany({ where: { userId } })
      await tx.favoriteVenue.deleteMany({ where: { userId } })
      await tx.dropInParticipant.deleteMany({ where: { userId } })
      await tx.chatMessage.deleteMany({ where: { userId } })
      await tx.passwordResetToken.deleteMany({ where: { userId } })
      await tx.emailVerificationToken.deleteMany({ where: { userId } })
      // Refresh token'lar userId FK'sıyla User'a bağlı → kullanıcı silinmeden ÖNCE temizlenmeli.
      // (Aksi halde giriş/kayıt yapmış GERÇEK kullanıcı hesabını silerken FK ihlali → 500.
      //  Ana test kullanıcısı upsert'le token'sız oluştuğundan bu boşluk gizli kalmıştı.)
      await tx.refreshToken.deleteMany({ where: { userId } })

      // Çift yönlü ilişkiler
      await tx.follow.deleteMany({ where: { OR: [{ followerId: userId }, { followingId: userId }] } })
      await tx.notification.deleteMany({ where: { OR: [{ userId }, { relatedUserId: userId }] } })
      // Bu kullanıcıyı DAVET EDEN kişilerin referralCount'unu geri düş (davet hakkı iade edilsin;
      // aksi halde davet edilen hesabını silince davet eden kalıcı olarak davet slotu kaybederdi)
      const invitedBy = await tx.referral.findMany({ where: { referredId: userId }, select: { referrerId: true } })
      for (const rid of [...new Set(invitedBy.map(r => r.referrerId))]) {
        await tx.user.updateMany({ where: { id: rid, referralCount: { gt: 0 } }, data: { referralCount: { decrement: 1 } } })
      }
      // FARMING ENGELİ: silinen kullanıcı DAVET EDİLEN ve referral TAMAMLANMIŞSA, davet edene verilmiş +100 puanı
      // geri al. Aksi halde: davet-koduyla kayıt → ücretli ders (referrer +100) → hesabı sil → tekrarla = sınırsız
      // puan farming. Puanı negatife düşürmeden (clamp) geri alınır + ledger'a negatif kayıt (izlenebilirlik).
      const REFERRAL_POINTS = 100 // referralController ile senkron
      const completedAsReferred = await tx.referral.findMany({ where: { referredId: userId, status: 'completed' }, select: { referrerId: true } })
      for (const rr of completedAsReferred) {
        const ref = await tx.user.findUnique({ where: { id: rr.referrerId }, select: { rewardPoints: true } })
        if (!ref) continue
        const dec = Math.min(REFERRAL_POINTS, ref.rewardPoints)
        if (dec > 0) {
          await tx.user.update({ where: { id: rr.referrerId }, data: { rewardPoints: { decrement: dec } } })
          await tx.rewardPoint.create({ data: { userId: rr.referrerId, points: -dec, source: 'referral_reversed' } })
        }
      }
      await tx.referral.deleteMany({ where: { OR: [{ referrerId: userId }, { referredId: userId }] } })
      // YALNIZ bu kullanici HAKKINDAKI sikayetler silinir. Onun ACTIGI sikayetler KALIR: FK artik
      // ON DELETE SET NULL, reporterUserId null'a duser ve kayit incelenebilir kalir. Aksi halde
      // taciz eden, kurbani hesabini silmeye ikna ederek kaniti yok edebiliyordu.
      await tx.report.deleteMany({ where: { reportedUserId: userId } })

      // MİRAS KOD (kupon sistemi 24 Ağu 2026'da kaldırıldı): yeni rezervasyonlarda couponId
      // hiçbir zaman dolmuyor, bu blok yalnız KALDIRMA ÖNCESİ satırlar için çalışır. Tablo
      // ve kolon bilerek DURUYOR (veri kaybı olmasın); blok silinirse eski satırların
      // usedCount'u sonsuza dek yanık kalırdı.
      // KUPON HAKKI İADE — bu transaction referral sayacını ve referral puanını bilinçle geri alıyor
      // ama kuponu ATLIYORDU: hesap silinince booking'ler hard-delete ediliyor, kuponun yaktığı
      // usedCount ise kalıyordu. Salonun kampanya kotası kalıcı yanıyor ve booking satırı silindiği
      // için hiçbir veriden türetilemiyor (maxUses=1 kupon kalıcı tükeniyor).
      // Kural venueController'daki 'KUPON HAKKI İADE' bloğuyla AYNI: yalnız hakkı hâlâ TUTAN
      // (confirmed/pending) rezervasyonlar sayılır — 'cancelled' olanların kuponu iptalde iade edildi,
      // ikinci kez iade edilirse usedCount olduğundan düşük kalır.
      const silinecekler = await tx.booking.findMany({
        where: { userId, couponId: { not: null }, status: { in: ['confirmed', 'pending'] } },
        select: { couponId: true },
      })
      const kuponSayaci = new Map<number, number>()
      for (const b of silinecekler) {
        if (b.couponId) kuponSayaci.set(b.couponId, (kuponSayaci.get(b.couponId) || 0) + 1)
      }
      for (const [couponId, n] of kuponSayaci) {
        const c = await tx.coupon.findUnique({ where: { id: couponId }, select: { usedCount: true } })
        const dec = Math.min(n, c?.usedCount || 0) // 0'ın altına inmesin (aynı invariant)
        if (dec > 0) await tx.coupon.update({ where: { id: couponId }, data: { usedCount: { decrement: dec } } })
      }

      // Booking'leri sil, sahip olunan salonların owner bağını boşalt, en son kullanıcıyı sil
      await tx.booking.deleteMany({ where: { userId } })
      await tx.venue.updateMany({ where: { ownerUserId: userId }, data: { ownerUserId: null } })
      await tx.user.delete({ where: { id: userId } })
    })

    // authMiddleware/optionalAuth 60sn cache'ini hemen düşür → silinen hesabın hâlâ imzalı-geçerli
    // JWT'si (kullanıcı access token'ı ~1sa) bir sonraki istekte 'missing' görülüp reddedilsin.
    invalidate(`authstate:${userId}`)

    return res.json({ message: 'Hesabınız ve tüm verileriniz kalıcı olarak silindi.' })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// ŞİFRE DEĞİŞTİR
export const changePassword = async (req: Request & { userId?: number }, res: Response) => {
  try {
    const { currentPassword, newPassword } = req.body

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Mevcut ve yeni şifre gerekli.' })
    }

    if (newPassword.length < MIN_PASSWORD) {
      return res.status(400).json({ error: `Yeni şifre en az ${MIN_PASSWORD} karakter olmalı.` })
    }

    const user = await prisma.user.findUnique({ where: { id: req.userId } })
    if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' })

    const isValid = await bcrypt.compare(currentPassword, user.passwordHash)
    if (!isValid) return res.status(401).json({ error: 'Mevcut şifre hatalı.' })

    const newHash = await bcrypt.hash(newPassword, 12)
    // TEK TRANSACTION + .catch YOK. resetPassword'de (satır ~361) düzeltilen aynı kalıp buradaydı:
    // parola yazması ayrı commit'lenip oturum-iptal süpürgesi `.catch(() => {})` ile yutuluyordu →
    // süpürge bir DB hıçkırığıyla başarısız olsa bile kullanıcı 200 "değiştirildi" görüyor, eski
    // cihaz oturumları (180 gün geçerli refresh token) açık kalıyordu. Süpürge güvenlik işlemidir,
    // best-effort DEĞİL: başarısızsa 500 dönmeli, "başarılı" DENMEMELİ.
    await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: req.userId }, data: { passwordHash: newHash, passwordChangedAt: new Date() } }) // bkz. resetPassword
      await tx.refreshToken.updateMany({ where: { userId: req.userId }, data: { revoked: true, rotatedAt: null } }) // bkz. resetPassword — grace penceresi kapatılır
    })
    // Commit sonrası araya girmiş olabilecek oturumları da kapat (idempotent güvenlik ağı).
    await prisma.refreshToken.updateMany({ where: { userId: req.userId }, data: { revoked: true, rotatedAt: null } })
    invalidate(`authstate:${req.userId}`) // bkz. resetPassword

    return res.json({ message: 'Şifre başarıyla değiştirildi.' })
  } catch (error) {
    console.error('ChangePassword error:', error)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// EMAIL DOĞRULA
export const verifyEmail = async (req: Request, res: Response) => {
  try {
    const { token } = req.body

    // GÜVENLİK: token yoksa `where:{token:undefined}` filtreyi yok sayar → başka birinin doğrulama
    // token'ı bulunup e-postası izinsiz doğrulanır. Query'den önce zorunlu kontrol.
    if (!token || typeof token !== 'string') {
      return res.status(400).json({ error: 'Geçersiz doğrulama linki.' })
    }

    const record = await prisma.emailVerificationToken.findFirst({
      where: { token, used: false, expiresAt: { gt: new Date() } }
    })

    if (!record) {
      return res.status(400).json({ error: 'Geçersiz veya süresi dolmuş doğrulama linki.' })
    }

    await prisma.user.update({ where: { id: record.userId }, data: { isEmailVerified: true } })
    await prisma.emailVerificationToken.update({ where: { id: record.id }, data: { used: true } })

    return res.json({ message: 'Email başarıyla doğrulandı!' })
  } catch (error) {
    console.error('VerifyEmail error:', error)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// E-POSTA DOĞRULAMA — 6 HANELİ KOD (kayıt akışının ikinci adımı)
export const verifyEmailCode = async (req: Request & { userId?: number }, res: Response) => {
  try {
    const { code } = req.body
    const kullanici = await prisma.user.findUnique({ where: { id: req.userId }, select: { isEmailVerified: true } })
    if (!kullanici) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' })
    // Zaten doğrulanmışsa BAŞARI dön: istemci tekrar gönderirse (çift tık, ağ tekrarı) hata
    // ekranı görmesin — sonuç aynı, kullanıcı doğrulanmış durumda.
    if (kullanici.isEmailVerified) return res.json({ message: 'E-posta zaten doğrulanmış.', verified: true })

    const sonuc = await dogrulamaKoduDogrula(req.userId!, code)
    if (sonuc === 'ok') {
      invalidate(`authstate:${req.userId}`)
      // KAPI CACHE'İNİ DE DÜŞÜR. requireVerifiedEmail durumu 60 sn cache'liyor ve kullanıcı kodu
      // girmeden ÖNCE zaten bir kez reddedilmiş olduğu için cache'te "doğrulanmamış" yazıyor.
      // Düşürülmezse kullanıcı kodu doğru girdiği hâlde bir dakika boyunca rezervasyon yapamaz —
      // hem de huninin en kritik anında. (Bu, testin yakaladığı gerçek bir hataydı.)
      invalidate(`emailverified:${req.userId}`)
      return res.json({ message: 'E-posta doğrulandı!', verified: true })
    }
    const mesaj = {
      gecersiz: 'Kod hatalı. Lütfen e-postandaki 6 haneli kodu kontrol et.',
      suresi_doldu: 'Kodun süresi doldu. Yeni kod iste.',
      deneme_bitti: 'Çok fazla hatalı deneme yapıldı. Yeni kod iste.',
    }[sonuc]
    // 400: istemci kodu düzeltebilir. Hangi hata olduğu SÖYLENİR — bu bir enumerasyon yüzeyi
    // değil (kullanıcı zaten kendi hesabında, jetonla kimliği doğrulanmış durumda).
    return res.status(400).json({ error: mesaj, reason: sonuc })
  } catch (error) {
    console.error('VerifyEmailCode error:', error)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// EMAIL DOĞRULAMA YENİDEN GÖNDER
export const resendVerification = async (req: Request & { userId?: number }, res: Response) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.userId }, select: { email: true, fullName: true, isEmailVerified: true } })
    if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' })
    if (user.isEmailVerified) return res.status(400).json({ error: 'Email zaten doğrulanmış.' })

    // COOLDOWN: son 2 dk içinde token üretildiyse tekrar GÖNDERME — self-servis mail seli + token satır şişmesi
    // engeli (authLimiter'a ek). Kullanıcı akışını bozmaz (zaten gönderildi mesajı döner).
    const recent = await prisma.emailVerificationToken.findFirst({ where: { userId: req.userId!, createdAt: { gt: new Date(Date.now() - 2 * 60 * 1000) } }, select: { id: true } })
    if (recent) return res.json({ message: 'Doğrulama emaili yakın zamanda gönderildi. Birkaç dakika sonra tekrar deneyin.' })

    const kod = await dogrulamaKoduUret(req.userId!)
    // ATEŞLE-UNUT DEĞİL: eskiden sonuç beklenmeden KOŞULSUZ "Yeni doğrulama kodu gönderildi."
    // dönülüyordu. Kullanıcı gelmeyen postayı bekliyor, 2 dakikalık cooldown da devreye girdiği için
    // tekrar denemesi de "yakın zamanda gönderildi" ile karşılanıyordu — çıkışsız döngü.
    // Burada bekleme maliyeti kabul edilebilir: uç zaten insan tetikli ve tek postalık.
    const sonuc: any = await sendEmailVerificationEmail(user.email, user.fullName, kod, localeFromReq(req))
      .catch((err: any) => { console.error('Verify mail gönderilemedi:', err); return { error: { message: String(err?.message || err) } } })
    if (sonuc?.error) {
      return res.status(502).json({ error: 'Doğrulama e-postası şu an gönderilemiyor. Lütfen birazdan tekrar deneyin.' })
    }

    return res.json({ message: 'Yeni doğrulama kodu gönderildi.' })
  } catch (error) {
    console.error('ResendVerification error:', error)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

export const updateNotificationSettings = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId
    // ÖLÜ TERCİH TEMİZLİĞİ: smsReminders hiçbir zaman kullanılmıyordu — SMS altyapısı yok (Netgsm yapılmadı;
    // tüm hatırlatmalar e-posta + push). Ayarı kabul etmek/döndürmek kullanıcıya çalışmayan bir anahtar
    // gösteriyordu. Artık yalnız emailReminders yönetilir. (DB kolonu şemada dormant kalır — düşürmek
    // prod'da --accept-data-loss ister, değeri yok. SMS gerçekten gelirse tercih yeniden bağlanır.)
    const { emailReminders } = req.body

    const user = await prisma.user.update({
      where: { id: userId },
      data: {
        ...(typeof emailReminders === 'boolean' ? { emailReminders } : {}),
      },
      select: { id: true, emailReminders: true }
    })

    return res.json({ message: 'Bildirim tercihleri güncellendi.', user })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

export const registerPushToken = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId
    const { pushToken } = req.body
    if (!pushToken || typeof pushToken !== 'string') {
      return res.status(400).json({ error: 'pushToken gerekli.' })
    }
    // Aynı Expo token başka hesaba bağlıysa onu kopar — bir cihaz-token'ı TEK sahibe ait olmalı.
    // Yoksa paylaşılan cihazda A çıkıp B girince A'nın özel push bildirimleri B'nin cihazına düşer (çapraz-hesap sızıntısı).
    await prisma.user.updateMany({ where: { pushToken, NOT: { id: userId } }, data: { pushToken: null } })
    await prisma.user.update({ where: { id: userId }, data: { pushToken } })
    return res.json({ message: 'Push token kaydedildi.' })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}
