import { Resend } from 'resend'
import { Locale } from './locale'

let _resend: Resend | null = null
const resend = {
  emails: {
    send: async (opts: any) => {
      if (!process.env.RESEND_API_KEY) {
        console.log('[email skip] RESEND_API_KEY yok:', opts.subject)
        return
      }
      if (!_resend) _resend = new Resend(process.env.RESEND_API_KEY)
      // TIMEOUT: createBooking gibi uclar rezervasyon isteginin ICINDE 3-4 Resend cagrisini SIRAYLA
      // await ediyor. Timeout olmadan yavaslayan Resend, kullanicinin rezervasyon istegini (ve DB
      // baglantisini) dakikalarca acik tutabiliyordu. push.ts'teki 8sn kalibinin aynisi.
      // Resend SDK API hatalarını FIRLATMAZ; `{ data: null, error }` döndürür. Dönüş değeri hiç
      // incelenmediği için her Resend-tarafı hata (geçersiz alıcı, kota, domain doğrulanmamış, 5xx)
      // GÖRÜNMEZDİ: log temiz, çağıran taraf "gönderildi" sanıyordu. Artık en azından loglanıyor.
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 8000)
      let res: any
      try {
        res = await Promise.race([
          _resend.emails.send(opts),
          new Promise((_, rej) => ctrl.signal.addEventListener('abort', () => rej(new Error('resend timeout (8s)')))),
        ])
      } catch (e: any) {
        console.error('[email FAIL]', opts.subject, '→', e?.message || e)
        return { data: null, error: { message: String(e?.message || e) } }
      } finally {
        clearTimeout(timer)
      }
      if (res?.error) {
        console.error('[email FAIL]', opts.subject, '→', res.error?.name || res.error?.message || res.error)
        return res
      }
      return res
    }
  }
}

const FROM_EMAIL = 'Şipşakspor <noreply@sipsakspor.com>'
const BRAND_COLOR = '#4F46E5'
const SITE_URL = 'https://sipsakspor.com'

// ÇOKLU DİL: kullanıcıya giden e-postalar alıcının `User.locale` diliyle üretilir. Her şablon kendi
// metin bloğunu İÇİNDE taşır (tek dev sözlük yerine) → şablon okunurken çevirisi de gözle görülür,
// biri değişince diğeri unutulmaz.
// KAPSAM (ürün kararı): yalnız KULLANICI e-postaları çok dilli. Salon/eğitmen/admin e-postaları
// Türkçe kalır — hedef kitle İstanbul'daki Türk işletmeler ve Venue/Instructor'da locale alanı yok.
const tt = <T extends Record<string, string>>(locale: Locale, d: { tr: T; en: T }): T => (locale === 'en' ? d.en : d.tr)
// Şablon içi başlık/etiket sözlüğü kullanılırken varsayılan dil TR (çağıran locale vermezse davranış değişmez).
const L = (locale?: Locale): Locale => (locale === 'en' ? 'en' : 'tr')

const baseTemplate = (content: string, locale?: Locale) => `
  <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto; background: #F5F5F5; padding: 40px 20px;">
    <div style="background: #fff; border-radius: 24px; overflow: hidden; box-shadow: 0 4px 24px rgba(0,0,0,0.06);">
      <div style="background: linear-gradient(135deg, #4F46E5 0%, #6366F1 50%, #818CF8 100%); padding: 32px; text-align: center;">
        <h1 style="font-size: 26px; font-weight: 800; color: #fff; margin: 0; letter-spacing: -0.5px;">şipşakspor</h1>
        <p style="font-size: 13px; color: rgba(255,255,255,0.7); margin: 6px 0 0;">${L(locale) === 'en' ? "Istanbul's sports platform" : "İstanbul'un spor platformu"}</p>
      </div>
      <div style="padding: 36px 40px;">
        ${content}
      </div>
      <div style="padding: 20px 40px; border-top: 1px solid #F0F0F0; text-align: center;">
        <p style="font-size: 12px; color: #bbb; margin: 0;">© 2026 Şipşakspor · <a href="${SITE_URL}" style="color: #bbb;">sipsakspor.com</a></p>
      </div>
    </div>
  </div>
`

export const sendWelcomeEmail = async (to: string, fullName: string, locale?: Locale) => {
  const loc = L(locale)
  const T = tt(loc, {
    tr: {
      subject: 'Şipşakspor\'a Hoş Geldin!',
      greeting: `Merhaba ${esc(fullName)}! 👋`,
      body1: "Şipşakspor ailesine hoş geldin! Artık İstanbul'un en iyi spor derslerine tek platformdan erişebilirsin.",
      featuresTitle: 'Neler yapabilirsin?',
      item1: 'Yoga, Pilates, Boks ve daha fazlasına katıl',
      item2: 'Halı saha, basketbol, padel maçlarına kaydol',
      item3: 'Arkadaşlarınla birlikte antrenman yap',
      item4: 'Tier sistemiyle indirimler kazan',
      cta: 'Ders Bulmaya Başla →',
    },
    en: {
      subject: 'Welcome to Şipşakspor!',
      greeting: `Hi ${esc(fullName)}! 👋`,
      // NOT: İngilizce metinde exonim "Istanbul" (noktalı İ değil) — bazı e-posta istemcilerinde bozuk görünür.
      body1: "Welcome to the Şipşakspor family! You can now reach Istanbul's best classes from a single platform.",
      featuresTitle: 'What can you do?',
      item1: 'Join Yoga, Pilates, Boxing and more',
      item2: 'Sign up for football, basketball and padel matches',
      item3: 'Train together with your friends',
      item4: 'Earn discounts with the tier system',
      cta: 'Start Finding Classes →',
    },
  })
  await resend.emails.send({
    from: FROM_EMAIL,
    to,
    subject: T.subject,
    html: baseTemplate(`
      <h2 style="font-size: 22px; font-weight: 800; color: #111; margin: 0 0 8px;">${T.greeting}</h2>
      <p style="font-size: 15px; color: #555; line-height: 1.7; margin: 0 0 24px;">
        ${T.body1}
      </p>
      <div style="background: #EEF2FF; border-radius: 16px; padding: 20px; margin-bottom: 28px;">
        <p style="font-size: 14px; color: ${BRAND_COLOR}; font-weight: 700; margin: 0 0 10px;">${T.featuresTitle}</p>
        <ul style="font-size: 14px; color: #555; line-height: 2; margin: 0; padding-left: 20px;">
          <li>${T.item1}</li>
          <li>${T.item2}</li>
          <li>${T.item3}</li>
          <li>${T.item4}</li>
        </ul>
      </div>
      <div style="text-align: center;">
        <a href="${SITE_URL}" style="display: inline-block; padding: 14px 32px; background: ${BRAND_COLOR}; color: #fff; border-radius: 14px; text-decoration: none; font-size: 15px; font-weight: 700;">${T.cta}</a>
      </div>
    `, loc),
  })
}

