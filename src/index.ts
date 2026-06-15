import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
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

dotenv.config()

const app = express()
const PORT = process.env.PORT || 3000

app.use(cors())
app.use(express.json())

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
