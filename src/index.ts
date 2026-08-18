import dotenv from 'dotenv'
dotenv.config()
import { initSentry, Sentry } from './utils/sentry'
initSentry()

import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import rateLimit, { ipKeyGenerator } from 'express-rate-limit'
import { verifyToken } from './utils/jwt'
import prisma from './utils/prisma'
import { sendRemindersJob } from './jobs/reminderJob'
import { sendStreakNudges } from './jobs/streakJob'
import { sendRatingPrompts } from './jobs/ratingPromptJob'
import { sweepWaitlist } from './jobs/waitlistJob'
import { reconcileAttendancePoints } from './jobs/attendanceJob'
import { fillMissingTranslations } from './jobs/translationJob'
import { ensureTiers } from './utils/ensureTiers'
import { ensureGeo } from './utils/ensureGeo'
import { ensureBadges } from './utils/ensureBadges'
import { ensureIndexes } from './utils/ensureIndexes'
import { awardSeasonChampions } from './jobs/championJob'
import authRoutes from './routes/auth'
import bookingRoutes from './routes/bookings'
import venueRoutes from './routes/venue'
import adminRoutes from './routes/admin'
import publicRoutes from './routes/public'
import socialRouter from './routes/social'
import reviewRoutes from './routes/reviews'
import instructorRoutes from './routes/instructor'
import cronRoutes from './routes/cron'
import waitlistRoutes from './routes/waitlist'
import favoriteRoutes from './routes/favorites'
import referralRoutes from './routes/referral'
import { chat, getChatHistory } from './controllers/chatController'
import { authMiddleware, optionalAuthMiddleware } from './middlewares/auth'
import { epostaSagligi, epostaYapilandirildi } from './utils/email'

// GÜVENLİK: kritik secret'lar YOKSA sunucuyu HİÇ BAŞLATMA — ortamdan BAĞIMSIZ.
// Eski hali `NODE_ENV === 'production'` tam eşitliğine bağlıydı: NODE_ENV set edilmemişse (ki
// "Railway'de NODE_ENV=production ayarla" görevi HÂLÂ AÇIK) ya da 'Production'/'prod' yazılmışsa
// bu kontrol sessizce atlanıyor, sunucu console.warn basıp AÇILIYOR ve jwt.ts'teki public-repo'da
// duran gömülü varsayılanla token imzalıyordu. Ortam değişkeninin doğru yazılmasına güvenmek
// güvenlik kontrolü değildir; artık koşul yok.
if (!process.env.JWT_SECRET || !process.env.ADMIN_SECRET) {
  console.error('FATAL: JWT_SECRET ve ADMIN_SECRET set edilmeli. Gömülü varsayılan YOK.')
  process.exit(1)
}

const app = express()
const PORT = process.env.PORT || 3001

// PROXY GÜVEN DERİNLİĞİ — rate limit'in kalbi. Railway zinciri geçici bir teşhis ucuyla ÖLÇÜLDÜ:
//   X-Forwarded-For = [gerçek istemci, Railway edge]  ve edge adresi HER İSTEKTE DEĞİŞİYOR.
// Değer 1 iken req.ip zincirin SONUNU (değişen edge'i) seçiyordu → her istek ayrı kovaya
// düşüyor, TÜM rate limit'ler sessizce etkisiz kalıyordu (ratelimit-remaining hep başlangıçta).
// 2 = sağdan iki hop güvenilir (soket + edge) → req.ip zincirdeki gerçek istemci olur.
// SAHTECİLİĞE de kapalı: istemci kendi XFF'ini uydurursa zincir [sahte, gerçek, edge] olur ve
// sağdan ikinci yine GERÇEK istemcidir; uydurulan değer solda kalır, hiç bakılmaz.
app.set('trust proxy', 2)
// Güvenlik başlıkları (HSTS, X-Content-Type-Options, X-Frame-Options, ...).
// CORP=cross-origin: bu kasıtlı bir public API, web/mobil farklı origin'den tüketir.
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }))

