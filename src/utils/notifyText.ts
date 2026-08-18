import { Locale, DEFAULT_LOCALE } from './locale'

// ─────────────────────────────────────────────────────────────────────────────
// BİLDİRİM METİN KATALOĞU (uygulama-içi + push) — TEK DOĞRULUK KAYNAĞI.
//
// Uygulama-içi bildirimler DB'ye METİN olarak DEĞİL, `messageKey` + `messageParams` olarak yazılır;
// çeviri istemcide yapılır → kullanıcı dilini değiştirince GEÇMİŞ bildirimler de çevrilir.
// Buradaki anahtarlar web (`fitpass-web/src/lib/i18n.tsx`) ve mobil (`fitpass-mobile/src/lib/i18n.tsx`)
// sözlüklerinde `notif.<key>` olarak AYNEN bulunmalı — biri eklenip diğeri unutulursa istemci ham
// anahtarı gösterir. (smoke: "Bildirim: katalog anahtarları web+mobil ile eşleşiyor" testi bunu kilitler.)
//
// Push bildirimleri gönderim ANINDA burada render edilir (push metni saklanmaz, sonradan çevrilemez)
// → kullanıcının `User.locale` değeri kullanılır.
// ─────────────────────────────────────────────────────────────────────────────

type Pair = { tr: string; en: string }
type Entry = {
  body?: Pair       // uygulama-içi bildirim metni
  pushTitle?: Pair  // push başlığı
  pushBody?: Pair   // push gövdesi (yoksa body kullanılır)
}

