import prisma from '../utils/prisma'
import { sendStreakNudgeEmail } from '../utils/email'
import { sendPushNotification } from '../utils/push'
import { notifyPush } from '../utils/notifyText'
import { Locale } from '../utils/locale'
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

    // Son 12 günde aktivitesi olan kullanıcılar (sadece onların aktif serisi olabilir).
    // ELEME DB'DE YAPILIR: 20-saatlik nudge guard'ı + banlı + e-posta-opt-out filtreleri eskiden JS'te,
    // TÜM satırlar (limitsiz) çekildikten SONRA uygulanıyordu → aday listesi aktif kullanıcı sayısıyla
    // doğrusal büyüyüp her biri için ayrı findUnique atılıyordu (N+1). Filtreyi ilişkiye taşıdık.
    const since = new Date(now.getTime() - 12 * 86400000)
    const guard = new Date(now.getTime() - 20 * 3600 * 1000)
    const eligibleUser: any = {
      banned: false,
      NOT: { email: null },
      emailReminders: { not: false },
      OR: [{ lastStreakNudgeAt: null }, { lastStreakNudgeAt: { lt: guard } }],
    }
    const recentBookings = await prisma.booking.findMany({
      where: { status: 'confirmed', checkedIn: true, session: { startsAt: { gte: since } }, user: eligibleUser },
      select: { userId: true },
      // DISTINCT ŞART: `take` KİŞİ değil SATIR sınırlıyordu. Çok gelen bir kullanıcının 5000 satırı
      // diğer herkesi pencereden itebiliyordu (attendanceJob'daki "kırpma elemeden önce" kusurunun
      // aynısı). distinct ile sınır artık AYRI KULLANICI sayısına uygulanır.
      distinct: ['userId'],
      take: 5000,
    })
    const recentDropins = await prisma.dropInParticipant.findMany({
      where: { status: 'confirmed', checkedIn: true, slot: { startsAt: { gte: since } }, user: eligibleUser },
      select: { userId: true },
      // DISTINCT ŞART: `take` KİŞİ değil SATIR sınırlıyordu. Çok gelen bir kullanıcının 5000 satırı
      // diğer herkesi pencereden itebiliyordu (attendanceJob'daki "kırpma elemeden önce" kusurunun
      // aynısı). distinct ile sınır artık AYRI KULLANICI sayısına uygulanır.
      distinct: ['userId'],
      take: 5000,
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
          select: { email: true, fullName: true, emailReminders: true, lastStreakNudgeAt: true, pushToken: true, banned: true, locale: true },
        })
        if (!user?.email || user.emailReminders === false || user.banned) continue // banlı kullanıcıya push/mail gitmesin
        if (user.lastStreakNudgeAt && user.lastStreakNudgeAt > guardWindow) continue

        // Onaylı dersler + drop-in'ler (son 60 gün, gelecekteki bu hafta dahil)
        const [bookings, dropins] = await Promise.all([
          prisma.booking.findMany({
            // checkedIn FİLTRESİ KALDIRILDI: "bugün zaten gidiyor mu" kontrolü gelecekteki
            // rezervasyonu da saymalı (yorum bunu söylüyordu ama sorgu yalnız check-in'lileri
            // getiriyordu). Bugüne dersi olan ama henüz check-in yapmamış kullanıcı "serin kopuyor"
            // dürtmesi alıyordu. Seri sayımı yine YALNIZ check-in'li geçmişten besleniyor.
            where: { userId, status: 'confirmed', session: { startsAt: { gte: lookback } } },
            select: { checkedIn: true, session: { select: { startsAt: true } } },
          }),
          prisma.dropInParticipant.findMany({
            where: { userId, status: 'confirmed', slot: { startsAt: { gte: lookback } } },
            select: { checkedIn: true, slot: { select: { startsAt: true } } },
          }),
        ])

        const allDates: Date[] = [
          ...bookings.map(b => b.session?.startsAt).filter(Boolean) as Date[],
          ...dropins.map(d => d.slot?.startsAt).filter(Boolean) as Date[],
        ]
        // Seri sayımı YALNIZ gerçekleşmiş (check-in yapılmış, geçmiş) aktivitelere göre —
        // rezervasyon yapıp gitmemek seriyi büyütmemeli.
        const checkedInDates: Date[] = [
          ...bookings.filter(b => b.checkedIn).map(b => b.session?.startsAt).filter(Boolean) as Date[],
          ...dropins.filter(d => d.checkedIn).map(d => d.slot?.startsAt).filter(Boolean) as Date[],
        ]
        const pastDates = checkedInDates.filter(d => d < now)

        const todayKey = istanbulDayKey(now)
        const thisMonday = istanbulMondayKey(now)
        // "Bugün/bu hafta zaten gidiyor mu" — gelecekteki rezervasyonlar dahil
        const wentToday = allDates.some(d => istanbulDayKey(d) === todayKey)
        const wentThisWeek = allDates.some(d => istanbulMondayKey(d) === thisMonday)

        const dailyStreak = currentDailyStreak(pastDates, now)
        const weeklyStreak = currentWeeklyStreak(pastDates, now)

        // Günlük seri önceliği (daha acil): 2+ gün ve bugün henüz gitmemiş
        const wantDaily = dailyStreak >= 2 && !wentToday
        const wantWeekly = !wantDaily && weeklyStreak >= 2 && !wentThisWeek
        if (!wantDaily && !wantWeekly) continue

        // Atomik sahiplen: guard penceresinde başka çalışma göndermediyse lastStreakNudgeAt'i
        // GÖNDERMEDEN önce ilerlet → sadece sahiplenen çalışma gönderir (çoklu instance / eşzamanlı
        // tetiklemede aynı kullanıcıya çift streak bildirimi gitmez). count===0 ise başka çalışma aldı.
        const claim = await prisma.user.updateMany({
          where: { id: userId, OR: [{ lastStreakNudgeAt: null }, { lastStreakNudgeAt: { lte: guardWindow } }] },
          data: { lastStreakNudgeAt: now },
        })
        if (claim.count === 0) continue

        const sLoc = (user.locale || 'tr') as Locale
        if (wantDaily) {
          await sendStreakNudgeEmail(user.email, user.fullName, 'daily', dailyStreak, sLoc)
          const p = notifyPush(sLoc, 'streak_daily', { days: dailyStreak, nextDays: dailyStreak + 1 })
          if (user.pushToken && p) sendPushNotification(user.pushToken, p.title, p.body).catch(() => {})
        } else {
          await sendStreakNudgeEmail(user.email, user.fullName, 'weekly', weeklyStreak, sLoc)
          const p = notifyPush(sLoc, 'streak_weekly', { weeks: weeklyStreak, nextWeeks: weeklyStreak + 1 })
          if (user.pushToken && p) sendPushNotification(user.pushToken, p.title, p.body).catch(() => {})
        }
      } catch (uErr) {
        console.error('Streak nudge (user) error:', userId, uErr)
      }
    }
  } catch (err) {
    console.error('Streak nudge job error:', err)
  }
}
