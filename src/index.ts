import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import rateLimit from 'express-rate-limit'
import { sendRemindersJob } from './jobs/reminderJob'
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
import { chat } from './controllers/chatController'

dotenv.config()

const app = express()
const PORT = process.env.PORT || 3000

app.set('trust proxy', 1) // Railway reverse proxy arkasında gerçek IP'yi al

app.use(cors())
app.use(express.json())

// Rate limiting
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,      // 1 dakika
  max: 100,                  // 1 dakikada max 100 istek
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Çok fazla istek gönderildi. Lütfen bir dakika bekleyin.' },
})

const authLimiter = rateLimit({
  windowMs: 60 * 1000,      // 1 dakika
  max: 10,                   // 1 dakikada max 10 deneme (login, register, şifre sıfırlama)
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Çok fazla giriş denemesi. Lütfen bir dakika bekleyin.' },
})

const chatLimiter = rateLimit({
  windowMs: 60 * 1000,      // 1 dakika
  max: 20,                   // 1 dakikada max 20 chat isteği
  standardHeaders: true,
  legacyHeaders: false,
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
app.post('/api/chat', chat)

// Test route
app.get('/', (req, res) => {
  res.json({ message: 'Fitpass API çalışıyor 🚀', version: '1.0.0' })
})

app.listen(PORT, () => {
  console.log(`✅ Fitpass sunucusu http://localhost:${PORT} adresinde çalışıyor`)
  // Her 30 dakikada hatırlatma maili gönder
  sendRemindersJob()
  setInterval(sendRemindersJob, 30 * 60 * 1000)
})

export default app