// CORS: sadece bilinen web origin'lerine izin ver. Mobil native istekler Origin
// header'ı göndermediği için (origin=undefined) onlar da kabul edilir.
const allowedOrigins = [
  'https://sipsakspor.com',
  'https://www.sipsakspor.com',
  'http://localhost:3000',
  'http://localhost:3001',
  ...(process.env.EXTRA_CORS_ORIGINS?.split(',').map(o => o.trim()).filter(Boolean) || []),
]
app.use(cors({
  origin: (origin, callback) => {
    // origin yoksa (mobil app, curl, server-to-server) veya listede varsa izin ver
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true)
    // Vercel preview deploy'larına da izin ver (*.vercel.app)
    if (/^https:\/\/[a-z0-9-]+\.vercel\.app$/.test(origin)) return callback(null, true)
    // REDDET, AMA HATA FIRLATMA. `new Error(...)` Express hata işleyicisine düşüyor ve
    // HTTP 500 + `console.error` üretiyordu: izinsiz bir origin'den gelen sıradan bir tarayıcı
    // isteği loglarda ve metriklerde "SUNUCU HATASI" gibi görünüyor, GERÇEK 500'leri gizliyordu
    // (sahte alarm, gürültü). `false` ile CORS başlıkları YAZILMAZ ve tarayıcı isteği zaten
    // engeller — doğru davranış budur.
    //
    // NOT: CORS bir YETKİLENDİRME mekanizması değildir (tarayıcı politikasıdır); yetkiyi JWT
    // sağlıyor. Zaten Origin başlığı olmayan istemciler (mobil, curl) bilerek kabul ediliyor.
    return callback(null, false)
  },
}))
app.use(express.json())

// Rate limiting
// Test sırasında limiter'ı kapat (gerçek yük testi yapılabilsin)
const skipRateLimit = () => process.env.DISABLE_RATE_LIMIT === 'true'

// Anahtar: girişli kullanıcı → DOĞRULANMIŞ kimlik bazlı (aynı IP'yi paylaşan NAT/operatör
// kullanıcıları birbirini limite sokmasın); anonim VEYA geçersiz token → IP bazlı.
// KRİTİK: token imzası doğrulanmadan anahtar üretilirse, saldırgan her istekte rastgele bir
// "Bearer <uuid>" göndererek her seferinde YENİ kovaya düşer ve TÜM limitleri sınırsız bypass eder.
// Doğrulanamayan token IP kovasına düşürülür → sahte token üretmek hiçbir avantaj sağlamaz.
function rlKey(req: express.Request): string {
  const ipKey = 'ip:' + ipKeyGenerator(req.ip || req.socket?.remoteAddress || 'unknown')
  const auth = req.headers.authorization
  if (!auth || !auth.startsWith('Bearer ')) return ipKey
  try {
    const p = verifyToken(auth.slice(7))
    if (p.userId) return `u:${p.userId}`
    if (p.venueId) return `v:${p.venueId}`
    if (p.instructorId) return `i:${p.instructorId}`
    return ipKey
  } catch {
    return ipKey // süresi dolmuş/sahte/bozuk token → anonim gibi davran
  }
}

const generalLimiter = rateLimit({
  windowMs: 60 * 1000,      // 1 dakika
  max: 200,                  // kullanıcı/IP başına dakikada 200 istek (aktif gezinme + NAT payı)
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: rlKey,
  skip: skipRateLimit,
  message: { error: 'Çok fazla istek gönderildi. Lütfen bir dakika bekleyin.' },
})

const authLimiter = rateLimit({
  windowMs: 60 * 1000,      // 1 dakika
  max: 10,                   // 1 dakikada max 10 deneme (login, register, şifre sıfırlama) — IP bazlı (brute-force)
  standardHeaders: true,
  legacyHeaders: false,
  // ipKeyGenerator ŞART: ham IPv6 adresi anahtar yapılırsa, tek bir kullanıcının elindeki /64
  // bloğunda milyarlarca adres olduğu için her denemede yeni kovaya düşülür ve kaba-kuvvet
  // limiti tamamen aşılır. Helper IPv6'yı blok bazında normalize eder. (express-rate-limit
  // bunu ERR_ERL_KEY_GEN_IPV6 ile uyarıyordu; uyarı yalnız log'a düşüyordu.)
  keyGenerator: (req: express.Request) => 'ip:' + ipKeyGenerator(req.ip || req.socket?.remoteAddress || 'unknown'),
  skip: skipRateLimit,
  message: { error: 'Çok fazla giriş denemesi. Lütfen bir dakika bekleyin.' },
})