export const sendPasswordResetEmail = async (to: string, fullName: string, resetToken: string, locale?: Locale) => {
  const resetUrl = `${SITE_URL}/sifre-sifirla?token=${resetToken}`
  const loc = L(locale)
  const T = tt(loc, {
    tr: {
      subject: 'Şipşakspor — Şifre Sıfırlama',
      heading: 'Şifre Sıfırlama',
      body1: `Merhaba ${esc(fullName)}, şifre sıfırlama talebinde bulundun. Aşağıdaki butona tıklayarak yeni şifreni belirleyebilirsin.`,
      cta: 'Şifremi Sıfırla →',
      warning: '⚠️ Bu link 1 saat geçerlidir. Eğer bu talebi sen yapmadıysan bu emaili görmezden gelebilirsin.',
    },
    en: {
      subject: 'Şipşakspor — Password Reset',
      heading: 'Password Reset',
      body1: `Hi ${esc(fullName)}, you requested a password reset. Tap the button below to set your new password.`,
      cta: 'Reset My Password →',
      warning: "⚠️ This link is valid for 1 hour. If you didn't request this, you can safely ignore this email.",
    },
  })
  await resend.emails.send({
    from: FROM_EMAIL,
    to,
    subject: T.subject,
    html: baseTemplate(`
      <h2 style="font-size: 22px; font-weight: 800; color: #111; margin: 0 0 8px;">${T.heading}</h2>
      <p style="font-size: 15px; color: #555; line-height: 1.7; margin: 0 0 24px;">
        ${T.body1}
      </p>
      <div style="text-align: center; margin-bottom: 24px;">
        <a href="${resetUrl}" style="display: inline-block; padding: 14px 32px; background: ${BRAND_COLOR}; color: #fff; border-radius: 14px; text-decoration: none; font-size: 15px; font-weight: 700;">${T.cta}</a>
      </div>
      <div style="background: #FEF2F2; border-radius: 12px; padding: 14px;">
        <p style="font-size: 13px; color: #DC2626; margin: 0;">${T.warning}</p>
      </div>
    `, loc),
  })
}

export const sendVenuePasswordResetEmail = async (to: string, venueName: string, resetToken: string) => {
  const resetUrl = `${SITE_URL}/salon-sifre-sifirla?token=${resetToken}`

  await resend.emails.send({
    from: FROM_EMAIL,
    to,
    subject: 'Şipşakspor Salon Paneli — Şifre Sıfırlama',
    html: baseTemplate(`
      <h2 style="font-size: 22px; font-weight: 800; color: #111; margin: 0 0 8px;">Salon Şifresi Sıfırlama</h2>
      <p style="font-size: 15px; color: #555; line-height: 1.7; margin: 0 0 24px;">
        Merhaba <strong>${esc(venueName)}</strong>, salon paneliniz için şifre sıfırlama talebinde bulunuldu. Aşağıdaki butona tıklayarak yeni şifrenizi belirleyebilirsiniz.
      </p>
      <div style="text-align: center; margin-bottom: 24px;">
        <a href="${resetUrl}" style="display: inline-block; padding: 14px 32px; background: ${BRAND_COLOR}; color: #fff; border-radius: 14px; text-decoration: none; font-size: 15px; font-weight: 700;">Şifremi Sıfırla →</a>
      </div>
      <div style="background: #FEF2F2; border-radius: 12px; padding: 14px;">
        <p style="font-size: 13px; color: #DC2626; margin: 0;">⚠️ Bu link 1 saat geçerlidir. Eğer bu talebi siz yapmadıysanız bu emaili görmezden gelebilirsiniz.</p>
      </div>
    `),
  })
}

// Eğitmen daveti: salon sahibi eğitmene giriş verince → şifre belirleme linki
export const sendInstructorInviteEmail = async (to: string, instructorName: string, venueName: string, token: string) => {
  const url = `${SITE_URL}/egitmen-sifre-belirle?token=${token}`
  await resend.emails.send({
    from: FROM_EMAIL,
    to,
    subject: 'Şipşakspor — Eğitmen Girişi Daveti',
    html: baseTemplate(`
      <h2 style="font-size: 22px; font-weight: 800; color: #111; margin: 0 0 8px;">Eğitmen Girişin Hazır 🎉</h2>
      <p style="font-size: 15px; color: #555; line-height: 1.7; margin: 0 0 24px;">
        Merhaba <strong>${esc(instructorName)}</strong>, <strong>${esc(venueName)}</strong> seni Şipşakspor'da eğitmen olarak ekledi. Aşağıdaki butonla şifreni belirleyip kendi puan ve yorumlarını görüp yanıtlayabilirsin.
      </p>
      <div style="text-align: center; margin-bottom: 24px;">
        <a href="${url}" style="display: inline-block; padding: 14px 32px; background: ${BRAND_COLOR}; color: #fff; border-radius: 14px; text-decoration: none; font-size: 15px; font-weight: 700;">Şifremi Belirle →</a>
      </div>
      <div style="background: #EEF2FF; border-radius: 12px; padding: 14px;">
        <p style="font-size: 13px; color: #4F46E5; margin: 0;">Bu link 1 saat geçerlidir. Şifreni belirledikten sonra sipsakspor.com'daki "Eğitmen Girişi"nden giriş yapabilirsin.</p>
      </div>
    `),
  })
}

// Eğitmen şifre sıfırlama (davet ile aynı "şifre belirle" sayfasına gider)
export const sendInstructorPasswordResetEmail = async (to: string, instructorName: string, token: string) => {
  const url = `${SITE_URL}/egitmen-sifre-belirle?token=${token}`
  await resend.emails.send({
    from: FROM_EMAIL,
    to,
    subject: 'Şipşakspor Eğitmen — Şifre Sıfırlama',
    html: baseTemplate(`
      <h2 style="font-size: 22px; font-weight: 800; color: #111; margin: 0 0 8px;">Eğitmen Şifresi Sıfırlama</h2>
      <p style="font-size: 15px; color: #555; line-height: 1.7; margin: 0 0 24px;">
        Merhaba <strong>${esc(instructorName)}</strong>, eğitmen girişin için şifre sıfırlama talebinde bulunuldu. Aşağıdaki butonla yeni şifreni belirleyebilirsin.
      </p>
      <div style="text-align: center; margin-bottom: 24px;">
        <a href="${url}" style="display: inline-block; padding: 14px 32px; background: ${BRAND_COLOR}; color: #fff; border-radius: 14px; text-decoration: none; font-size: 15px; font-weight: 700;">Şifremi Sıfırla →</a>
      </div>
      <div style="background: #FEF2F2; border-radius: 12px; padding: 14px;">
        <p style="font-size: 13px; color: #DC2626; margin: 0;">⚠️ Bu link 1 saat geçerlidir. Eğer bu talebi siz yapmadıysanız bu emaili görmezden gelebilirsiniz.</p>
      </div>
    `),
  })
}