export const NOTIFY: Record<string, Entry> = {
  // ── Sosyal ────────────────────────────────────────────────────────────────
  follow: {
    body: { tr: '@{username} seni takip etmeye başladı', en: '@{username} started following you' },
    pushTitle: { tr: 'Yeni takipçi 👋', en: 'New follower 👋' },
  },
  follow_request: {
    body: { tr: '@{username} seni takip etmek istiyor', en: '@{username} wants to follow you' },
    pushTitle: { tr: 'Yeni takip isteği', en: 'New follow request' },
  },
  follow_accept: {
    body: { tr: '@{username} takip isteğini kabul etti', en: '@{username} accepted your follow request' },
    pushTitle: { tr: 'Takip isteğin kabul edildi 🎉', en: 'Your follow request was accepted 🎉' },
  },
  like: {
    body: { tr: '{name} aktiviteni beğendi.', en: '{name} liked your activity.' },
    pushTitle: { tr: 'Yeni beğeni ❤️', en: 'New like ❤️' },
  },
  comment: {
    body: { tr: '{name} aktivitene yorum yaptı: "{excerpt}"', en: '{name} commented on your activity: "{excerpt}"' },
    pushTitle: { tr: 'Yeni yorum 💬', en: 'New comment 💬' },
    pushBody: { tr: '{name} aktivitene yorum yaptı.', en: '{name} commented on your activity.' },
  },
  comment_reply: {
    body: { tr: '{name} yorumuna cevap verdi: "{excerpt}"', en: '{name} replied to your comment: "{excerpt}"' },
    pushTitle: { tr: 'Yeni cevap 💬', en: 'New reply 💬' },
    pushBody: { tr: '{name} yorumuna cevap verdi.', en: '{name} replied to your comment.' },
  },
  group_invite: {
    body: { tr: '{name} sizi {category} sporuna davet etti.', en: '{name} invited you to {category}.' },
    pushTitle: { tr: 'Yeni davet! 🎉', en: 'New invite! 🎉' },
  },

  // ── Rezervasyon / seans ───────────────────────────────────────────────────
  booking_cancelled_self: {
    pushTitle: { tr: 'Rezervasyon iptal edildi', en: 'Booking cancelled' },
    pushBody: {
      tr: '{classTitle} · {date} {time} iptal edildi. {refund} iade uygulandı.',
      en: '{classTitle} · {date} {time} has been cancelled. {refund} refund applied.',
    },
  },
  booking_cancelled_class_removed: {
    body: {
      tr: '{classTitle} dersi salon tarafından kaldırıldı. Ödemen iade edilecektir.',
      en: '{classTitle} was removed by the venue. Your payment will be refunded.',
    },
    pushTitle: { tr: 'Rezervasyonun iptal edildi', en: 'Your booking was cancelled' },
  },
  booking_cancelled_venue_closed: {
    body: {
      tr: '{venue} kapatıldığı için ilgili rezervasyon(lar)ınız iptal edildi. Ödemeniz iade edilecektir.',
      en: '{venue} has closed, so your booking(s) were cancelled. Your payment will be refunded.',
    },
    pushTitle: { tr: 'Rezervasyonun iptal edildi', en: 'Your booking was cancelled' },
  },
  // SALON GECICI OLARAK KAPANDI (askiya alma / onay geri alma). Rezervasyon IPTAL EDILMEZ —
  // bu yuzden `booking_cancelled_venue_closed`tan AYRI bir metin. Onceden hicbir bildirim
  // gitmiyordu: kullanicinin rezervasyonu "onaylı" gorunmeye devam ediyor ama check-in kapali
  // (venueApprovedMiddleware 403) — yani kisi derse gidip kapida ogreniyordu.
  venue_suspended: {
    body: {
      tr: '{venue} geçici olarak kapandı. Rezervasyonların duruyor ama salon yeniden açılana kadar giriş yapılamıyor. İptal edersen tam iade alırsın.',
      en: '{venue} is temporarily closed. Your bookings remain, but check-in is unavailable until it reopens. Cancel any time for a full refund.',
    },
    pushTitle: { tr: 'Salon geçici olarak kapandı', en: 'Venue temporarily closed' },
  },
  venue_reopened: {
    body: {
      tr: '{venue} yeniden açıldı. Rezervasyonların geçerli, derse gidebilirsin.',
      en: '{venue} has reopened. Your bookings are valid — see you in class.',
    },
    pushTitle: { tr: 'Salon yeniden açıldı', en: 'Venue reopened' },
  },
  booking_transferred: {
    pushTitle: { tr: 'Dersin değiştirildi 🔄', en: 'Your class was changed 🔄' },
    pushBody: { tr: '{classTitle} · {date} {time}.{refund}', en: '{classTitle} · {date} {time}.{refund}' },
  },
  session_rescheduled: {
    // İADE HAKKI METNE YAZILIR: saati salon değiştirdiği için kullanıcı, normal iptal
    // penceresinden (12 saat kala iptal yok, 12-24 saat yarım iade) MUAF olarak tam iade
    // ile iptal edebilir (cancelBooking: rescheduledAt). Hakkı bilmeyen kullanamaz.
    body: {
      tr: '"{classTitle}" dersinin saati değişti: yeni tarih {date} {time}. Yeni saat sana uymuyorsa ders başlayana kadar ÜCRETSİZ iptal edebilirsin (tam iade).',
      en: '"{classTitle}" has been rescheduled: new date {date} {time}. If the new time does not work for you, you can cancel FREE of charge until the class starts (full refund).',
    },
    pushTitle: { tr: 'Ders saati değişti', en: 'Class time changed' },
  },
  waitlist_open: {
    body: {
      tr: '{classTitle} ({date} {time}) dersinde yer açıldı, hemen kaydol!',
      en: 'A spot just opened in {classTitle} ({date} {time}) — book it now!',
    },
    pushTitle: { tr: 'Yer açıldı! 🎉', en: 'A spot opened up! 🎉' },
  },
  class_reminder: {
    pushTitle: { tr: 'Dersine 2 saat kaldı! ⏰', en: 'Your class starts in 2 hours! ⏰' },
    pushBody: {
      tr: '{classTitle} dersi {date} {time}\'de {venue} adresinde başlıyor.',
      en: '{classTitle} starts {date} at {time}, at {venue}.',
    },
  },
  rating_prompt: {
    body: { tr: '{classTitle} dersin nasıldı? Salonu ve hocanı puanla ⭐', en: 'How was your {classTitle} class? Rate the venue and instructor ⭐' },
    pushTitle: { tr: 'Dersini puanla ⭐', en: 'Rate your class ⭐' },
  },

  // ── Oyunlaştırma ──────────────────────────────────────────────────────────
  points_earned: {
    pushTitle: { tr: 'Puan kazandın! 🎉', en: 'You earned points! 🎉' },
    pushBody: {
      tr: '{classTitle} dersine katıldın, {points} puan kazandın.',
      en: 'You attended {classTitle} and earned {points} points.',
    },
  },
  badge_one: {
    body: { tr: '"{badge}" rozetini kazandın! 🎉', en: 'You earned the "{badge}" badge! 🎉' },
    pushTitle: { tr: 'Yeni rozet! 🏅', en: 'New badge! 🏅' },
  },
  badge_many: {
    body: { tr: '{count} yeni rozet kazandın! 🎉', en: 'You earned {count} new badges! 🎉' },
    // ÇOĞUL: gövde "{count} new badges" derken başlık tekil "New badge" kalıyordu (EN sayı uyumsuzluğu).
    pushTitle: { tr: 'Yeni rozetler! 🏅', en: 'New badges! 🏅' },
  },
  season_champion: {
    body: { tr: '{season} sezonunda {count} şampiyonluk rozeti kazandın! 🏆', en: 'You earned {count} champion badges in the {season} season! 🏆' },
    pushTitle: { tr: 'Sezon şampiyonu! 🏆', en: 'Season champion! 🏆' },
  },
  streak_daily: {
    pushTitle: { tr: '🔥 {days} günlük serini bozma!', en: '🔥 Don\'t break your {days}-day streak!' },
    pushBody: {
      tr: 'Bugün de bir derse katıl, serini {nextDays} güne çıkar!',
      en: 'Join a class today and push your streak to {nextDays} days!',
    },
  },
  streak_weekly: {
    pushTitle: { tr: '🔥 {weeks} haftalık serini sürdür!', en: '🔥 Keep your {weeks}-week streak alive!' },
    pushBody: {
      tr: 'Bu hafta da bir derse katıl, serini {nextWeeks} haftaya taşı!',
      en: 'Join a class this week and take your streak to {nextWeeks} weeks!',
    },
  },

  // ── Parça/etiket metinleri (başka metinlerin içine gömülür) ───────────────
  refund_full: { body: { tr: 'Tam', en: 'Full' } },
  refund_half: { body: { tr: 'Yarım', en: 'Partial' } },
  // "kredi" TERİMİ KULLANILMAZ: cashback/kredi sistemi puan sistemine çevrildiğinde (ürün kararı)
  // arayüzden kaldırıldı ama bu metinde artık olarak kalmıştı. Bu bir PARA iadesidir (priceRefund),
  // puan değil → nötr "iade edildi" doğru ifade.
  refund_note: { body: { tr: ' ₺{refund} iade edildi.', en: ' ₺{refund} refunded.' } },
  reminder_today: { body: { tr: 'bugün', en: 'today' } },
  anonymous_user: { body: { tr: 'Bir kullanıcı', en: 'Someone' } },
  class_fallback: { body: { tr: 'Ders', en: 'Class' } },
}