const chatLimiter = rateLimit({
  windowMs: 60 * 1000,      // 1 dakika
  max: 20,                   // 1 dakikada max 20 chat isteği
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: rlKey,
  skip: skipRateLimit,
  message: { error: 'Çok fazla mesaj gönderildi. Lütfen bir dakika bekleyin.' },
})

// Kupon doğrulama (auth'suz) — kod enumerasyonunu yavaşlat (kullanıcı/IP başına dakikada 15)
const couponLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: rlKey,
  skip: skipRateLimit,
  message: { error: 'Çok fazla kupon denemesi. Lütfen bir dakika bekleyin.' },
})

// Sosyal YAZMA (takip/takipten çık) — kurbanı bildirim/push seliyle boğma + Notification satır şişmesi engeli
const socialWriteLimiter = rateLimit({
  windowMs: 60 * 1000, max: 30,
  standardHeaders: true, legacyHeaders: false, keyGenerator: rlKey, skip: skipRateLimit,
  message: { error: 'Çok fazla işlem. Lütfen bir dakika bekleyin.' },
})
// Feed (gezinme + beğeni + yorum) — yorum/beğeni spam'ini 200→60'a indir (gezinmeye yeter)
const feedLimiter = rateLimit({
  windowMs: 60 * 1000, max: 60,
  standardHeaders: true, legacyHeaders: false, keyGenerator: rlKey, skip: skipRateLimit,
  message: { error: 'Çok fazla istek. Lütfen bir dakika bekleyin.' },
})
// Pahalı okuma (liderlik hesap + kullanıcı arama ILIKE taraması) — dakikada 40
const heavyReadLimiter = rateLimit({
  windowMs: 60 * 1000, max: 40,
  standardHeaders: true, legacyHeaders: false, keyGenerator: rlKey, skip: skipRateLimit,
  message: { error: 'Çok fazla istek. Lütfen bir dakika bekleyin.' },
})

// Yenileme uçları auth'suz ve DB'ye vuruyor. Meşru istemci saatte ~1 yeniler; 30/dk NAT payıyla
// fazlasıyla yeter. Sınırsız bırakılsaydı (yalnız generalLimiter, 200/dk) döndürme sonrası jetonunu
// saklayamayan bozuk bir istemci ya da kaba-kuvvet denemesi DB'yi bedavaya çalıştırırdı.
const refreshLimiter = rateLimit({
  windowMs: 60 * 1000, max: 30,
  standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req: express.Request) => 'ip:' + ipKeyGenerator(req.ip || req.socket?.remoteAddress || 'unknown'), // bkz. authLimiter
  skip: skipRateLimit,
  message: { error: 'Çok fazla istek. Lütfen bir dakika bekleyin.' },
})

