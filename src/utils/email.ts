import { Resend } from 'resend'

let _resend: Resend | null = null
const resend = {
  emails: {
    send: async (opts: any) => {
      if (!process.env.RESEND_API_KEY) {
        console.log('[email skip] RESEND_API_KEY yok:', opts.subject)
        return
      }
      if (!_resend) _resend = new Resend(process.env.RESEND_API_KEY)
      return _resend.emails.send(opts)
    }
  }
}

const FROM_EMAIL = 'Şipşakspor <noreply@sipsakspor.com>'
const BRAND_COLOR = '#4F46E5'
const SITE_URL = 'https://sipsakspor.com'

const baseTemplate = (content: string) => `
  <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto; background: #F5F5F5; padding: 40px 20px;">
    <div style="background: #fff; border-radius: 24px; overflow: hidden; box-shadow: 0 4px 24px rgba(0,0,0,0.06);">
      <div style="background: linear-gradient(135deg, #4F46E5 0%, #6366F1 50%, #818CF8 100%); padding: 32px; text-align: center;">
        <h1 style="font-size: 26px; font-weight: 800; color: #fff; margin: 0; letter-spacing: -0.5px;">şipşakspor</h1>
        <p style="font-size: 13px; color: rgba(255,255,255,0.7); margin: 6px 0 0;">İstanbul'un spor platformu</p>
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

export const sendWelcomeEmail = async (to: string, fullName: string) => {
  await resend.emails.send({
    from: FROM_EMAIL,
    to,
    subject: 'Şipşakspor\'a Hoş Geldin!',
    html: baseTemplate(`
      <h2 style="font-size: 22px; font-weight: 800; color: #111; margin: 0 0 8px;">Merhaba ${fullName}! 👋</h2>
      <p style="font-size: 15px; color: #555; line-height: 1.7; margin: 0 0 24px;">
        Şipşakspor ailesine hoş geldin! Artık İstanbul'un en iyi spor derslerine tek platformdan erişebilirsin.
      </p>
      <div style="background: #EEF2FF; border-radius: 16px; padding: 20px; margin-bottom: 28px;">
        <p style="font-size: 14px; color: ${BRAND_COLOR}; font-weight: 700; margin: 0 0 10px;">Neler yapabilirsin?</p>
        <ul style="font-size: 14px; color: #555; line-height: 2; margin: 0; padding-left: 20px;">
          <li>Yoga, Pilates, Boks ve daha fazlasına katıl</li>
          <li>Halı saha, basketbol, padel maçlarına kaydol</li>
          <li>Arkadaşlarınla birlikte antrenman yap</li>
          <li>Tier sistemiyle indirimler kazan</li>
        </ul>
      </div>
      <div style="text-align: center;">
        <a href="${SITE_URL}" style="display: inline-block; padding: 14px 32px; background: ${BRAND_COLOR}; color: #fff; border-radius: 14px; text-decoration: none; font-size: 15px; font-weight: 700;">Ders Bulmaya Başla →</a>
      </div>
    `),
  })
}

export const sendPasswordResetEmail = async (to: string, fullName: string, resetToken: string) => {
  const resetUrl = `${SITE_URL}/sifre-sifirla?token=${resetToken}`

  await resend.emails.send({
    from: FROM_EMAIL,
    to,
    subject: 'Şipşakspor — Şifre Sıfırlama',
    html: baseTemplate(`
      <h2 style="font-size: 22px; font-weight: 800; color: #111; margin: 0 0 8px;">Şifre Sıfırlama</h2>
      <p style="font-size: 15px; color: #555; line-height: 1.7; margin: 0 0 24px;">
        Merhaba ${fullName}, şifre sıfırlama talebinde bulundun. Aşağıdaki butona tıklayarak yeni şifreni belirleyebilirsin.
      </p>
      <div style="text-align: center; margin-bottom: 24px;">
        <a href="${resetUrl}" style="display: inline-block; padding: 14px 32px; background: ${BRAND_COLOR}; color: #fff; border-radius: 14px; text-decoration: none; font-size: 15px; font-weight: 700;">Şifremi Sıfırla →</a>
      </div>
      <div style="background: #FEF2F2; border-radius: 12px; padding: 14px;">
        <p style="font-size: 13px; color: #DC2626; margin: 0;">⚠️ Bu link 1 saat geçerlidir. Eğer bu talebi sen yapmadıysan bu emaili görmezden gelebilirsin.</p>
      </div>
    `),
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
        Merhaba <strong>${venueName}</strong>, salon paneliniz için şifre sıfırlama talebinde bulunuldu. Aşağıdaki butona tıklayarak yeni şifrenizi belirleyebilirsiniz.
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

export const sendBookingConfirmationEmail = async (
  to: string,
  fullName: string,
  classTitle: string,
  date: string,
  time: string,
  price: number
) => {
  await resend.emails.send({
    from: FROM_EMAIL,
    to,
    subject: `Rezervasyon Onaylandı: ${classTitle}`,
    html: baseTemplate(`
      <div style="text-align: center; margin-bottom: 28px;">
        <div style="width: 64px; height: 64px; background: #EEF2FF; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; margin-bottom: 16px;">
          <span style="font-size: 32px;">🎉</span>
        </div>
        <h2 style="font-size: 22px; font-weight: 800; color: #111; margin: 0;">Rezervasyon Onaylandı!</h2>
      </div>
      <p style="font-size: 15px; color: #555; line-height: 1.7; margin: 0 0 24px;">
        Merhaba ${fullName}, rezervasyonun başarıyla oluşturuldu!
      </p>
      <div style="background: #FAFAFA; border-radius: 16px; padding: 20px; margin-bottom: 24px; border: 1px solid #F0F0F0;">
        <p style="font-size: 17px; font-weight: 700; color: #111; margin: 0 0 16px;">${classTitle}</p>
        <div style="display: flex; gap: 24px;">
          <div>
            <p style="font-size: 11px; color: #aaa; font-weight: 600; text-transform: uppercase; margin: 0 0 4px;">Tarih</p>
            <p style="font-size: 14px; font-weight: 600; color: #111; margin: 0;">${date}</p>
          </div>
          <div>
            <p style="font-size: 11px; color: #aaa; font-weight: 600; text-transform: uppercase; margin: 0 0 4px;">Saat</p>
            <p style="font-size: 14px; font-weight: 600; color: #111; margin: 0;">${time}</p>
          </div>
          <div>
            <p style="font-size: 11px; color: #aaa; font-weight: 600; text-transform: uppercase; margin: 0 0 4px;">Ücret</p>
            <p style="font-size: 14px; font-weight: 700; color: ${BRAND_COLOR}; margin: 0;">₺${price}</p>
          </div>
        </div>
      </div>
      <div style="background: #FFF7ED; border-radius: 12px; padding: 14px; margin-bottom: 24px;">
        <p style="font-size: 13px; color: #92400E; margin: 0;">🔒 12 saat öncesine kadar ücretsiz iptal hakkın var.</p>
      </div>
      <div style="text-align: center;">
        <a href="${SITE_URL}/profil" style="display: inline-block; padding: 12px 28px; background: ${BRAND_COLOR}; color: #fff; border-radius: 12px; text-decoration: none; font-size: 14px; font-weight: 700;">Rezervasyonlarımı Gör →</a>
      </div>
    `),
  })
}

export const sendCancellationEmail = async (
  to: string,
  fullName: string,
  classTitle: string,
  date: string,
  time: string,
) => {
  await resend.emails.send({
    from: FROM_EMAIL,
    to,
    subject: `Rezervasyon İptal Edildi: ${classTitle}`,
    html: baseTemplate(`
      <div style="text-align: center; margin-bottom: 28px;">
        <div style="width: 64px; height: 64px; background: #FEF2F2; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; margin-bottom: 16px;">
          <span style="font-size: 32px;">❌</span>
        </div>
        <h2 style="font-size: 22px; font-weight: 800; color: #111; margin: 0;">Rezervasyon İptal Edildi</h2>
      </div>
      <p style="font-size: 15px; color: #555; line-height: 1.7; margin: 0 0 24px;">
        Merhaba ${fullName}, aşağıdaki rezervasyonun iptal edildi.
      </p>
      <div style="background: #FAFAFA; border-radius: 16px; padding: 20px; margin-bottom: 24px; border: 1px solid #F0F0F0;">
        <p style="font-size: 17px; font-weight: 700; color: #111; margin: 0 0 16px;">${classTitle}</p>
        <div style="display: flex; gap: 24px;">
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
      <div style="background: #EEF2FF; border-radius: 12px; padding: 14px; margin-bottom: 24px;">
        <p style="font-size: 13px; color: ${BRAND_COLOR}; margin: 0;">Başka bir derse katılmak için platformumuzu ziyaret edebilirsin.</p>
      </div>
      <div style="text-align: center;">
        <a href="${SITE_URL}" style="display: inline-block; padding: 12px 28px; background: ${BRAND_COLOR}; color: #fff; border-radius: 12px; text-decoration: none; font-size: 14px; font-weight: 700;">Ders Bul →</a>
      </div>
    `),
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
        <p style="font-size: 17px; font-weight: 700; color: #111; margin: 0 0 16px;">${classTitle}</p>
        <div style="display: flex; gap: 24px; flex-wrap: wrap;">
          <div>
            <p style="font-size: 11px; color: #aaa; font-weight: 600; text-transform: uppercase; margin: 0 0 4px;">Müşteri</p>
            <p style="font-size: 14px; font-weight: 600; color: #111; margin: 0;">${customerName}</p>
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
  availableSpots: number
) => {
  const spotsLeft = availableSpots - 1
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
        <p style="font-size: 17px; font-weight: 700; color: #111; margin: 0 0 16px;">${classTitle}</p>
        <div style="display: flex; gap: 24px; flex-wrap: wrap;">
          <div>
            <p style="font-size: 11px; color: #aaa; font-weight: 600; text-transform: uppercase; margin: 0 0 4px;">Müşteri</p>
            <p style="font-size: 14px; font-weight: 600; color: #111; margin: 0;">${customerName}</p>
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
        <p style="font-size: 16px; font-weight: 700; color: #111; margin: 0 0 16px;">${venueName}</p>
        <div style="display: flex; flex-direction: column; gap: 10px;">
          <div>
            <p style="font-size: 11px; color: #aaa; font-weight: 600; text-transform: uppercase; margin: 0 0 2px;">E-posta</p>
            <p style="font-size: 14px; color: #111; margin: 0;">${venueEmail}</p>
          </div>
          <div>
            <p style="font-size: 11px; color: #aaa; font-weight: 600; text-transform: uppercase; margin: 0 0 2px;">Telefon</p>
            <p style="font-size: 14px; color: #111; margin: 0;">${venuePhone}</p>
          </div>
          <div>
            <p style="font-size: 11px; color: #aaa; font-weight: 600; text-transform: uppercase; margin: 0 0 2px;">Adres</p>
            <p style="font-size: 14px; color: #111; margin: 0;">${venueAddress}</p>
          </div>
          <div>
            <p style="font-size: 11px; color: #aaa; font-weight: 600; text-transform: uppercase; margin: 0 0 2px;">Spor Kategorileri</p>
            <p style="font-size: 14px; color: #111; margin: 0;">${sportCategories.join(', ') || '—'}</p>
          </div>
        </div>
      </div>
      <div style="text-align: center;">
        <a href="${SITE_URL}/admin" style="display: inline-block; padding: 14px 32px; background: #DC2626; color: #fff; border-radius: 14px; text-decoration: none; font-size: 15px; font-weight: 700;">Admin Paneline Git →</a>
      </div>
    `),
  })
}