export type NotifyKey = keyof typeof NOTIFY
export type NotifyParams = Record<string, string | number>

// {yerTutucu} doldurma. Karşılığı verilmeyen yer tutucu OLDUĞU GİBİ bırakılır (sessizce "undefined"
// yazmaktansa hatayı görünür kılar). Değerler istemcide React/RN tarafından metin olarak render
// edilir (HTML enjeksiyonu yok); push tarafı da düz metindir.
export function interpolate(tpl: string, params?: NotifyParams): string {
  if (!params) return tpl
  return tpl.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m))
}

function pick(p: Pair | undefined, locale: Locale): string | undefined {
  if (!p) return undefined
  return locale === 'en' ? p.en : p.tr
}

// Uygulama-içi bildirim metni. DB'deki `message` alanına FALLBACK olarak da yazılır (eski istemciler
// ve messageKey'i olmayan satırlar için) — asıl gösterim istemcide anahtar+parametreden yapılır.
export function notifyBody(locale: Locale, key: NotifyKey, params?: NotifyParams): string {
  const e = NOTIFY[key]
  const s = pick(e?.body, locale) ?? pick(e?.pushBody, locale)
  return s ? interpolate(s, params) : String(key)
}

// Push başlığı+gövdesi. Gövde yoksa uygulama-içi metne düşer. Başlık yoksa null → çağıran push atmaz.
export function notifyPush(locale: Locale, key: NotifyKey, params?: NotifyParams): { title: string; body: string } | null {
  const e = NOTIFY[key]
  const title = pick(e?.pushTitle, locale)
  if (!title) return null
  const body = pick(e?.pushBody, locale) ?? pick(e?.body, locale) ?? ''
  return { title: interpolate(title, params), body: interpolate(body, params) }
}

// Kısa yardımcı: parça/etiket metinleri (refund_full, anonymous_user, ...) için.
export function notifyText(locale: Locale, key: NotifyKey, params?: NotifyParams): string {
  return notifyBody(locale, key, params)
}

// Bildirim yazarken kullanılacak standart alan seti: hem yeni (anahtar+parametre) hem geriye dönük
// (düz metin) alanları birlikte üretir → tek çağrıda tutarlı Notification.create verisi.
export function notifyFields(locale: Locale, key: NotifyKey, params?: NotifyParams) {
  return {
    messageKey: String(key),
    messageParams: (params ?? {}) as any,
    message: notifyBody(locale, key, params), // fallback (eski istemci / anahtarsız satır)
  }
}

export const DEFAULT_NOTIFY_LOCALE = DEFAULT_LOCALE