app.use('/api', generalLimiter)
app.use('/api/auth/refresh', refreshLimiter)
app.use('/api/venue/refresh', refreshLimiter)
app.use('/api/instructor/refresh', refreshLimiter)
app.use('/api/auth/login', authLimiter)
app.use('/api/auth/register', authLimiter)
app.use('/api/auth/forgot-password', authLimiter)
app.use('/api/venue/login', authLimiter)
app.use('/api/venue/register', authLimiter)
app.use('/api/venue/forgot-password', authLimiter)
// Eğitmen auth uçları — brute-force koruması
app.use('/api/instructor/login', authLimiter)
app.use('/api/instructor/forgot-password', authLimiter)
app.use('/api/instructor/set-password', authLimiter)
// Şikayet/iletişim uçları (biri auth'suz) — admin posta kutusu/şikayet listesi flood'una karşı
// ŞİKAYET/İHBAR: giriş kovasından AYRI. Bu iki uç kaba-kuvvet hedefi DEĞİL (biri kimlik bile
// istemiyor) ama authLimiter'ı paylaşıyorlardı: aynı IP'den 10 şikayet, o IP'nin GİRİŞ hakkını da
// bitiriyordu. CANLI ÖLÇÜLDÜ: 12 şikayet sonrası aynı IP'den login → "Çok fazla giriş denemesi."
// Kötüye kullanımı yine sınırlıyoruz, ama kendi kovasında — bir uçtaki gürültü diğerini kilitlemesin.
const sikayetLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: express.Request) => 'ip:' + ipKeyGenerator(req.ip || req.socket?.remoteAddress || 'unknown'),
  skip: skipRateLimit,
  message: { error: 'Çok fazla şikayet gönderildi. Lütfen bir dakika bekleyin.' },
})
app.use('/api/public/complaint', sikayetLimiter)
app.use('/api/public/validate-coupon', couponLimiter)
app.use('/api/social/report', sikayetLimiter)   // bkz. sikayetLimiter — giriş kovasından ayrı
app.use('/api/auth/resend-verification', authLimiter) // self-servis doğrulama-maili seli engeli
// Kod deneme uçları: 6 hane = 1.000.000 olasılık. Kod başına 5 deneme sınırı var (utils/
// verificationCode.ts) ama IP başına da sınır olmalı — saldırgan sürekli yeni kod isteyip
// deneyerek toplam tahmin hakkını büyütemesin.
app.use('/api/auth/verify-code', authLimiter)
app.use('/api/social/follow', socialWriteLimiter)     // takip bildirim bombası engeli
app.use('/api/social/unfollow', socialWriteLimiter)
app.use('/api/social/feed', feedLimiter)              // yorum/beğeni spam + feed okuma
app.use('/api/social/leaderboard', heavyReadLimiter)  // liderlik tam-tablo hesabı
app.use('/api/public/users-search', heavyReadLimiter) // ILIKE tam-tablo taraması
app.use('/api/chat', chatLimiter)
// Admin: gizli anahtar tahminini yavaşlat. /api/admin yalnız generalLimiter (200/dk) altındaydı;
// x-admin-secret sabit bir sır olduğu için dakikada 200 deneme brute-force'a kapı açıyordu.
// Diğer tüm auth uçlarıyla aynı 10/dk. (Anahtar zaten timing-safe karşılaştırılıyor, adminAuth.ts.)
// ADMIN: kaba-kuvvet koruması BAŞARISIZ denemeyi sayar, başarılıyı SAYMAZ.
// Eskiden burada doğrudan `authLimiter` vardı (10/dk, IP bazlı, başarılı istekler DAHİL). Admin
// kimliği bir paylaşılan başlık sırrı (x-admin-secret) olduğu için panelin HER isteği bu kovaya
// düşüyordu — panel açılışta 11 istek atıyor, yani 11'incisi 429 alıyordu. ÖLÇÜLDÜ: panel ilk
// yüklemede kendini kilitliyordu; lansman günü moderatör paneli açamazdı.
// skipSuccessfulRequests ile doğru sırrı bilen sınırsız (yalnız generalLimiter'ın 200/dk'sı geçerli),
// sırrı TAHMİN EDEN dakikada 10 denemede duruyor. Koruma aynı, kilitlenme yok.
const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,   // 2xx/3xx kovaya yazılmaz; yalnız 4xx/5xx sayılır
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: express.Request) => 'ip:' + ipKeyGenerator(req.ip || req.socket?.remoteAddress || 'unknown'),
  skip: skipRateLimit,
  message: { error: 'Çok fazla başarısız admin denemesi. Lütfen bir dakika bekleyin.' },
})
app.use('/api/admin', adminLimiter)

// Routes
app.use('/api/auth', authRoutes)
app.use('/api/bookings', bookingRoutes)
app.use('/api/venue', venueRoutes)
app.use('/api/admin', adminRoutes)
app.use('/api/public', publicRoutes)
app.use('/api/social', socialRouter)
app.use('/api/reviews', reviewRoutes)
app.use('/api/instructor', instructorRoutes)
app.use('/api/cron', cronRoutes)
app.use('/api/waitlist', waitlistRoutes)
app.use('/api/favorites', favoriteRoutes)
app.use('/api/referral', referralRoutes)
app.post('/api/chat', optionalAuthMiddleware, chat)
app.get('/api/chat/history', authMiddleware, getChatHistory)

// Test route
app.get('/', (req, res) => {
  res.json({ message: 'Fitpass API çalışıyor 🚀', version: '1.0.0' })
})

