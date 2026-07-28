import dotenv from 'dotenv'
dotenv.config()
import { initSentry, Sentry } from './utils/sentry'
initSentry()

import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import rateLimit, { ipKeyGenerator } from 'express-rate-limit'
import { verifyToken } from './utils/jwt'
import { sendRemindersJob } from './jobs/reminderJob'
import { sendStreakNudges } from './jobs/streakJob'
import { sendRatingPrompts } from './jobs/ratingPromptJob'
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

// GÜVENLİK: production'da kritik secret'lar set DEĞİLSE zayıf varsayılana düşmek yerine
// sunucuyu BAŞLATMA (fail-fast). Dev/test'te (NODE_ENV≠production) varsayılan kullanılabilir.
if (process.env.NODE_ENV === 'production' && (!process.env.JWT_SECRET || !process.env.ADMIN_SECRET)) {
  console.error('FATAL: production ortamında JWT_SECRET ve ADMIN_SECRET set edilmeli (zayıf varsayılan kullanılamaz).')
  process.exit(1)
}
if (!process.env.JWT_SECRET || !process.env.ADMIN_SECRET) {
  console.warn('⚠️  JWT_SECRET/ADMIN_SECRET set değil — zayıf varsayılan kullanılıyor (yalnızca dev/test için kabul edilebilir).')
}

const app = express()
const PORT = process.env.PORT || 3001

app.set('trust proxy', 1) // Railway reverse proxy arkasında gerçek IP'yi al
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
    return callback(new Error('CORS: bu origin\'e izin verilmiyor'))
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
  keyGenerator: (req: express.Request) => 'ip:' + (req.ip || req.socket?.remoteAddress || 'unknown'),
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

app.use('/api', generalLimiter)
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
app.use('/api/public/complaint', authLimiter)
app.use('/api/public/validate-coupon', couponLimiter)
app.use('/api/social/report', authLimiter)
app.use('/api/auth/resend-verification', authLimiter) // self-servis doğrulama-maili seli engeli
app.use('/api/social/follow', socialWriteLimiter)     // takip bildirim bombası engeli
app.use('/api/social/unfollow', socialWriteLimiter)
app.use('/api/social/feed', feedLimiter)              // yorum/beğeni spam + feed okuma
app.use('/api/social/leaderboard', heavyReadLimiter)  // liderlik tam-tablo hesabı
app.use('/api/public/users-search', heavyReadLimiter) // ILIKE tam-tablo taraması
app.use('/api/chat', chatLimiter)

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

app.listen(PORT, () => {
  console.log(`✅ Fitpass sunucusu http://localhost:${PORT} adresinde çalışıyor`)
  // Seviye (Tier) yapılandırmasını kanonik değerlere hizala (Aday %1 → Olimpik %5)
  ensureTiers()
  // İl + ilçe verisini garanti et (İstanbul seed'li; 4 yeni il + tüm ilçeleri idempotent ekle)
  ensureGeo()
  // DB-seviyesi tekillik index'leri (eğitmen e-postası vb.) — idempotent
  ensureIndexes()
  // Kanonik rozetleri (sezon şampiyonu) garanti et, sonra biten sezon şampiyonlarını ödüllendir
  ensureBadges().then(() => awardSeasonChampions())
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
})

export default app