export const sendBookingConfirmationEmail = async (
  to: string,
  fullName: string,
  classTitle: string,
  date: string,
  time: string,
  price: number,
  locale?: Locale
) => {
  const loc = L(locale)
  const T = tt(loc, {
    tr: { heading: 'Rezervasyon Onaylandı!', body1: `Merhaba ${esc(fullName)}, rezervasyonun başarıyla oluşturuldu!`,
          lblDate: 'Tarih', lblTime: 'Saat', lblPrice: 'Ücret',
          note: '🔒 İptal: 24 saatten önce tam iade · 12-24 saat arası yarım iade · son 12 saatte iptal yok.', cta: 'Rezervasyonlarımı Gör →' },
    en: { heading: 'Booking Confirmed!', body1: `Hi ${esc(fullName)}, your booking is all set!`,
          lblDate: 'Date', lblTime: 'Time', lblPrice: 'Price',
          note: '🔒 Cancellation: full refund 24h+ before · half refund 12-24h · no cancellation in the last 12h.', cta: 'View My Bookings →' },
  })
  await resend.emails.send({
    from: FROM_EMAIL,
    to,
    subject: loc === 'en' ? `Booking Confirmed: ${classTitle}` : `Rezervasyon Onaylandı: ${classTitle}`,
    html: baseTemplate(`
      <div style="text-align: center; margin-bottom: 28px;">
        <div style="width: 64px; height: 64px; background: #EEF2FF; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; margin-bottom: 16px;">
          <span style="font-size: 32px;">🎉</span>
        </div>
        <h2 style="font-size: 22px; font-weight: 800; color: #111; margin: 0;">${T.heading}</h2>
      </div>
      <p style="font-size: 15px; color: #555; line-height: 1.7; margin: 0 0 24px;">
        ${T.body1}
      </p>
      <div style="background: #FAFAFA; border-radius: 16px; padding: 20px; margin-bottom: 24px; border: 1px solid #F0F0F0;">
        <p style="font-size: 17px; font-weight: 700; color: #111; margin: 0 0 16px;">${esc(classTitle)}</p>
        <div style="display: flex; gap: 24px;">
          <div>
            <p style="font-size: 11px; color: #aaa; font-weight: 600; text-transform: uppercase; margin: 0 0 4px;">${T.lblDate}</p>
            <p style="font-size: 14px; font-weight: 600; color: #111; margin: 0;">${date}</p>
          </div>
          <div>
            <p style="font-size: 11px; color: #aaa; font-weight: 600; text-transform: uppercase; margin: 0 0 4px;">${T.lblTime}</p>
            <p style="font-size: 14px; font-weight: 600; color: #111; margin: 0;">${time}</p>
          </div>
          <div>
            <p style="font-size: 11px; color: #aaa; font-weight: 600; text-transform: uppercase; margin: 0 0 4px;">${T.lblPrice}</p>
            <p style="font-size: 14px; font-weight: 700; color: ${BRAND_COLOR}; margin: 0;">₺${price}</p>
          </div>
        </div>
      </div>
      <div style="background: #FFF7ED; border-radius: 12px; padding: 14px; margin-bottom: 24px;">
        <p style="font-size: 13px; color: #92400E; margin: 0;">${T.note}</p>
      </div>
      <div style="text-align: center;">
        <a href="${SITE_URL}/profil" style="display: inline-block; padding: 12px 28px; background: ${BRAND_COLOR}; color: #fff; border-radius: 12px; text-decoration: none; font-size: 14px; font-weight: 700;">${T.cta}</a>
      </div>
    `, loc),
  })
}

export const sendCancellationEmail = async (
  to: string,
  fullName: string,
  classTitle: string,
  date: string,
  time: string,
  locale?: Locale,
) => {
  const loc = L(locale)
  const T = tt(loc, {
    tr: { heading: 'Rezervasyon İptal Edildi', body1: `Merhaba ${esc(fullName)}, aşağıdaki rezervasyonun iptal edildi.`,
          lblDate: 'Tarih', lblTime: 'Saat', note: 'Başka bir derse katılmak için platformumuzu ziyaret edebilirsin.', cta: 'Ders Bul →' },
    en: { heading: 'Booking Cancelled', body1: `Hi ${esc(fullName)}, the booking below has been cancelled.`,
          lblDate: 'Date', lblTime: 'Time', note: 'Hop back on the platform anytime to join another class.', cta: 'Find a Class →' },
  })
  await resend.emails.send({
    from: FROM_EMAIL,
    to,
    subject: loc === 'en' ? `Booking Cancelled: ${classTitle}` : `Rezervasyon İptal Edildi: ${classTitle}`,
    html: baseTemplate(`
      <div style="text-align: center; margin-bottom: 28px;">
        <div style="width: 64px; height: 64px; background: #FEF2F2; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; margin-bottom: 16px;">
          <span style="font-size: 32px;">❌</span>
        </div>
        <h2 style="font-size: 22px; font-weight: 800; color: #111; margin: 0;">${T.heading}</h2>
      </div>
      <p style="font-size: 15px; color: #555; line-height: 1.7; margin: 0 0 24px;">
        ${T.body1}
      </p>
      <div style="background: #FAFAFA; border-radius: 16px; padding: 20px; margin-bottom: 24px; border: 1px solid #F0F0F0;">
        <p style="font-size: 17px; font-weight: 700; color: #111; margin: 0 0 16px;">${esc(classTitle)}</p>
        <div style="display: flex; gap: 24px;">
          <div>
            <p style="font-size: 11px; color: #aaa; font-weight: 600; text-transform: uppercase; margin: 0 0 4px;">${T.lblDate}</p>
            <p style="font-size: 14px; font-weight: 600; color: #111; margin: 0;">${date}</p>
          </div>
          <div>
            <p style="font-size: 11px; color: #aaa; font-weight: 600; text-transform: uppercase; margin: 0 0 4px;">${T.lblTime}</p>
            <p style="font-size: 14px; font-weight: 600; color: #111; margin: 0;">${time}</p>
          </div>
        </div>
      </div>
      <div style="background: #EEF2FF; border-radius: 12px; padding: 14px; margin-bottom: 24px;">
        <p style="font-size: 13px; color: ${BRAND_COLOR}; margin: 0;">${T.note}</p>
      </div>
      <div style="text-align: center;">
        <a href="${SITE_URL}" style="display: inline-block; padding: 12px 28px; background: ${BRAND_COLOR}; color: #fff; border-radius: 12px; text-decoration: none; font-size: 14px; font-weight: 700;">${T.cta}</a>
      </div>
    `, loc),
  })
}

export const sendVenueCancellationEmail = async (
  to: string,
  venueName: string,
  customerName: string,
  classTitle: string,
  date: string,
  time: string,
) => {
  await resend.emails.send({
    from: FROM_EMAIL,
    to,
    subject: `Rezervasyon İptal: ${classTitle}`,
    html: baseTemplate(`
      <div style="text-align: center; margin-bottom: 28px;">
        <div style="width: 64px; height: 64px; background: #FEF2F2; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; margin-bottom: 16px;">
          <span style="font-size: 32px;">📋</span>
        </div>
        <h2 style="font-size: 22px; font-weight: 800; color: #111; margin: 0;">Bir rezervasyon iptal edildi</h2>
      </div>
      <div style="background: #FAFAFA; border-radius: 16px; padding: 20px; margin-bottom: 24px; border: 1px solid #F0F0F0;">
        <p style="font-size: 17px; font-weight: 700; color: #111; margin: 0 0 16px;">${esc(classTitle)}</p>
        <div style="display: flex; gap: 24px; flex-wrap: wrap;">
          <div>
            <p style="font-size: 11px; color: #aaa; font-weight: 600; text-transform: uppercase; margin: 0 0 4px;">Müşteri</p>
            <p style="font-size: 14px; font-weight: 600; color: #111; margin: 0;">${esc(customerName)}</p>
          </div>
          <div>
            <p style="font-size: 11px; color: #aaa; font-weight: 600; text-transform: uppercase; margin: 0 0 4px;">Tarih</p>
            <p style="font-size: 14px; font-weight: 600; color: #111; margin: 0;">${date}</p>
          </div>
          <div>
            <p style="font-size: 11px; color: #aaa; font-weight: 600; text-transform: uppercase; margin: 0 0 4px;">Saat</p>
            <p style="font-size: 14px; font-weight: 600; color: #111; margin: 0;">${time}</p>
          </div>
        </div>
      </div>
      <div style="text-align: center;">
        <a href="${SITE_URL}/salon-paneli" style="display: inline-block; padding: 12px 28px; background: ${BRAND_COLOR}; color: #fff; border-radius: 12px; text-decoration: none; font-size: 14px; font-weight: 700;">Salon Paneline Git →</a>
      </div>
    `),
  })
}

