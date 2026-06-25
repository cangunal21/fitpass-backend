import dotenv from 'dotenv'
dotenv.config()
import { initSentry, Sentry } from './utils/sentry'
initSentry()

import express from 'express'
import cors from 'cors'
import crypto from 'crypto'
import rateLimit from 'express-rate-limit'
import { sendRemindersJob } from './jobs/reminderJob'
import { sendStreakNudges } from './jobs/streakJob'
import authRoutes from './routes/auth'
import bookingRoutes from './routes/bookings'
import venueRoutes from './routes/venue'
import adminRoutes from './routes/admin'
import publicRoutes from './routes/public'
import socialRouter from './routes/social'
import reviewRoutes from './routes/reviews'
import cronRoutes from './routes/cron'
import waitlistRoutes from './routes/waitlist'
import favoriteRoutes from './routes/favorites'
import referralRoutes from './routes/referral'
import { chat, getChatHistory } from './controllers/chatController'
import { authMiddleware, optionalAuthMiddleware } from './middlewares/auth'

const app = express()
const PORT = process.env.PORT || 3001

app.set('trust proxy', 1) // Railway reverse proxy arkasında gerçek IP'yi al

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

// Anahtar: girişli kullanıcı → token bazlı (aynı IP'yi paylaşan NAT/operatör kullanıcıları
// birbirini limite sokmasın); anonim → IP bazlı.
function rlKey(req: express.Request): string {
  const auth = req.headers.authorization
  if (auth && auth.startsWith('Bearer ')) return 'u:' + crypto.createHash('sha1').update(auth.slice(7)).digest('hex')
  return 'ip:' + (req.ip || req.socket?.remoteAddress || 'unknown')
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

app.use('/api', generalLimiter)
app.use('/api/auth/login', authLimiter)
app.use('/api/auth/register', authLimiter)
app.use('/api/auth/forgot-password', authLimiter)
app.use('/api/venue/login', authLimiter)
app.use('/api/venue/register', authLimiter)
app.use('/api/venue/forgot-password', authLimiter)
app.use('/api/chat', chatLimiter)

// Routes
app.use('/api/auth', authRoutes)
app.use('/api/bookings', bookingRoutes)
app.use('/api/venue', venueRoutes)
app.use('/api/admin', adminRoutes)
app.use('/api/public', publicRoutes)
app.use('/api/social', socialRouter)
app.use('/api/reviews', reviewRoutes)
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
  // Her 30 dakikada hatırlatma maili gönder
  sendRemindersJob()
  setInterval(sendRemindersJob, 30 * 60 * 1000)
  // Streak teşvik e-postaları: saatte bir kontrol (job kendi içinde akşam penceresi + 20s guard uygular)
  sendStreakNudges()
  setInterval(sendStreakNudges, 60 * 60 * 1000)
})

export default app
