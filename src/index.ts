import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import authRoutes from './routes/auth'
import bookingRoutes from './routes/bookings'
import venueRoutes from './routes/venue'
import adminRoutes from './routes/admin'
import publicRoutes from './routes/public'
import socialRouter from './routes/social'

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

// Test route
app.get('/', (req, res) => {
  res.json({ message: 'Fitpass API çalışıyor 🚀', version: '1.0.0' })
})

app.listen(PORT, () => {
  console.log(`✅ Fitpass sunucusu http://localhost:${PORT} adresinde çalışıyor`)
})

export default app