export const sendVenueBookingNotificationEmail = async (
  to: string,
  venueName: string,
  customerName: string,
  classTitle: string,
  date: string,
  time: string,
  capacity: number,
  // Çağıran ZATEN yeni rezervasyonu içeren kalan yeri geçiyor (capacity - occupiedSpots,
  // occupiedSpots rezervasyon oluşturulduktan SONRA sayılıyor). Burada ayrıca "-1"
  // uygulanıyordu → salona giden e-posta kalan yeri hep BİR EKSİK yazıyordu.
  spotsLeft: number
) => {
  const spotsWarning = spotsLeft <= 3
    ? `<div style="background: #FEF2F2; border-radius: 12px; padding: 14px; margin-bottom: 24px;">
        <p style="font-size: 13px; color: #DC2626; margin: 0;">⚠️ Bu seans için yalnızca <strong>${spotsLeft} yer kaldı!</strong></p>
      </div>`
    : `<div style="background: #F0FDF4; border-radius: 12px; padding: 14px; margin-bottom: 24px;">
        <p style="font-size: 13px; color: #166534; margin: 0;">✅ Bu seans için <strong>${spotsLeft} yer kaldı.</strong></p>
      </div>`

  await resend.emails.send({
    from: FROM_EMAIL,
    to,
    subject: `Yeni Rezervasyon: ${classTitle}`,
    html: baseTemplate(`
      <div style="text-align: center; margin-bottom: 28px;">
        <div style="width: 64px; height: 64px; background: #EEF2FF; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; margin-bottom: 16px;">
          <span style="font-size: 32px;">🎯</span>
        </div>
        <h2 style="font-size: 22px; font-weight: 800; color: #111; margin: 0;">Yeni bir rezervasyon aldınız!</h2>
      </div>
      <div style="background: #FAFAFA; border-radius: 16px; padding: 20px; margin-bottom: 24px; border: 1px solid #F0F0F0;">
        <p style="font-size: 17px; font-weight: 700; color: #111; margin: 0 0 16px;">${esc(classTitle)}</p>
        <div style="display: flex; gap: 24px; flex-wrap: wrap;">
          <div>
            <p style="font-size: 11px; color: #aaa; font-weight: 600; text-transform: uppercase; margin: 0 0 4px;">Müşteri</p>
            <p style="font-size: 14px; font-weight: 600; color: #111; margin: 0;">${esc(customerName)}</p>
          </div>
          <div>
            <p style="font-size: 11px; color: #aaa; font-weight: 600; text-transform: uppercase; margin: 0 0 4px;">Tarih</p>
            <p style="font-size: 14px; font-weight: 600; color: #111; margin: 0;">${date}</p>
          </div>
          <div>
            <p style="font-size: 11px; color: #aaa; font-weight: 600; text-transform: uppercase; margin: 0 0 4px;">Saat</p>
            <p style="font-size: 14px; font-weight: 600; color: #111; margin: 0;">${time}</p>
          </div>
        </div>
      </div>
      ${spotsWarning}
      <div style="text-align: center;">
        <a href="${SITE_URL}/salon-paneli" style="display: inline-block; padding: 12px 28px; background: ${BRAND_COLOR}; color: #fff; border-radius: 12px; text-decoration: none; font-size: 14px; font-weight: 700;">Salon Paneline Git →</a>
      </div>
    `),
  })
}

export const sendVenueRegistrationAdminEmail = async (
  venueName: string,
  venueEmail: string,
  venuePhone: string,
  venueAddress: string,
  sportCategories: string[]
) => {
  const adminEmail = process.env.ADMIN_EMAIL || 'admin@sipsakspor.com'
  await resend.emails.send({
    from: FROM_EMAIL,
    to: adminEmail,
    subject: `Yeni Salon Başvurusu: ${venueName}`,
    html: baseTemplate(`
      <div style="text-align: center; margin-bottom: 28px;">
        <div style="width: 64px; height: 64px; background: #FEF2F2; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; margin-bottom: 16px;">
          <span style="font-size: 32px;">⚠️</span>
        </div>
        <h2 style="font-size: 22px; font-weight: 800; color: #111; margin: 0;">Onay Bekleyen Yeni Başvuru</h2>
        <p style="font-size: 14px; color: #DC2626; margin: 8px 0 0;">Yeni bir salon kayıt başvurusunda bulundu.</p>
      </div>
      <div style="background: #FEF2F2; border-radius: 16px; padding: 20px; margin-bottom: 24px; border: 1px solid #FECACA;">
        <p style="font-size: 16px; font-weight: 700; color: #111; margin: 0 0 16px;">${esc(venueName)}</p>
        <div style="display: flex; flex-direction: column; gap: 10px;">
          <div>
            <p style="font-size: 11px; color: #aaa; font-weight: 600; text-transform: uppercase; margin: 0 0 2px;">E-posta</p>
            <p style="font-size: 14px; color: #111; margin: 0;">${esc(venueEmail)}</p>
          </div>
          <div>
            <p style="font-size: 11px; color: #aaa; font-weight: 600; text-transform: uppercase; margin: 0 0 2px;">Telefon</p>
            <p style="font-size: 14px; color: #111; margin: 0;">${esc(venuePhone)}</p>
          </div>
          <div>
            <p style="font-size: 11px; color: #aaa; font-weight: 600; text-transform: uppercase; margin: 0 0 2px;">Adres</p>
            <p style="font-size: 14px; color: #111; margin: 0;">${esc(venueAddress)}</p>
          </div>
          <div>
            <p style="font-size: 11px; color: #aaa; font-weight: 600; text-transform: uppercase; margin: 0 0 2px;">Spor Kategorileri</p>
            <p style="font-size: 14px; color: #111; margin: 0;">${esc(sportCategories.join(', ')) || '—'}</p>
          </div>
        </div>
      </div>
      <div style="text-align: center;">
        <a href="${SITE_URL}/admin" style="display: inline-block; padding: 14px 32px; background: #DC2626; color: #fff; border-radius: 14px; text-decoration: none; font-size: 15px; font-weight: 700;">Admin Paneline Git →</a>
      </div>
    `),
  })
}