// SAĞLIK UÇLARI — dış izleme (uptime) ve Railway healthcheck için. `/api` prefix'i DIŞINDA,
// dolayısıyla generalLimiter'a takılmazlar (izleme her dakika vurabilir).
//
// Neden İKİ ayrı uç: süreç `uncaughtException`/`unhandledRejection` yakalayıp KASTEN ayakta kaldığı
// için "process çalışıyor" ≠ "sistem çalışıyor". DB düşse bile /health 200 döner; bunu ayırt etmek
// için readiness ucu gerekiyor. Railway healthcheck'i /health (liveness) kullanmalı — /health/ready
// kullanılırsa geçici bir DB kesintisi deploy'u geri alır.
// SIFIR-KESİNTİ DEPLOY DURUMU.
// bootTamam: açılış işleri (ensureIndexes vb.) bitene kadar false. Railway healthcheck'i bu uca
// baktığı için yeni konteyner HAZIR OLMADAN trafik almaz — ölçülen ~30sn'lik 502 penceresi
// buradan geliyordu (healthcheckPath tanımlı değildi, trafik anında yeni konteynere dönüyordu).
// kapaniyor: SIGTERM sonrası true. Uç 503 dönünce yönlendirici bu konteynere YENİ istek yollamayı
// keser; uçmakta olan istekler graceful shutdown içinde tamamlanır.
let bootTamam = false
// Kurulamayan tekillik index'leri — /health/ready raporlar (koruma boşluğu sessiz kalmasın).
let indexHatalari: string[] = []
let kapaniyor = false

app.get('/health', (req, res) => {
  if (kapaniyor) return res.status(503).json({ ok: false, state: 'shutting_down' })
  if (!bootTamam) return res.status(503).json({ ok: false, state: 'booting' })
  res.json({
    ok: true,
    uptime: Math.round(process.uptime()),
    release: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) || null,
  })
})

app.get('/health/ready', async (req, res) => {
  // 2sn timeout: DB asılıysa izleme ucu de asılmasın
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('db timeout')), 2000))
  try {
    await Promise.race([prisma.$queryRaw`SELECT 1`, timeout])
    // Kurulamayan tekillik index'leri: sunucu çalışıyor ama BİR KORUMA YOK (örn. rozet
    // çift-veriş engeli). Eskiden yalnız açılış log'una düşüp kayboluyordu; artık izleme
    // görebilsin diye burada raporlanıyor. Servis ayakta olduğu için 200, ama ok:false değil —
    // "hazır ama eksik" ayrı bir alanla anlatılıyor ki mevcut izleme kırılmasın.
    // Görsel yükleme yapılandırılmış mı? Yalnız EVET/HAYIR — anahtar ya da hesap adı DÖNMEZ.
    // Neden burada: yapılandırma bozuk/eksikse yükleme sessizce ölür ve bu ancak bir kullanıcı
    // fotoğraf yüklemeye çalışınca fark edilir. Ortam değişkeni bir kez yanlış girildi ve
    // saatler kaybettirdi; artık dışarıdan tek istekle doğrulanabiliyor.
    const yuklemeHazir = /^cloudinary:\/\/[^:@/<>\s]+:[^@/<>\s]+@[^/<>\s]+$/.test((process.env.CLOUDINARY_URL || '').trim())
      || !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET)
    // E-POSTA SAĞLIĞI: Resend bozulursa (kota, domain doğrulaması, 5xx) kayıt hunisi SESSİZCE
    // ölür — kullanıcı doğrulama kodunu hiç almaz. Hatalar loglanıyordu ama log okuyan yok;
    // burada tek istekle görünür. Ayrıntı DEĞİL, durum: 'ok' | 'bozuk' | 'kullanilmadi'.
    // YAPILANDIRMA da denetlenir — sayaç yalnız TRAFİĞİ görür. RESEND_API_KEY hiç yokken sayaç
    // boş kalır ve durum sonsuza dek 'kullanilmadi' der; bu "henüz posta gitmedi" ile "posta HİÇ
    // gidemez"i AYIRT ETMEZ. uploads alanı CLOUDINARY_URL'i zaten denetliyordu — aynı ölçü.
    const epostaHazir = epostaYapilandirildi()   // tek kaynak: utils/email
    const eposta = epostaSagligi()
    res.json({
      ok: true,
      uploads: yuklemeHazir ? 'ok' : 'yapilandirilmamis',
      email: epostaHazir ? eposta.durum : 'yapilandirilmamis',
      ...(eposta.durum === 'bozuk' ? { emailBasarisiz: eposta.basarisiz, emailGonderilen: eposta.gonderilen } : {}),
      ...(indexHatalari.length ? { indexUyarisi: indexHatalari } : {}),
    })
  } catch {
    // Dışarıya ayrıntı verme (altyapı bilgisi sızmasın); log tarafında zaten görünür
    res.status(503).json({ ok: false })
  }
})

