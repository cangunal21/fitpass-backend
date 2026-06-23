import prisma from '../utils/prisma'
import { sendStreakNudgeEmail } from '../utils/email'
import { sendPushNotification } from '../utils/push'
import {
  istanbulDayKey, istanbulMondayKey, istanbulHour,
  currentDailyStreak, currentWeeklyStreak,
} from '../utils/streak'

// Streak teşvik e-postaları:
// - Günlük: 2+ gün üst üste gidip bugün henüz gitmemiş kullanıcıya "bugün de git, serini sürdür"
// - Haftalık: 2+ hafta üst üste gidip bu hafta henüz gitmemiş kullanıcıya "bu hafta da git, serini bozma"
// Akşam penceresinde (16:00-21:00 İstanbul) ve kullanıcı başına günde en fazla 1 kez gönderilir.
export const sendStreakNudges = async () => {
  try {
    const now = new Date()
    const hour = istanbulHour(now)
    if (!process.env.STREAK_FORCE && (hour < 16 || hour > 21)) return // sadece akşam penceresi

    // Son 12 günde aktivitesi olan kullanıcılar (sadece onların aktif serisi olabilir)
    const since = new Date(now.getTime() - 12 * 86400000)
    const recentBookings = await prisma.booking.findMany({
      where: { status: 'confirmed', session: { startsAt: { gte: since } } },
      select: { userId: true },
    })
    const recentDropins = await prisma.dropInParticipant.findMany({
      where: { status: 'confirmed', slot: { startsAt: { gte: since } } },
      select: { userId: true },
    })
    const candidateIds = Array.from(new Set([
      ...recentBookings.map(b => b.userId),
      ...recentDropins.map(d => d.userId),
    ]))
    if (candidateIds.length === 0) return

    const guardWindow = new Date(now.getTime() - 20 * 3600 * 1000) // 20 saatte 1
    const lookback = new Date(now.getTime() - 60 * 86400000) // streak bağlamı için son 60 gün

    for (const userId of candidateIds) {
      try {
        const user = await prisma.user.findUnique({
          where: { id: userId },
          select: { email: true, fullName: true, emailReminders: true, lastStreakNudgeAt: true, pushToken: true },
        })
        if (!user?.email || user.emailReminders === false) continue
        if (user.lastStreakNudgeAt && user.lastStreakNudgeAt > guardWindow) continue

        // Onaylı dersler + drop-in'ler (son 60 gün, gelecekteki bu hafta dahil)
        const [bookings, dropins] = await Promise.all([
          prisma.booking.findMany({
            where: { userId, status: 'confirmed', session: { startsAt: { gte: lookback } } },
            select: { session: { select: { startsAt: true } } },
          }),
          prisma.dropInParticipant.findMany({
            where: { userId, status: 'confirmed', slot: { startsAt: { gte: lookback } } },
            select: { slot: { select: { startsAt: true } } },
          }),
        ])

        const allDates: Date[] = [
          ...bookings.map(b => b.session?.startsAt).filter(Boolean) as Date[],
          ...dropins.map(d => d.slot?.startsAt).filter(Boolean) as Date[],
        ]
        // Seri sayımı geçmiş (gerçekleşmiş) aktivitelere göre
        const pastDates = allDates.filter(d => d < now)

        const todayKey = istanbulDayKey(now)
        const thisMonday = istanbulMondayKey(now)
        // "Bugün/bu hafta zaten gidiyor mu" — gelecekteki rezervasyonlar dahil
        const wentToday = allDates.some(d => istanbulDayKey(d) === todayKey)
        const wentThisWeek = allDates.some(d => istanbulMondayKey(d) === thisMonday)

        const dailyStreak = currentDailyStreak(pastDates, now)
        const weeklyStreak = currentWeeklyStreak(pastDates, now)

        let sent = false
        // Günlük seri önceliği (daha acil): 2+ gün ve bugün henüz gitmemiş
        if (dailyStreak >= 2 && !wentToday) {
          await sendStreakNudgeEmail(user.email, user.fullName, 'daily', dailyStreak)
          if (user.pushToken) sendPushNotification(user.pushToken, `🔥 ${dailyStreak} günlük serini bozma!`, `Bugün de bir derse katıl, serini ${dailyStreak + 1} güne çıkar!`).catch(() => {})
          sent = true
        } else if (weeklyStreak >= 2 && !wentThisWeek) {
          await sendStreakNudgeEmail(user.email, user.fullName, 'weekly', weeklyStreak)
          if (user.pushToken) sendPushNotification(user.pushToken, `🔥 ${weeklyStreak} haftalık serini sürdür!`, `Bu hafta da bir derse katıl, serini ${weeklyStreak + 1} haftaya taşı!`).catch(() => {})
          sent = true
        }

        if (sent) {
          await prisma.user.update({ where: { id: userId }, data: { lastStreakNudgeAt: now } })
        }
      } catch (uErr) {
        console.error('Streak nudge (user) error:', userId, uErr)
      }
    }
  } catch (err) {
    console.error('Streak nudge job error:', err)
  }
}