export const sendReminderEmail = async (to: string, fullName: string, classTitle: string, date: string, time: string, venueName: string, locale?: Locale) => {
  const loc = L(locale)
  const T = tt(loc, {
    tr: { subject: `⏰ Dersiniz 2 saat sonra başlıyor — ${classTitle}`, heading: 'Dersiniz yaklaşıyor! ⏰',
          body1: `Merhaba <strong>${esc(fullName)}</strong>, bugünkü dersinizi hatırlatmak istedik.`,
          note: 'Unutma: derse 12 saatten az kaldığında iptal yapılamaz.' },
    en: { subject: `⏰ Your class starts in 2 hours — ${classTitle}`, heading: 'Your class is coming up! ⏰',
          body1: `Hi <strong>${esc(fullName)}</strong>, just a quick reminder about your class today.`,
          note: "Heads up: you can't cancel within 12 hours of the class." },
  })
  await resend.emails.send({
    from: FROM_EMAIL,
    to,
    subject: T.subject,
    html: baseTemplate(`
      <h2 style="font-size:22px;font-weight:800;color:#1a1a1a;margin:0 0 8px;">${T.heading}</h2>
      <p style="color:#555;font-size:15px;margin:0 0 24px;">${T.body1}</p>
      <div style="background:#F5F3FF;border-radius:12px;padding:20px 24px;margin-bottom:24px;">
        <p style="margin:0 0 8px;font-size:16px;font-weight:700;color:#4F46E5;">${esc(classTitle)}</p>
        <p style="margin:0 0 4px;color:#555;font-size:14px;">📍 ${esc(venueName)}</p>
        <p style="margin:0;color:#555;font-size:14px;">🗓 ${date} · ⏰ ${time}</p>
      </div>
      <p style="color:#888;font-size:13px;">${T.note}</p>
    `, loc)
  })
}

export const sendWaitlistNotificationEmail = async (to: string, fullName: string, classTitle: string, date: string, time: string, locale?: Locale) => {
  const loc = L(locale)
  const T = tt(loc, {
    tr: { subject: `🎉 Yer açıldı! ${classTitle} dersine katılabilirsiniz`, heading: 'Yer açıldı! 🎉',
          body1: `Merhaba <strong>${esc(fullName)}</strong>, bekleme listesinde olduğunuz ders için yer açıldı!`,
          note: 'Hemen rezervasyon yap, yer dolmadan önce!', cta: 'Hemen Rezervasyon Yap' },
    en: { subject: `🎉 A spot opened up! You can join ${classTitle}`, heading: 'A spot opened up! 🎉',
          body1: `Hi <strong>${esc(fullName)}</strong>, a spot just opened up in the class you were waiting for!`,
          note: 'Book now, before the spot is gone!', cta: 'Book Now' },
  })
  await resend.emails.send({
    from: FROM_EMAIL,
    to,
    subject: T.subject,
    html: baseTemplate(`
      <h2 style="font-size:22px;font-weight:800;color:#1a1a1a;margin:0 0 8px;">${T.heading}</h2>
      <p style="color:#555;font-size:15px;margin:0 0 24px;">${T.body1}</p>
      <div style="background:#F0FDF4;border-radius:12px;padding:20px 24px;margin-bottom:24px;">
        <p style="margin:0 0 8px;font-size:16px;font-weight:700;color:#16a34a;">${esc(classTitle)}</p>
        <p style="margin:0;color:#555;font-size:14px;">🗓 ${date} · ⏰ ${time}</p>
      </div>
      <p style="color:#888;font-size:13px;">${T.note}</p>
      <a href="${process.env.SITE_URL || 'https://sipsakspor.com'}" style="display:inline-block;margin-top:16px;padding:14px 28px;background:#4F46E5;color:#fff;border-radius:12px;text-decoration:none;font-weight:700;font-size:15px;">${T.cta}</a>
    `, loc)
  })
}

// Kullanıcı kaynaklı metni HTML e-postaya gömmeden önce kaçışla (HTML enjeksiyonu/phishing önlemi)
const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
const escSubject = (s: unknown): string => String(s ?? '').replace(/[\r\n]+/g, ' ').slice(0, 200)

export const sendComplaintEmail = async (
  name: string,
  email: string,
  subject: string,
  message: string
) => {
  const adminEmail = process.env.ADMIN_EMAIL || 'admin@sipsakspor.com'
  await resend.emails.send({
    from: FROM_EMAIL,
    to: adminEmail,
    replyTo: email,
    subject: `[Şikayet] ${escSubject(subject)}`,
    html: baseTemplate(`
      <h2 style="font-size:20px;font-weight:800;color:#1a1a1a;margin:0 0 20px;">Yeni Şikayet / Geri Bildirim</h2>
      <div style="background:#F8F8F8;border-radius:12px;padding:20px 24px;margin-bottom:20px;">
        <p style="margin:0 0 8px;font-size:13px;color:#888;">Gönderen</p>
        <p style="margin:0;font-size:15px;font-weight:700;color:#1a1a1a;">${esc(name)} · <a href="mailto:${esc(email)}" style="color:#4F46E5;">${esc(email)}</a></p>
      </div>
      <div style="background:#F8F8F8;border-radius:12px;padding:20px 24px;margin-bottom:20px;">
        <p style="margin:0 0 8px;font-size:13px;color:#888;">Konu</p>
        <p style="margin:0;font-size:15px;font-weight:700;color:#1a1a1a;">${esc(subject)}</p>
      </div>
      <div style="background:#F8F8F8;border-radius:12px;padding:20px 24px;">
        <p style="margin:0 0 8px;font-size:13px;color:#888;">Mesaj</p>
        <p style="margin:0;font-size:15px;color:#333;line-height:1.7;white-space:pre-wrap;">${esc(message)}</p>
      </div>
      <p style="margin-top:20px;font-size:12px;color:#aaa;">Bu maile yanıt vererek kullanıcıya direkt ulaşabilirsiniz.</p>
    `)
  })
}

// Kullanıcı şikayeti → admin'e bildirim
export const sendReportNotificationEmail = async (
  reporterName: string,
  reporterUsername: string,
  reportedName: string,
  reportedUsername: string,
  reason: string | null,
) => {
  // Şikayetler her zaman sabit admin adresine gider
  const adminEmail = 'admin@sipsakspor.com'
  await resend.emails.send({
    from: FROM_EMAIL,
    to: adminEmail,
    subject: `[Şikayet] @${escSubject(reportedUsername)} kullanıcısı şikayet edildi`,
    html: baseTemplate(`
      <h2 style="font-size:20px;font-weight:800;color:#1a1a1a;margin:0 0 20px;">Yeni Kullanıcı Şikayeti</h2>
      <div style="background:#FEF2F2;border-radius:12px;padding:20px 24px;margin-bottom:16px;border:1px solid #FECACA;">
        <p style="margin:0 0 8px;font-size:13px;color:#888;">Şikayet edilen kullanıcı</p>
        <p style="margin:0;font-size:15px;font-weight:700;color:#1a1a1a;">${esc(reportedName)} · @${esc(reportedUsername)}</p>
      </div>
      <div style="background:#F8F8F8;border-radius:12px;padding:20px 24px;margin-bottom:16px;">
        <p style="margin:0 0 8px;font-size:13px;color:#888;">Şikayet eden</p>
        <p style="margin:0;font-size:15px;font-weight:700;color:#1a1a1a;">${esc(reporterName)} · @${esc(reporterUsername)}</p>
      </div>
      <div style="background:#F8F8F8;border-radius:12px;padding:20px 24px;">
        <p style="margin:0 0 8px;font-size:13px;color:#888;">Sebep</p>
        <p style="margin:0;font-size:15px;color:#333;line-height:1.7;white-space:pre-wrap;">${esc(reason || 'Belirtilmedi')}</p>
      </div>
      <div style="text-align:center;margin-top:24px;">
        <a href="${SITE_URL}/admin" style="display:inline-block;padding:12px 28px;background:${BRAND_COLOR};color:#fff;border-radius:12px;text-decoration:none;font-size:14px;font-weight:700;">Admin Panelinde İncele →</a>
      </div>
    `)
  })
}