export const sendReminderEmail = async (to: string, fullName: string, classTitle: string, date: string, time: string, venueName: string) => {
  await resend.emails.send({
    from: FROM_EMAIL,
    to,
    subject: `⏰ Dersiniz 2 saat sonra başlıyor — ${classTitle}`,
    html: baseTemplate(`
      <h2 style="font-size:22px;font-weight:800;color:#1a1a1a;margin:0 0 8px;">Dersiniz yaklaşıyor! ⏰</h2>
      <p style="color:#555;font-size:15px;margin:0 0 24px;">Merhaba <strong>${fullName}</strong>, bugünkü dersinizi hatırlatmak istedik.</p>
      <div style="background:#F5F3FF;border-radius:12px;padding:20px 24px;margin-bottom:24px;">
        <p style="margin:0 0 8px;font-size:16px;font-weight:700;color:#4F46E5;">${classTitle}</p>
        <p style="margin:0 0 4px;color:#555;font-size:14px;">📍 ${venueName}</p>
        <p style="margin:0;color:#555;font-size:14px;">🗓 ${date} · ⏰ ${time}</p>
      </div>
      <p style="color:#888;font-size:13px;">Unutma: derse 12 saatten az kaldığında iptal yapılamaz.</p>
    `)
  })
}

export const sendWaitlistNotificationEmail = async (to: string, fullName: string, classTitle: string, date: string, time: string) => {
  await resend.emails.send({
    from: FROM_EMAIL,
    to,
    subject: `🎉 Yer açıldı! ${classTitle} dersine katılabilirsiniz`,
    html: baseTemplate(`
      <h2 style="font-size:22px;font-weight:800;color:#1a1a1a;margin:0 0 8px;">Yer açıldı! 🎉</h2>
      <p style="color:#555;font-size:15px;margin:0 0 24px;">Merhaba <strong>${fullName}</strong>, bekleme listesinde olduğunuz ders için yer açıldı!</p>
      <div style="background:#F0FDF4;border-radius:12px;padding:20px 24px;margin-bottom:24px;">
        <p style="margin:0 0 8px;font-size:16px;font-weight:700;color:#16a34a;">${classTitle}</p>
        <p style="margin:0;color:#555;font-size:14px;">🗓 ${date} · ⏰ ${time}</p>
      </div>
      <p style="color:#888;font-size:13px;">Hemen rezervasyon yap, yer dolmadan önce!</p>
      <a href="${process.env.SITE_URL || 'https://sipsakspor.com'}" style="display:inline-block;margin-top:16px;padding:14px 28px;background:#4F46E5;color:#fff;border-radius:12px;text-decoration:none;font-weight:700;font-size:15px;">Hemen Rezervasyon Yap</a>
    `)
  })
}

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
    subject: `[Şikayet] ${subject}`,
    html: baseTemplate(`
      <h2 style="font-size:20px;font-weight:800;color:#1a1a1a;margin:0 0 20px;">Yeni Şikayet / Geri Bildirim</h2>
      <div style="background:#F8F8F8;border-radius:12px;padding:20px 24px;margin-bottom:20px;">
        <p style="margin:0 0 8px;font-size:13px;color:#888;">Gönderen</p>
        <p style="margin:0;font-size:15px;font-weight:700;color:#1a1a1a;">${name} · <a href="mailto:${email}" style="color:#4F46E5;">${email}</a></p>
      </div>
      <div style="background:#F8F8F8;border-radius:12px;padding:20px 24px;margin-bottom:20px;">
        <p style="margin:0 0 8px;font-size:13px;color:#888;">Konu</p>
        <p style="margin:0;font-size:15px;font-weight:700;color:#1a1a1a;">${subject}</p>
      </div>
      <div style="background:#F8F8F8;border-radius:12px;padding:20px 24px;">
        <p style="margin:0 0 8px;font-size:13px;color:#888;">Mesaj</p>
        <p style="margin:0;font-size:15px;color:#333;line-height:1.7;white-space:pre-wrap;">${message}</p>
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
    subject: `[Şikayet] @${reportedUsername} kullanıcısı şikayet edildi`,
    html: baseTemplate(`
      <h2 style="font-size:20px;font-weight:800;color:#1a1a1a;margin:0 0 20px;">Yeni Kullanıcı Şikayeti</h2>
      <div style="background:#FEF2F2;border-radius:12px;padding:20px 24px;margin-bottom:16px;border:1px solid #FECACA;">
        <p style="margin:0 0 8px;font-size:13px;color:#888;">Şikayet edilen kullanıcı</p>
        <p style="margin:0;font-size:15px;font-weight:700;color:#1a1a1a;">${reportedName} · @${reportedUsername}</p>
      </div>
      <div style="background:#F8F8F8;border-radius:12px;padding:20px 24px;margin-bottom:16px;">
        <p style="margin:0 0 8px;font-size:13px;color:#888;">Şikayet eden</p>
        <p style="margin:0;font-size:15px;font-weight:700;color:#1a1a1a;">${reporterName} · @${reporterUsername}</p>
      </div>
      <div style="background:#F8F8F8;border-radius:12px;padding:20px 24px;">
        <p style="margin:0 0 8px;font-size:13px;color:#888;">Sebep</p>
        <p style="margin:0;font-size:15px;color:#333;line-height:1.7;white-space:pre-wrap;">${reason || 'Belirtilmedi'}</p>
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
) => {
  await resend.emails.send({
    from: FROM_EMAIL,
    to,
    subject: `₺${amount} cashback kazandın! 🎁`,
    html: baseTemplate(`
      <div style="text-align:center;margin-bottom:24px;">
        <div style="width:64px;height:64px;background:#F0FDF4;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;margin-bottom:16px;">
          <span style="font-size:32px;">🎁</span>
        </div>
        <h2 style="font-size:22px;font-weight:800;color:#111;margin:0;">₺${amount} Cashback Kazandın!</h2>
      </div>
      <p style="font-size:15px;color:#555;line-height:1.7;margin:0 0 20px;">
        Merhaba ${fullName}, <strong>${classTitle}</strong> rezervasyonundan <strong>₺${amount} cashback</strong> kredisi kazandın. Bu kredi bir sonraki rezervasyonlarında otomatik indirim olarak kullanılabilir.
      </p>
      <div style="background:#F0FDF4;border-radius:16px;padding:20px;margin-bottom:24px;border:1px solid #BBF7D0;text-align:center;">
        <p style="font-size:13px;color:#15803D;margin:0 0 4px;">Güncel kredi bakiyen</p>
        <p style="font-size:28px;font-weight:800;color:#15803D;margin:0;">₺${newBalance}</p>
      </div>
      <div style="text-align:center;">
        <a href="${SITE_URL}/profil" style="display:inline-block;padding:12px 28px;background:${BRAND_COLOR};color:#fff;border-radius:12px;text-decoration:none;font-size:14px;font-weight:700;">Kredimi Gör →</a>
      </div>
    `),
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
) => {
  await resend.emails.send({
    from: FROM_EMAIL,
    to,
    subject: `Dersin değiştirildi: ${newClassTitle}`,
    html: baseTemplate(`
      <div style="text-align:center;margin-bottom:24px;">
        <div style="width:64px;height:64px;background:#EEF2FF;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;margin-bottom:16px;">
          <span style="font-size:32px;">🔄</span>
        </div>
        <h2 style="font-size:22px;font-weight:800;color:#111;margin:0;">Rezervasyonun Taşındı</h2>
      </div>
      <p style="font-size:15px;color:#555;line-height:1.7;margin:0 0 20px;">
        Merhaba ${fullName}, rezervasyonun başarıyla yeni derse taşındı.
      </p>
      <div style="background:#FAFAFA;border-radius:16px;padding:20px;margin-bottom:20px;border:1px solid #F0F0F0;">
        <p style="font-size:17px;font-weight:700;color:#111;margin:0 0 12px;">${newClassTitle}</p>
        <p style="font-size:14px;color:#555;margin:0;">${date} · ${time}</p>
      </div>
      ${priceRefund > 0 ? `
      <div style="background:#F0FDF4;border-radius:12px;padding:16px;margin-bottom:24px;border:1px solid #BBF7D0;text-align:center;">
        <p style="font-size:14px;color:#15803D;margin:0;font-weight:600;">💰 Fiyat farkı olan <strong>₺${priceRefund}</strong> kredi olarak hesabına iade edildi.</p>
      </div>` : ''}
      <div style="text-align:center;">
        <a href="${SITE_URL}/profil" style="display:inline-block;padding:12px 28px;background:${BRAND_COLOR};color:#fff;border-radius:12px;text-decoration:none;font-size:14px;font-weight:700;">Rezervasyonlarımı Gör →</a>
      </div>
    `),
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
        <strong>${venueName}</strong> salonunuz Şipşakspor'da yayında! Artık derslerinizi ve seanslarınızı ekleyebilirsiniz.
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
  venueName: string
) => {
  await resend.emails.send({
    from: FROM_EMAIL,
    to,
    subject: `${bookerName} seni bir derse ekledi!`,
    html: baseTemplate(`
      <div style="text-align: center; margin-bottom: 28px;">
        <div style="width: 64px; height: 64px; background: #EEF2FF; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; margin-bottom: 16px;">
          <span style="font-size: 32px;">🤝</span>
        </div>
        <h2 style="font-size: 22px; font-weight: 800; color: #111; margin: 0;">Birlikte spora davetlisin!</h2>
      </div>
      <p style="font-size: 15px; color: #555; line-height: 1.7; margin: 0 0 24px;">
        Merhaba ${taggedName}, <strong>${bookerName}</strong> seni bir grup rezervasyonuna ekledi.
      </p>
      <div style="background: #FAFAFA; border-radius: 16px; padding: 20px; margin-bottom: 24px; border: 1px solid #F0F0F0;">
        <p style="font-size: 17px; font-weight: 700; color: #111; margin: 0 0 8px;">${classTitle}</p>
        <p style="font-size: 13px; color: #888; margin: 0 0 16px;">${venueName}</p>
        <div style="display: flex; gap: 24px;">
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
        <a href="${SITE_URL}/profil" style="display: inline-block; padding: 12px 28px; background: ${BRAND_COLOR}; color: #fff; border-radius: 12px; text-decoration: none; font-size: 14px; font-weight: 700;">Şipşakspor'a Git →</a>
      </div>
    `),
  })
}

// Platformda olmayan kullanıcıya davet emaili
export const sendGroupInviteEmail = async (
  to: string,
  bookerName: string,
  classTitle: string,
  date: string,
  time: string,
  venueName: string
) => {
  await resend.emails.send({
    from: FROM_EMAIL,
    to,
    subject: `${bookerName} seni Şipşakspor'a davet etti!`,
    html: baseTemplate(`
      <div style="text-align: center; margin-bottom: 28px;">
        <div style="width: 64px; height: 64px; background: #EEF2FF; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; margin-bottom: 16px;">
          <span style="font-size: 32px;">🏃</span>
        </div>
        <h2 style="font-size: 22px; font-weight: 800; color: #111; margin: 0;">Spor yapmaya davetlisin!</h2>
      </div>
      <p style="font-size: 15px; color: #555; line-height: 1.7; margin: 0 0 24px;">
        <strong>${bookerName}</strong> seni <strong>${classTitle}</strong> dersine davet etti.
      </p>
      <div style="background: #FAFAFA; border-radius: 16px; padding: 20px; margin-bottom: 24px; border: 1px solid #F0F0F0;">
        <p style="font-size: 17px; font-weight: 700; color: #111; margin: 0 0 8px;">${classTitle}</p>
        <p style="font-size: 13px; color: #888; margin: 0 0 16px;">${venueName}</p>
        <div style="display: flex; gap: 24px;">
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
      <p style="font-size: 14px; color: #555; text-align: center; margin-bottom: 20px;">Şipşakspor'a üye ol ve sporu birlikte keşfet!</p>
      <div style="text-align: center;">
        <a href="${SITE_URL}/kayit" style="display: inline-block; padding: 12px 28px; background: ${BRAND_COLOR}; color: #fff; border-radius: 12px; text-decoration: none; font-size: 14px; font-weight: 700;">Üye Ol →</a>
      </div>
    `),
  })
}

export const sendEmailVerificationEmail = async (to: string, fullName: string, token: string) => {
  const verifyUrl = `${SITE_URL}/email-dogrula?token=${token}`
  await resend.emails.send({
    from: FROM_EMAIL,
    to,
    subject: 'Şipşakspor — Email Adresinizi Doğrulayın',
    html: baseTemplate(`
      <h2 style="font-size: 22px; font-weight: 800; color: #111; margin: 0 0 8px;">Email Doğrulama</h2>
      <p style="font-size: 15px; color: #555; line-height: 1.7; margin: 0 0 24px;">
        Merhaba ${fullName}! Hesabınızı aktifleştirmek için aşağıdaki butona tıklayın.
      </p>
      <div style="text-align: center; margin-bottom: 24px;">
        <a href="${verifyUrl}" style="display: inline-block; padding: 14px 32px; background: ${BRAND_COLOR}; color: #fff; border-radius: 14px; text-decoration: none; font-size: 15px; font-weight: 700;">Emailimi Doğrula →</a>
      </div>
      <div style="background: #FEF2F2; border-radius: 12px; padding: 14px;">
        <p style="font-size: 13px; color: #DC2626; margin: 0;">⚠️ Bu link 24 saat geçerlidir. Eğer bu talebi sen yapmadıysan bu emaili görmezden gelebilirsin.</p>
      </div>
    `),
  })
}