// KAOS test route'ları — SADECE CHAOS_TEST=true iken mount edilir (prod'da asla aktif değil).
// "Tek bir hata tüm sistemi düşürmez" güvencesini kanıtlamak için kasıtlı hata enjekte eder.
if (process.env.CHAOS_TEST === 'true') {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  app.use('/_chaos', require('./routes/_chaos').default)
}

// Propagate olan (yakalanmamış) hataları Sentry'ye ilet
if (process.env.SENTRY_DSN) {
  Sentry.setupExpressErrorHandler(app)
}

// BİLİNMEYEN /api YOLU → JSON 404. Express varsayılanı HTML sayfası döndürüyordu: bir istemci
// yanlış/eski bir uca gittiğinde `res.json()` patlıyor ve hata "sunucu bozuk" gibi görünüyordu.
// Yalnız /api altında; kök ve /health kendi yanıtlarını verir.
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Böyle bir uç yok.' })
})

// Son güvenlik ağı: route'tan sızan hata olursa temiz JSON 500 dön (HTML/çökme yerine)
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  // body-parser gibi istemci hataları 4xx taşır → onları 5xx'e çevirme
  const status = err?.status || err?.statusCode || 500
  if (status >= 500) console.error('Express hata:', err)
  if (res.headersSent) return next(err)
  res.status(status).json({ error: status >= 500 ? 'Sunucu hatası.' : 'Geçersiz istek.' })
})

// SÜREÇ GÜVENLİĞİ: tek bir yakalanmamış hata/promise TÜM sunucuyu düşürmesin.
// Logla (Sentry'ye iletilir) ama süreci ayakta tut → diğer kullanıcılar etkilenmesin.
process.on('unhandledRejection', (reason) => {
  console.error('UnhandledRejection (yakalandı, sunucu ayakta):', reason)
})
process.on('uncaughtException', (err) => {
  console.error('UncaughtException (yakalandı, sunucu ayakta):', err)
})

// ── AÇILIŞ İŞLERİ: TEK TANIM, İKİ ÇAĞIRAN ────────────────────────────────────────────────────
// İlk açılış ve gecikmeli yeniden deneme AYNI fonksiyonu çağırır; ikisinin ayrışması artık yapısal
// olarak imkânsız. (Eskiden ilk açılış dört iş + prob, yeniden deneme YALNIZ prob koşuyordu.)
// ensureTiers/ensureGeo de artık AWAIT'li: beklenmediklerinde açılış "tamam" derken hâlâ sürüyor
// olabiliyorlardı.
async function acilisIsleri(): Promise<void> {
  await ensureTiers()
  await ensureGeo()
  // ensureIndexes ÖNCE ve await'li: rozet çift-veriş koruması YALNIZCA bu ifade-index'i sayesinde
  // çalışıyor; kurulmadan gelen istek/job rozet yazarsa skipDuplicates hiçbir şey engellemez.
  indexHatalari = await ensureIndexes()
  await ensureBadges()
  // DB CANLILIK PROBU — hazır-olma kapısının asıl dayanağı. Yukarıdaki işlerin hepsi kendi
  // hatalarını yutuyor, dolayısıyla DB erişilemezken bile buraya kadar gelinebilir. Bu satır
  // invariant'ı açıkça ifade eder: veritabanına ulaşamayan konteyner trafik ALMAMALI.
  // EN SONDA olmalı — fırlatırsa bootTamam set edilmez ve yeniden deneme turu devreye girer.
  await prisma.$queryRaw`SELECT 1`
}