// Cashback kazanıldı → kullanıcıya bilgilendirme
export const sendCashbackEmail = async (
  to: string,
  fullName: string,
  amount: number,
  classTitle: string,
  newBalance: number,
  locale?: Locale,
) => {
  const loc = L(locale)
  const T = tt(loc, {
    // "Kredimi Gör" ARTIĞI DÜZELTİLDİ: cashback/kredi sistemi puana çevrildiğinde (ürün kararı)
    // arayüzden "kredi" terimi kaldırıldı ama bu butonda kalmıştı → kullanıcıya iki ayrı bakiye
    // varmış izlenimi veriyordu. Doğru terim: puan.
    tr: { subject: `${amount} puan kazandın! 🎉`, heading: `${amount} Puan Kazandın!`,
          body1: `Merhaba ${esc(fullName)}, <strong>${esc(classTitle)}</strong> rezervasyonundan <strong>${amount} puan</strong> kazandın. Puanlarını biriktirip ödüllerde kullanabilirsin.`,
          balance: 'Güncel puanın', cta: 'Puanlarımı Gör →' },
    en: { subject: `You earned ${amount} points! 🎉`, heading: `You Earned ${amount} Points!`,
          body1: `Hi ${esc(fullName)}, you earned <strong>${amount} points</strong> from your <strong>${esc(classTitle)}</strong> booking. Collect your points and spend them on rewards.`,
          balance: 'Your current points', cta: 'View My Points →' },
  })
  await resend.emails.send({
    from: FROM_EMAIL,
    to,
    subject: T.subject,
    html: baseTemplate(`
      <div style="text-align:center;margin-bottom:24px;">
        <div style="width:64px;height:64px;background:#F0FDF4;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;margin-bottom:16px;">
          <span style="font-size:32px;">🎁</span>
        </div>
        <h2 style="font-size:22px;font-weight:800;color:#111;margin:0;">${T.heading}</h2>
      </div>
      <p style="font-size:15px;color:#555;line-height:1.7;margin:0 0 20px;">
        ${T.body1}
      </p>
      <div style="background:#F0FDF4;border-radius:16px;padding:20px;margin-bottom:24px;border:1px solid #BBF7D0;text-align:center;">
        <p style="font-size:13px;color:#15803D;margin:0 0 4px;">${T.balance}</p>
        <p style="font-size:28px;font-weight:800;color:#15803D;margin:0;">${newBalance}</p>
      </div>
      <div style="text-align:center;">
        <a href="${SITE_URL}/profil" style="display:inline-block;padding:12px 28px;background:${BRAND_COLOR};color:#fff;border-radius:12px;text-decoration:none;font-size:14px;font-weight:700;">${T.cta}</a>
      </div>
    `, loc),
  })
}

// Ders transferi yapıldı → kullanıcıya bilgilendirme
export const sendTransferEmail = async (
  to: string,
  fullName: string,
  newClassTitle: string,
  date: string,
  time: string,
  priceRefund: number,
  locale?: Locale,
) => {
  const loc = L(locale)
  const T = tt(loc, {
    tr: { subject: `Dersin değiştirildi: ${newClassTitle}`, heading: 'Rezervasyonun Taşındı',
          body1: `Merhaba ${esc(fullName)}, rezervasyonun başarıyla yeni derse taşındı.`,
          refund: `💰 Fiyat farkı olan <strong>₺${priceRefund}</strong> tutarı iade edilecektir.`,
          cta: 'Rezervasyonlarımı Gör →' },
    en: { subject: `Your class has changed: ${newClassTitle}`, heading: 'Your Booking Was Moved',
          body1: `Hi ${esc(fullName)}, your booking has been moved to the new class.`,
          refund: `💰 The <strong>₺${priceRefund}</strong> price difference will be refunded to you.`,
          cta: 'View My Bookings →' },
  })
  await resend.emails.send({
    from: FROM_EMAIL,
    to,
    subject: T.subject,
    html: baseTemplate(`
      <div style="text-align:center;margin-bottom:24px;">
        <div style="width:64px;height:64px;background:#EEF2FF;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;margin-bottom:16px;">
          <span style="font-size:32px;">🔄</span>
        </div>
        <h2 style="font-size:22px;font-weight:800;color:#111;margin:0;">${T.heading}</h2>
      </div>
      <p style="font-size:15px;color:#555;line-height:1.7;margin:0 0 20px;">
        ${T.body1}
      </p>
      <div style="background:#FAFAFA;border-radius:16px;padding:20px;margin-bottom:20px;border:1px solid #F0F0F0;">
        <p style="font-size:17px;font-weight:700;color:#111;margin:0 0 12px;">${esc(newClassTitle)}</p>
        <p style="font-size:14px;color:#555;margin:0;">${date} · ${time}</p>
      </div>
      ${priceRefund > 0 ? `
      <div style="background:#F0FDF4;border-radius:12px;padding:16px;margin-bottom:24px;border:1px solid #BBF7D0;text-align:center;">
        <p style="font-size:14px;color:#15803D;margin:0;font-weight:600;">${T.refund}</p>
      </div>` : ''}
      <div style="text-align:center;">
        <a href="${SITE_URL}/profil" style="display:inline-block;padding:12px 28px;background:${BRAND_COLOR};color:#fff;border-radius:12px;text-decoration:none;font-size:14px;font-weight:700;">${T.cta}</a>
      </div>
    `, loc),
  })
}

