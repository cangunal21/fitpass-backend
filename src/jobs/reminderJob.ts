import prisma from '../utils/prisma'
import { sendReminderEmail } from '../utils/email'
import { sendPushNotification } from '../utils/push'
import { trDate, trDateShort, trTime, trYmd } from "../utils/trFormat"
import { notifyPush, notifyText } from '../utils/notifyText'
import { Locale } from '../utils/locale' 

export const sendRemindersJob = async () => {
  try {
    const now = new Date()
    // Pencere (60dk) job periyodundan (30dk) GENİŞ olmalı: eşit olsaydı ardışık taramalar hiç örtüşmez,
    // aralarındaki en ufak gecikmeye denk gelen rezervasyon hatırlatma ALMADAN pencereden çıkardı.
    // 2x örtüşme sayesinde kaçan/geciken bir çalışma bir sonrakinde kendini onarır; çift gönderimi
    // `reminderSent` atomik sahiplenmesi zaten engelliyor.
    const from = new Date(now.getTime() + 90 * 60 * 1000)  // +1s30dk
    const to = new Date(now.getTime() + 150 * 60 * 1000)   // +2s30dk

    const bookings = await prisma.booking.findMany({
      where: {
        status: 'confirmed',
        reminderSent: false,
        user: { banned: false }, // banlı kullanıcıya hatırlatma push/mail gitmesin
        session: { startsAt: { gte: from, lte: to } }
      },
      include: {
        user: { select: { email: true, fullName: true, emailReminders: true, pushToken: true, locale: true } },
        session: {
          include: {
            class: { include: { venue: { select: { name: true } } } }
          }
        }
      }
    })

    let sent = 0
    for (const booking of bookings) {
      try {
        // Atomik sahiplen: reminderSent'i false→true çevirebilen TEK çalışma gönderir.
        // (Çoklu instance ya da dahili job + HTTP cron aynı anda çalışırsa aynı booking'e
        // 2 mail/push gitmesin — findMany ile update arasındaki yarış penceresini kapatır.)
        const claim = await prisma.booking.updateMany({
          where: { id: booking.id, reminderSent: false },
          data: { reminderSent: true },
        })
        if (claim.count === 0) continue
        sent++

        const startsAt = new Date(booking.session!.startsAt)
        const date = trDate(startsAt)
        const time = trTime(startsAt)
        const venueName = booking.session!.class.venue?.name || ''
        const classTitle = booking.session!.class.title

        const rLoc = (booking.user?.locale || 'tr') as Locale
        if (booking.user?.email && booking.user.emailReminders !== false) {
          await sendReminderEmail(booking.user.email, booking.user.fullName, classTitle, date, time, venueName, rLoc)
          console.log(`✅ Hatırlatma maili gönderildi: booking#${booking.id}`) // PII loglamıyoruz (KVKK + Sentry'ye sızmasın)
        }

        // "bugün" SABİT yazılıydı: hatırlatma penceresi (+90..+150 dk) İstanbul gece yarısını
        // aştığında ders aslında ERTESİ gün oluyor (5 Ağu 22:30'da gönderilen push, 6 Ağu
        // 00:30 dersi için "bugün" diyordu) — üstelik aynı anda giden e-posta trDate ile doğru
        // tarihi yazıyor, kullanıcıya çelişkili iki tarih gidiyordu. Artık günü karşılaştırıyoruz.
        const dayLabel = trYmd(startsAt) === trYmd(new Date()) ? notifyText(rLoc, 'reminder_today') : trDateShort(startsAt)
        const rPush = notifyPush(rLoc, 'class_reminder', { classTitle, date: dayLabel, time, venue: venueName })
        if (booking.user?.pushToken && rPush) {
          await sendPushNotification(booking.user.pushToken, rPush.title, rPush.body)
          console.log(`📱 Push bildirimi gönderildi: user#${booking.userId}`) // PII loglamıyoruz
        }
        // reminderSent zaten yukarıda atomik sahiplenmede işaretlendi.
      } catch (e) {
        console.error(`Reminder error for booking ${booking.id}:`, e)
      }
    }

    if (sent > 0) {
      console.log(`📧 ${sent} hatırlatma gönderildi.`)
    }
    return sent
  } catch (err) {
    console.error('Reminder job error:', err)
    return 0
  }
}