const server = app.listen(PORT, async () => {
  console.log(`✅ Fitpass sunucusu http://localhost:${PORT} adresinde çalışıyor (açılış işleri sürüyor)`)
  // Seviye (Tier) yapılandırmasını kanonik değerlere hizala (Aday %1 → Olimpik %5)
  try {
    // DB-seviyesi tekillik index'leri — ÖNCE ve AWAIT'li olmalı: rozet çift-veriş koruması YALNIZCA bu
    // ifade-index'i sayesinde çalışıyor. Beklenmeden başlatılırsa, index kurulmadan önce gelen istek/job
    // rozet yazabilir ve skipDuplicates hiçbir şey engellemez (çift rozet + çift bildirim).
    await acilisIsleri()
    // DB CANLILIK PROBU — HAZIR-OLMA KAPISININ ASIL DAYANAĞI. Yukarıdaki açılış işlerinin
    // hepsi kendi hatalarını yutuyor (ensureIndexes artık liste döndürüyor ama fırlatmıyor),
    // dolayısıyla DB tamamen erişilemezken bile buraya kadar gelinip "hazır" denebiliyordu:
    // kapı vardı ama hiçbir şeyi tutmuyordu. Bu tek satır invariant'ı açıkça ifade eder —
    // veritabanına ulaşamayan bir konteyner trafik ALMAMALI.
    // BURADAN İTİBAREN TRAFİK ALABİLİR. /health bu bayrağa bakıyor; Railway healthcheck'i de
    // /health'e baktığı için yeni konteyner ancak index'ler kurulduktan sonra trafik alır.
    // Bayrak set EDİLMEZSE (açılış hatası) healthcheck geçmez ve Railway ESKİ sürümü ayakta
    // tutar — bozuk bir konteynere trafik dönmesindense deploy'un geri alınması yeğdir.
    bootTamam = true
    console.log('✅ Açılış işleri tamamlandı — sunucu trafiğe hazır')
  } catch (e) {
    console.error('❌ AÇILIŞ HATASI — yeniden denenecek (healthcheck bu arada geçmez):', e)
    // TEK SEFERLİK DEĞİL, SINIRLI TEKRAR.
    //
    // Eskiden bu bayrak bir kez set edilemezse SONSUZA DEK false kalıyordu: deploy anında
    // DB'nin birkaç saniyelik bir kesintisi yeni konteyneri KALICI ÖLÜ bırakıyor, deploy hiç
    // tamamlanmıyor ve elle yeniden deploy gerekiyordu. Geçici bir aksaklık insan müdahalesi
    // gerektirmemeli.
    //
    // Niyet KORUNUYOR: DB'ye gerçekten ulaşamayan konteyner trafik ALMAZ. Yalnızca "hiç deneme"
    // yerine "sınırlı süre dene" oluyoruz. Süre dolarsa konteyner sağlıksız kalır ve Railway
    // eski sürümü ayakta tutar — istenen davranış bu.
    const TEKRAR_ARALIGI_MS = 5_000
    const TEKRAR_BUTCESI_MS = 3 * 60_000 // 3 dk: geçici kesinti için bol, kalıcı arıza için kısa
    const basladi = Date.now()
    const yenidenDene = setInterval(async () => {
      if (bootTamam) { clearInterval(yenidenDene); return }
      if (Date.now() - basladi > TEKRAR_BUTCESI_MS) {
        clearInterval(yenidenDene)
        console.error(`❌ AÇILIŞ ${Math.round(TEKRAR_BUTCESI_MS / 1000)}sn içinde tamamlanamadı — sunucu SAĞLIKSIZ kalıyor.`)
        return
      }
      try {
        // TÜM AÇILIŞ İŞLERİ, sadece canlılık probu değil. Eskiden burada yalnız `SELECT 1` vardı:
        // DB gecikmeli geldiğinde tier/geo/index/rozet işleri BİR DAHA KOŞMUYOR, sunucu yine de
        // "hazır" diyordu. CANLI SİMÜLE EDİLDİ (150sn bağlantı reddeden TCP proxy): loglar
        // ensureTiers/ensureGeo/6-6 index/ensureBadges hatası bastı, ardından sunucu trafiğe
        // açıldı — yani tekillik index'leri KURULMAMIŞ hâlde rozet yazılabilir durumdaydı.
        await acilisIsleri()
        bootTamam = true
        clearInterval(yenidenDene)
        console.log('✅ DB yeniden erişilebilir — açılış işleri koştu, sunucu trafiğe hazır (gecikmeli açılış)')
      } catch { /* bir sonraki turda yine denenecek */ }
    }, TEKRAR_ARALIGI_MS)
    // Süreç kapanışını bu zamanlayıcı BEKLETMESİN (SIGTERM'de temiz çıkış şart).
    yenidenDene.unref?.()
  }
  awardSeasonChampions()
  // Sezon dönümünü yakalamak için 12 saatte bir kontrol (sezon başına tek kez ödül verir)
  setInterval(() => { awardSeasonChampions() }, 12 * 60 * 60 * 1000)
  // Her 30 dakikada hatırlatma maili gönder
  sendRemindersJob()
  setInterval(sendRemindersJob, 30 * 60 * 1000)
  // Streak teşvik e-postaları: saatte bir kontrol (job kendi içinde akşam penceresi + 20s guard uygular)
  sendStreakNudges()
  setInterval(sendStreakNudges, 60 * 60 * 1000)
  // Ders sonrası puanlama hatırlatması: 30 dk'da bir (job kendi içinde 2sa+ / checkedIn / tek-puan filtreler)
  sendRatingPrompts()
  setInterval(sendRatingPrompts, 30 * 60 * 1000)
  // Bekleme listesi süpürgesi: 10 dk'da bir. Bildirim önceliği penceresi 30 dk olduğu için
  // 10 dk, penceresi dolan bekleyeni makul sürede yakalar. Yerin NASIL açıldığına bakmaz
  // (iptal, pencere dolması, salonun kapasiteyi artırması) — durum-tabanlı mutabakat.
  sweepWaitlist()
  setInterval(sweepWaitlist, 10 * 60 * 1000)
  // Katılım puanı mutabakatı: 15 dk'da bir. Check-in'de puan kredisi bilerek "ateşle-unut"
  // (müşteri kapıda beklerken check-in yavaşlamasın); başarısız olursa kullanıcı hak ettiği
  // puanı hiç almaz ve kimse fark etmez. Bu job kredilenmemiş check-in'leri tamamlar.
  reconcileAttendancePoints()
  setInterval(reconcileAttendancePoints, 15 * 60 * 1000)

  // EKSİK ÇEVİRİLER — bkz. jobs/translationJob.ts. İngilizce alanlar yalnız kayıt oluşturulurken
  // bir kez üretiliyor ve Groq 6 saniyede yanıt vermezse (ya da kota dolmuşsa) alan KALICI olarak
  // boş kalıyordu; İngilizce arayüzde Türkçe metin görünüyordu. 30 dk: acil değil, Groq'un hız
  // sınırını da zorlamıyor.
  fillMissingTranslations()
  setInterval(fillMissingTranslations, 30 * 60 * 1000)
})