// Streak (seri) teşvik e-postası — günlük veya haftalık seriyi sürdürmeye çağırır
export const sendStreakNudgeEmail = async (
  to: string,
  fullName: string,
  type: 'daily' | 'weekly',
  streakCount: number,
  locale?: Locale,
) => {
  const next = streakCount + 1
  const isDaily = type === 'daily'
  const loc = L(locale)
  const T = tt(loc, {
    tr: {
      unit: isDaily ? 'gün' : 'hafta',
      subject: isDaily ? `🔥 ${streakCount} günlük serini bozma!` : `🔥 ${streakCount} haftalık serini sürdür!`,
      headline: isDaily ? `${streakCount} gündür üst üste spordasın!` : `${streakCount} haftadır her hafta spordasın!`,
      body: isDaily
        ? `Bugün de bir derse katılırsan serini <strong>${next} güne</strong> çıkarırsın. Bırakma, momentum sende! 💪`
        : `Bu hafta da bir derse katılırsan serini <strong>${next} haftaya</strong> taşırsın. Serini bozma! 💪`,
      greeting: `Merhaba ${esc(fullName)}, `,
      streakLabel: 'Güncel serin', cta: 'Hemen Ders Bul →',
    },
    en: {
      unit: isDaily ? (streakCount === 1 ? 'day' : 'days') : (streakCount === 1 ? 'week' : 'weeks'),
      subject: isDaily ? `🔥 Don't break your ${streakCount}-day streak!` : `🔥 Keep your ${streakCount}-week streak going!`,
      headline: isDaily ? `You've been training ${streakCount} days in a row!` : `You've been training every week for ${streakCount} weeks!`,
      body: isDaily
        ? `Join a class today and you'll push your streak to <strong>${next} days</strong>. Don't stop now, the momentum is yours! 💪`
        : `Join a class this week and you'll take your streak to <strong>${next} weeks</strong>. Don't break it now! 💪`,
      greeting: `Hi ${esc(fullName)}, `,
      streakLabel: 'Your current streak', cta: 'Find a Class Now →',
    },
  })
  const { subject, headline, body, unit } = T
  await resend.emails.send({
    from: FROM_EMAIL,
    to,
    subject,
    html: baseTemplate(`
      <div style="text-align:center;margin-bottom:24px;">
        <div style="font-size:64px;line-height:1;margin-bottom:8px;">🔥</div>
        <h2 style="font-size:22px;font-weight:800;color:#111;margin:0;">${headline}</h2>
      </div>
      <div style="background:#FFF7ED;border:1px solid #FED7AA;border-radius:16px;padding:20px;margin-bottom:20px;text-align:center;">
        <p style="font-size:13px;color:#9A3412;margin:0 0 4px;">${T.streakLabel}</p>
        <p style="font-size:32px;font-weight:800;color:#F97316;margin:0;">${streakCount} ${unit}</p>
      </div>
      <p style="font-size:15px;color:#555;line-height:1.7;margin:0 0 24px;text-align:center;">
        ${T.greeting}${body}
      </p>
      <div style="text-align:center;">
        <a href="${SITE_URL}" style="display:inline-block;padding:14px 30px;background:${BRAND_COLOR};color:#fff;border-radius:12px;text-decoration:none;font-size:15px;font-weight:700;">${T.cta}</a>
      </div>
    `, loc),
  })
}

// Yeni rozet kazanıldı → kullanıcıya bilgilendirme
export const sendBadgeEmail = async (
  to: string,
  fullName: string,
  badgeNames: string[],
  locale?: Locale,
) => {
  const single = badgeNames.length === 1
  const loc = L(locale)
  // NOT: rozet ADLARI DB'de Türkçe seed'li (ensureBadges) → liste içeriği çevrilmez, çerçeve metni çevrilir.
  const T = tt(loc, {
    tr: { subject: single ? `Yeni rozet: ${badgeNames[0]} 🏅` : `${badgeNames.length} yeni rozet kazandın! 🏅`,
          heading: single ? 'Yeni Rozet Kazandın!' : `${badgeNames.length} Yeni Rozet!`,
          body1: `Merhaba ${esc(fullName)}, tebrikler! Şu rozetleri kazandın:`, cta: 'Rozetlerimi Gör →' },
    en: { subject: single ? `New badge: ${badgeNames[0]} 🏅` : `You earned ${badgeNames.length} new badges! 🏅`,
          heading: single ? 'You Earned a New Badge!' : `${badgeNames.length} New Badges!`,
          body1: `Hi ${esc(fullName)}, congrats! You just earned these badges:`, cta: 'View My Badges →' },
  })
  await resend.emails.send({
    from: FROM_EMAIL,
    to,
    subject: T.subject,
    html: baseTemplate(`
      <div style="text-align:center;margin-bottom:24px;">
        <div style="font-size:64px;line-height:1;margin-bottom:8px;">🏅</div>
        <h2 style="font-size:22px;font-weight:800;color:#111;margin:0;">${T.heading}</h2>
      </div>
      <p style="font-size:15px;color:#555;line-height:1.7;margin:0 0 20px;text-align:center;">
        ${T.body1}
      </p>
      <div style="background:#EEF2FF;border:1px solid #C7D2FE;border-radius:16px;padding:18px 20px;margin-bottom:24px;">
        ${badgeNames.map(n => `<p style="margin:6px 0;font-size:15px;font-weight:700;color:#4F46E5;">🏅 ${esc(n)}</p>`).join('')}
      </div>
      <div style="text-align:center;">
        <a href="${SITE_URL}/profil" style="display:inline-block;padding:14px 30px;background:${BRAND_COLOR};color:#fff;border-radius:12px;text-decoration:none;font-size:15px;font-weight:700;">${T.cta}</a>
      </div>
    `, loc),
  })
}

export const sendVenueApprovedEmail = async (
  to: string,
  venueName: string
) => {
  await resend.emails.send({
    from: FROM_EMAIL,
    to,
    subject: `Salonunuz Onaylandı! 🎉`,
    html: baseTemplate(`
      <div style="text-align: center; margin-bottom: 28px;">
        <div style="width: 64px; height: 64px; background: #F0FDF4; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; margin-bottom: 16px;">
          <span style="font-size: 32px;">✅</span>
        </div>
        <h2 style="font-size: 22px; font-weight: 800; color: #111; margin: 0;">Tebrikler!</h2>
      </div>
      <p style="font-size: 15px; color: #555; line-height: 1.7; margin: 0 0 24px;">
        <strong>${esc(venueName)}</strong> salonunuz Şipşakspor'da yayında! Artık derslerinizi ve seanslarınızı ekleyebilirsiniz.
      </p>
      <div style="background: #F0FDF4; border-radius: 16px; padding: 20px; margin-bottom: 28px; border: 1px solid #BBF7D0;">
        <p style="font-size: 14px; color: #166534; font-weight: 700; margin: 0 0 10px;">Sonraki adımlar:</p>
        <ul style="font-size: 14px; color: #555; line-height: 2; margin: 0; padding-left: 20px;">
          <li>Salon panelinize giriş yapın</li>
          <li>Sunduğunuz dersleri ekleyin</li>
          <li>Seans tarihleri ve saatlerini belirleyin</li>
          <li>Müşterilerinizin rezervasyon yapmasına izin verin</li>
        </ul>
      </div>
      <div style="text-align: center;">
        <a href="${SITE_URL}/salon-paneli" style="display: inline-block; padding: 14px 32px; background: #16A34A; color: #fff; border-radius: 14px; text-decoration: none; font-size: 15px; font-weight: 700;">Salon Paneline Git →</a>
      </div>
    `),
  })
}

