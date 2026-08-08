import { Request, Response } from 'express'
import prisma from '../utils/prisma'
import { trWeekday, trMonthStart, trYmd } from '../utils/trFormat'

// Salon doluluk istatistikleri
export const getVenueStats = async (req: Request, res: Response) => {
  try {
    const venueId = (req as any).venueId
    const now = new Date()
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
    // Üst sınır: istatistikler yalnızca son-30-gün geçmişi + yaklaşan-7-gün + top-5 seansı kullanıyor.
    // ~90 günlük pencere tüm çıktıları kapsar; salon çok ileriye seans açsa da sorgu sınırsız büyümesin.
    const ninetyDaysAhead = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000)

    // Seansları al (son 30 gün + gelecek 90 gün, en fazla 2000 satır — bellek/CPU sınırı)
    const sessions = await prisma.class_Session.findMany({
      where: {
        class: { venueId },
        startsAt: { gte: thirtyDaysAgo, lte: ninetyDaysAhead }
      },
      include: {
        class: { select: { title: true, basePrice: true } },
        bookings: { where: { status: 'confirmed' }, select: { id: true, finalAmount: true, groupSize: true } }
      },
      orderBy: { startsAt: 'asc' },
      take: 2000
    })

    // Doluluk = KOLTUK sayısı: grup rezervasyonu tek kayıt ama groupSize kadar koltuk doldurur.
    // Tüm booking/waitlist doluluk mantığı groupSize topluyor — istatistik de tutarlı olmalı
    // (aksi halde grup rezervasyonu olan dolu seans yarı-boş görünür).
    const occ = (s: (typeof sessions)[number]) => s.bookings.reduce((a, b) => a + (b.groupSize || 1), 0)

    // Toplam istatistikler
    const totalSessions = sessions.length
    const totalBookings = sessions.reduce((acc, s) => acc + s.bookings.length, 0)
    const totalRevenue = sessions.reduce((acc, s) => acc + s.bookings.reduce((a, b) => a + b.finalAmount, 0), 0)
    const avgFillRate = sessions.length > 0
      ? sessions.reduce((acc, s) => acc + (s.availableSpots > 0 ? occ(s) / s.availableSpots : 0), 0) / sessions.length
      : 0

    // Günlere göre doluluk (0=Paz, 1=Pzt...)
    const DAY_NAMES = ['Pazar', 'Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi']
    const byDay: Record<number, { total: number; booked: number; count: number }> = {}
    for (let i = 0; i < 7; i++) byDay[i] = { total: 0, booked: 0, count: 0 }

    sessions.forEach(s => {
      // getDay() SUNUCUNUN gününü verir (Railway=UTC). İstanbul'da 00:00–02:59 başlayan seanslar
      // bir önceki günün kutusuna düşüyordu: salon Pazartesi gecesi açtığı dersi Pazar performansı
      // olarak görüyor, program kararını yanlış güne göre veriyordu.
      const day = trWeekday(s.startsAt)
      byDay[day].count++
      byDay[day].total += s.availableSpots
      byDay[day].booked += occ(s)
    })

    const dayStats = Object.entries(byDay).map(([day, data]) => ({
      day: DAY_NAMES[parseInt(day)],
      fillRate: data.total > 0 ? Math.round((data.booked / data.total) * 100) : 0,
      sessions: data.count,
    })).filter(d => d.sessions > 0)

    // En popüler seanslar
    const topSessions = [...sessions]
      .filter(s => s.availableSpots > 0)
      .sort((a, b) => (occ(b) / b.availableSpots) - (occ(a) / a.availableSpots))
      .slice(0, 5)
      .map(s => ({
        title: s.class.title,
        date: s.startsAt,
        fillRate: Math.round((occ(s) / s.availableSpots) * 100),
        booked: occ(s),
        capacity: s.availableSpots,
      }))

    // Yaklaşan seanslar (önümüzdeki 7 gün)
    const upcoming = sessions
      .filter(s => s.startsAt >= now && s.startsAt <= new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000))
      .map(s => ({
        title: s.class.title,
        date: s.startsAt,
        booked: occ(s),
        capacity: s.availableSpots,
        fillRate: s.availableSpots > 0 ? Math.round((occ(s) / s.availableSpots) * 100) : 0,
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

// Salon gelir raporu
export const getVenueRevenue = async (req: Request, res: Response) => {
  try {
    const venueId = (req as any).venueId
    const now = new Date()

    // Son 6 ayın başlangıcı — İSTANBUL ay sınırı. (Aşağıdaki "Bu Ay" hesabı zaten trMonthStart
    // kullanıyordu; burası ve aylık grafik sunucu-yerel new Date(y,m,1) ile kalmıştı → ayın ilk
    // 3 saatinde AYNI EKRANDA çelişen iki ciro rakamı çıkıyordu.)
    const sixMonthsAgo = trMonthStart(now, -5)

    // Tüm confirmed bookings (son 6 ay)
    const bookings = await prisma.booking.findMany({
      where: {
        status: 'confirmed',
        session: { class: { venueId } },
        createdAt: { gte: sixMonthsAgo }
      },
      include: {
        session: {
          include: { class: { select: { title: true, basePrice: true, venueId: true } } }
        }
      }
    })

    // İptal edilen bookings
    const cancelled = await prisma.booking.findMany({
      where: {
        status: 'cancelled',
        session: { class: { venueId } },
        createdAt: { gte: sixMonthsAgo }
      },
      select: { finalAmount: true, discountAmount: true, createdAt: true }
    })

    // Bu ay / geçen ay
    // Ay sınırı İSTANBUL'da 00:00'dır. new Date(y, m, 1) sunucu yerelini (UTC) kullanıyordu →
    // ayın ilk 3 saatinde yapılan ciro bir ÖNCEKİ aya yazılıyordu (gelir raporu yanlış).
    const thisMonthStart = trMonthStart(now)
    const lastMonthStart = trMonthStart(now, -1)

    const thisMonthBookings = bookings.filter(b => new Date(b.createdAt) >= thisMonthStart)
    const lastMonthBookings = bookings.filter(b => new Date(b.createdAt) >= lastMonthStart && new Date(b.createdAt) < thisMonthStart)

    const thisMonthRevenue = thisMonthBookings.reduce((acc, b) => acc + b.finalAmount, 0)
    const lastMonthRevenue = lastMonthBookings.reduce((acc, b) => acc + b.finalAmount, 0)
    const totalRevenue = bookings.reduce((acc, b) => acc + b.finalAmount, 0)
    const avgPerBooking = bookings.length > 0 ? totalRevenue / bookings.length : 0
    const totalCancelledAmount = cancelled.reduce((acc, b) => acc + b.finalAmount, 0)

    const monthChange = lastMonthRevenue > 0
      ? Math.round(((thisMonthRevenue - lastMonthRevenue) / lastMonthRevenue) * 100)
      : null

    // Aylık gelir (son 6 ay)
    const MONTHS_TR = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara']
    const monthlyRevenue: { month: string; revenue: number; bookings: number }[] = []
    for (let i = 5; i >= 0; i--) {
      const start = trMonthStart(now, -i)
      const end = trMonthStart(now, -i + 1)
      const monthBookings = bookings.filter(b => {
        const d = new Date(b.createdAt)
        return d >= start && d < end
      })
      monthlyRevenue.push({
        // Ay ETİKETİ de TR'den okunmalı: `start` artık İstanbul ay başını temsil eden bir UTC anı
        // (ör. Ağustos için 31 Tem 21:00Z) → start.getMonth() UTC'de bir ÖNCEKİ ayı verirdi.
        month: MONTHS_TR[parseInt(trYmd(start).slice(5, 7), 10) - 1],
        revenue: Math.round(monthBookings.reduce((acc, b) => acc + b.finalAmount, 0)),
        bookings: monthBookings.length,
      })
    }

    // Ders bazlı gelir
    const classMap: Record<string, { title: string; sessions: number; bookings: number; revenue: number }> = {}
    bookings.forEach(b => {
      const title = b.session?.class?.title || 'Bilinmiyor'
      if (!classMap[title]) classMap[title] = { title, sessions: 0, bookings: 0, revenue: 0 }
      classMap[title].bookings++
      classMap[title].revenue += b.finalAmount
    })
    const byClass = Object.values(classMap).sort((a, b) => b.revenue - a.revenue)

    return res.json({
      summary: {
        thisMonthRevenue: Math.round(thisMonthRevenue),
        lastMonthRevenue: Math.round(lastMonthRevenue),
        monthChange,
        totalRevenue: Math.round(totalRevenue),
        avgPerBooking: Math.round(avgPerBooking),
        totalBookings: bookings.length,
        cancelledCount: cancelled.length,
        totalCancelledAmount: Math.round(totalCancelledAmount),
      },
      monthlyRevenue,
      byClass,
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}