// ─────────────────────────────────────────────────────────────────────────────
// GRACEFUL SHUTDOWN — deploy sırasında uçmakta olan istekler ÖLMESİN.
// Railway yeni sürümü ayağa kaldırırken eskisine SIGTERM yollar; işleyici olmadan Node
// süreci ANINDA ölüyor ve o an işlenen her istek (rezervasyon, check-in, ödeme) yarıda
// kalıyordu. Sıra: sağlıksız işaretle → yönlendirici trafiği kessin diye kısa bekle →
// yeni bağlantıları kapat → uçanları bitir → DB havuzunu kapat → çık.
// drainingSeconds (railway.json) SIGTERM ile SIGKILL arası süredir; aşağıdaki toplam
// süre ondan KISA olmalı, aksi halde zorla öldürülürüz.
// ─────────────────────────────────────────────────────────────────────────────
const DRENAJ_MS = 3000   // yönlendiricinin /health'i 503 görmesi için
const ZORLA_MS = 12000   // takılan bağlantılar için üst sınır

async function gracefulShutdown(signal: string) {
  if (kapaniyor) return
  kapaniyor = true
  console.log(`🛑 ${signal} alındı — graceful shutdown başlıyor`)

  // Takılırsak bile mutlaka çık (unref: bu zamanlayıcı süreci ayakta TUTMASIN)
  const zorlaCik = setTimeout(() => {
    console.error('⚠️ Graceful shutdown zaman aşımı — zorla çıkılıyor')
    process.exit(0)
  }, ZORLA_MS)
  zorlaCik.unref()

  await new Promise(r => setTimeout(r, DRENAJ_MS))

  server.close(async () => {
    try { await prisma.$disconnect() } catch { /* kapanışta yut */ }
    console.log('✅ Bağlantılar kapandı, temiz çıkılıyor')
    process.exit(0)
  })
  // Keep-alive ile boşta bekleyen bağlantılar server.close()'u süresiz bekletebilir.
  server.closeIdleConnections?.()
}

process.on('SIGTERM', () => { void gracefulShutdown('SIGTERM') })
process.on('SIGINT', () => { void gracefulShutdown('SIGINT') })

export default app