// Grup rezervasyonunda etiketlenen kullanıcıya bildirim
export const sendGroupTagNotificationEmail = async (
  to: string,
  taggedName: string,
  bookerName: string,
  classTitle: string,
  date: string,
  time: string,
  venueName: string,
  locale?: Locale
) => {
  const loc = L(locale)
  const T = tt(loc, {
    tr: { subject: `${bookerName} seni bir derse ekledi!`, heading: 'Birlikte spora davetlisin!',
          body1: `Merhaba ${esc(taggedName)}, <strong>${esc(bookerName)}</strong> seni bir grup rezervasyonuna ekledi.`,
          lblDate: 'Tarih', lblTime: 'Saat', cta: "Şipşakspor'a Git →" },
    en: { subject: `${bookerName} added you to a class!`, heading: "You're invited to train together!",
          body1: `Hi ${esc(taggedName)}, <strong>${esc(bookerName)}</strong> added you to a group booking.`,
          lblDate: 'Date', lblTime: 'Time', cta: 'Go to Şipşakspor →' },
  })
  await resend.emails.send({
    from: FROM_EMAIL,
    to,
    subject: T.subject,
    html: baseTemplate(`
      <div style="text-align: center; margin-bottom: 28px;">
        <div style="width: 64px; height: 64px; background: #EEF2FF; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; margin-bottom: 16px;">
          <span style="font-size: 32px;">🤝</span>
        </div>
        <h2 style="font-size: 22px; font-weight: 800; color: #111; margin: 0;">${T.heading}</h2>
      </div>
      <p style="font-size: 15px; color: #555; line-height: 1.7; margin: 0 0 24px;">
        ${T.body1}
      </p>
      <div style="background: #FAFAFA; border-radius: 16px; padding: 20px; margin-bottom: 24px; border: 1px solid #F0F0F0;">
        <p style="font-size: 17px; font-weight: 700; color: #111; margin: 0 0 8px;">${esc(classTitle)}</p>
        <p style="font-size: 13px; color: #888; margin: 0 0 16px;">${esc(venueName)}</p>
        <div style="display: flex; gap: 24px;">
          <div>
            <p style="font-size: 11px; color: #aaa; font-weight: 600; text-transform: uppercase; margin: 0 0 4px;">${T.lblDate}</p>
            <p style="font-size: 14px; font-weight: 600; color: #111; margin: 0;">${date}</p>
          </div>
          <div>
            <p style="font-size: 11px; color: #aaa; font-weight: 600; text-transform: uppercase; margin: 0 0 4px;">${T.lblTime}</p>
            <p style="font-size: 14px; font-weight: 600; color: #111; margin: 0;">${time}</p>
          </div>
        </div>
      </div>
      <div style="text-align: center;">
        <a href="${SITE_URL}/profil" style="display: inline-block; padding: 12px 28px; background: ${BRAND_COLOR}; color: #fff; border-radius: 12px; text-decoration: none; font-size: 14px; font-weight: 700;">${T.cta}</a>
      </div>
    `, loc),
  })
}

// Platformda olmayan kullanıcıya davet emaili
export const sendGroupInviteEmail = async (
  to: string,
  bookerName: string,
  classTitle: string,
  date: string,
  time: string,
  venueName: string,
  locale?: Locale
) => {
  // Alıcı henüz ÜYE DEĞİL (locale'i yok) → davet EDENİN dili kullanılır: arkadaşını hangi dilde
  // kullanıyorsa muhtemelen aynı dili konuşuyordur. Verilmezse TR.
  const loc = L(locale)
  const T = tt(loc, {
    tr: { subject: `${bookerName} seni Şipşakspor'a davet etti!`, heading: 'Spor yapmaya davetlisin!',
          body1: `<strong>${esc(bookerName)}</strong> seni <strong>${esc(classTitle)}</strong> dersine davet etti.`,
          lblDate: 'Tarih', lblTime: 'Saat',
          body2: "Şipşakspor'a üye ol ve sporu birlikte keşfet!", cta: 'Üye Ol →' },
    en: { subject: `${bookerName} invited you to Şipşakspor!`, heading: "You're invited to work out!",
          body1: `<strong>${esc(bookerName)}</strong> invited you to the <strong>${esc(classTitle)}</strong> class.`,
          lblDate: 'Date', lblTime: 'Time',
          body2: 'Join Şipşakspor and discover sports together!', cta: 'Sign Up →' },
  })
  await resend.emails.send({
    from: FROM_EMAIL,
    to,
    subject: T.subject,
    html: baseTemplate(`
      <div style="text-align: center; margin-bottom: 28px;">
        <div style="width: 64px; height: 64px; background: #EEF2FF; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; margin-bottom: 16px;">
          <span style="font-size: 32px;">🏃</span>
        </div>
        <h2 style="font-size: 22px; font-weight: 800; color: #111; margin: 0;">${T.heading}</h2>
      </div>
      <p style="font-size: 15px; color: #555; line-height: 1.7; margin: 0 0 24px;">
        ${T.body1}
      </p>
      <div style="background: #FAFAFA; border-radius: 16px; padding: 20px; margin-bottom: 24px; border: 1px solid #F0F0F0;">
        <p style="font-size: 17px; font-weight: 700; color: #111; margin: 0 0 8px;">${esc(classTitle)}</p>
        <p style="font-size: 13px; color: #888; margin: 0 0 16px;">${esc(venueName)}</p>
        <div style="display: flex; gap: 24px;">
          <div>
            <p style="font-size: 11px; color: #aaa; font-weight: 600; text-transform: uppercase; margin: 0 0 4px;">${T.lblDate}</p>
            <p style="font-size: 14px; font-weight: 600; color: #111; margin: 0;">${date}</p>
          </div>
          <div>
            <p style="font-size: 11px; color: #aaa; font-weight: 600; text-transform: uppercase; margin: 0 0 4px;">${T.lblTime}</p>
            <p style="font-size: 14px; font-weight: 600; color: #111; margin: 0;">${time}</p>
          </div>
        </div>
      </div>
      <p style="font-size: 14px; color: #555; text-align: center; margin-bottom: 20px;">${T.body2}</p>
      <div style="text-align: center;">
        <a href="${SITE_URL}/kayit" style="display: inline-block; padding: 12px 28px; background: ${BRAND_COLOR}; color: #fff; border-radius: 12px; text-decoration: none; font-size: 14px; font-weight: 700;">${T.cta}</a>
      </div>
    `, loc),
  })
}

export const sendEmailVerificationEmail = async (to: string, fullName: string, token: string, locale?: Locale) => {
  const verifyUrl = `${SITE_URL}/email-dogrula?token=${token}`
  const loc = L(locale)
  const T = tt(loc, {
    tr: {
      subject: 'Şipşakspor — Email Adresinizi Doğrulayın',
      heading: 'Email Doğrulama',
      body1: `Merhaba ${esc(fullName)}! Hesabınızı aktifleştirmek için aşağıdaki butona tıklayın.`,
      cta: 'Emailimi Doğrula →',
      warning: '⚠️ Bu link 24 saat geçerlidir. Eğer bu talebi sen yapmadıysan bu emaili görmezden gelebilirsin.',
    },
    en: {
      subject: 'Şipşakspor — Verify Your Email Address',
      heading: 'Email Verification',
      body1: `Hi ${esc(fullName)}! Tap the button below to activate your account.`,
      cta: 'Verify My Email →',
      warning: "⚠️ This link is valid for 24 hours. If you didn't request this, you can safely ignore this email.",
    },
  })
  await resend.emails.send({
    from: FROM_EMAIL,
    to,
    subject: T.subject,
    html: baseTemplate(`
      <h2 style="font-size: 22px; font-weight: 800; color: #111; margin: 0 0 8px;">${T.heading}</h2>
      <p style="font-size: 15px; color: #555; line-height: 1.7; margin: 0 0 24px;">
        ${T.body1}
      </p>
      <div style="text-align: center; margin-bottom: 24px;">
        <a href="${verifyUrl}" style="display: inline-block; padding: 14px 32px; background: ${BRAND_COLOR}; color: #fff; border-radius: 14px; text-decoration: none; font-size: 15px; font-weight: 700;">${T.cta}</a>
      </div>
      <div style="background: #FEF2F2; border-radius: 12px; padding: 14px;">
        <p style="font-size: 13px; color: #DC2626; margin: 0;">${T.warning}</p>
      </div>
    `, loc),
  })
}
