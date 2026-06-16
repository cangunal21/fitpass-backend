import { Request, Response } from 'express'
import prisma from '../utils/prisma'

// Salon doluluk istatistikleri
export const getVenueStats = async (req: Request, res: Response) => {
  try {
    const venueId = (req as any).venueId
    const now = new Date()
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)

    // Tüm seansları al (son 30 gün + gelecek)
    const sessions = await prisma.class_Session.findMany({
      where: {
        class: { venueId },
        startsAt: { gte: thirtyDaysAgo }
      },
      include: {
        class: { select: { title: true, basePrice: true } },
        bookings: { where: { status: 'confirmed' }, select: { id: true, finalAmount: true } }
      },
      orderBy: { startsAt: 'asc' }
    })

    // Toplam istatistikler
    const totalSessions = sessions.length
    const totalBookings = sessions.reduce((acc, s) => acc + s.bookings.length, 0)
    const totalRevenue = sessions.reduce((acc, s) => acc + s.bookings.reduce((a, b) => a + b.finalAmount, 0), 0)
    const avgFillRate = sessions.length > 0
      ? sessions.reduce((acc, s) => acc + (s.availableSpots > 0 ? s.bookings.length / s.availableSpots : 0), 0) / sessions.length
      : 0

    // Günlere göre doluluk (0=Paz, 1=Pzt...)
    const DAY_NAMES = ['Pazar', 'Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi']
    const byDay: Record<number, { total: number; booked: number; count: number }> = {}
    for (let i = 0; i < 7; i++) byDay[i] = { total: 0, booked: 0, count: 0 }

    sessions.forEach(s => {
      const day = new Date(s.startsAt).getDay()
      byDay[day].count++
      byDay[day].total += s.availableSpots
      byDay[day].booked += s.bookings.length
    })

    const dayStats = Object.entries(byDay).map(([day, data]) => ({
      day: DAY_NAMES[parseInt(day)],
      fillRate: data.total > 0 ? Math.round((data.booked / data.total) * 100) : 0,
      sessions: data.count,
    })).filter(d => d.sessions > 0)

    // En popüler seanslar
    const topSessions = [...sessions]
      .filter(s => s.availableSpots > 0)
      .sort((a, b) => (b.bookings.length / b.availableSpots) - (a.bookings.length / a.availableSpots))
      .slice(0, 5)
      .map(s => ({
        title: s.class.title,
        date: s.startsAt,
        fillRate: Math.round((s.bookings.length / s.availableSpots) * 100),
        booked: s.bookings.length,
        capacity: s.availableSpots,
      }))

    // Yaklaşan seanslar (önümüzdeki 7 gün)
    const upcoming = sessions
      .filter(s => s.startsAt >= now && s.startsAt <= new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000))
      .map(s => ({
        title: s.class.title,
        date: s.startsAt,
        booked: s.bookings.length,
        capacity: s.availableSpots,
        fillRate: s.availableSpots > 0 ? Math.round((s.bookings.length / s.availableSpots) * 100) : 0,
      }))

    return res.json({
      summary: {
        totalSessions,
        totalBookings,
        totalRevenue: Math.round(totalRevenue),
        avgFillRate: Math.round(avgFillRate * 100),
      },
      dayStats,
      topSessions,
      upcoming,
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}
