import { Resend } from 'resend'

const resend = new Resend(process.env.RESEND_API_KEY)

const FROM_EMAIL = 'Şipşakspor <noreply@sipsakspor.com>'

export const sendWelcomeEmail = async (to: string, fullName: string) => {
  await resend.emails.send({
    from: FROM_EMAIL,
    to,
    subject: 'Fitpass\'e Hoş Geldin! 🏃',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f8f8f8; padding: 40px 20px;">
        <div style="background: #fff; border-radius: 20px; padding: 40px; box-shadow: 0 4px 24px rgba(0,0,0,0.08);">
          <div style="text-align: center; margin-bottom: 32px;">
            <h1 style="font-size: 28px; font-weight: 800; color: #FF385C; margin: 0;">fitpass</h1>
          </div>
          <h2 style="font-size: 22px; font-weight: 800; color: #1a1a1a; margin-bottom: 8px;">Merhaba ${fullName}! 👋</h2>
          <p style="font-size: 15px; color: #555; line-height: 1.7; margin-bottom: 24px;">
            Fitpass ailesine hoş geldin! Artık İstanbul'un en iyi spor derslerine tek platformdan erişebilirsin.
          </p>
          <div style="background: #FFF0F3; border-radius: 16px; padding: 20px; margin-bottom: 24px;">
            <p style="font-size: 14px; color: #FF385C; font-weight: 700; margin: 0 0 8px;">Neler yapabilirsin?</p>
            <ul style="font-size: 14px; color: #555; line-height: 2; margin: 0; padding-left: 20px;">
              <li>Yoga, Pilates, Boks ve daha fazlasına katıl</li>
              <li>Halı saha, basketbol, padel maçlarına kaydol</li>
              <li>Arkadaşlarınla birlikte antrenman yap</li>
              <li>Tier sistemiyle indirimler kazan</li>
            </ul>
          </div>
          <div style="text-align: center;">
            <a href="https://fitpasswebtr.vercel.app" style="display: inline-block; padding: 14px 32px; background: #FF385C; color: #fff; border-radius: 14px; text-decoration: none; font-size: 15px; font-weight: 700;">Ders Bulmaya Başla 🚀</a>
          </div>
          <p style="font-size: 12px; color: #bbb; text-align: center; margin-top: 32px;">
            Fitpass · İstanbul'un spor platformu
          </p>
        </div>
      </div>
    `,
  })
}

export const sendPasswordResetEmail = async (to: string, fullName: string, resetToken: string) => {
  const resetUrl = `https://fitpasswebtr.vercel.app/sifre-sifirla?token=${resetToken}`

  await resend.emails.send({
    from: FROM_EMAIL,
    to,
    subject: 'Fitpass Şifre Sıfırlama',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f8f8f8; padding: 40px 20px;">
        <div style="background: #fff; border-radius: 20px; padding: 40px; box-shadow: 0 4px 24px rgba(0,0,0,0.08);">
          <div style="text-align: center; margin-bottom: 32px;">
            <h1 style="font-size: 28px; font-weight: 800; color: #FF385C; margin: 0;">fitpass</h1>
          </div>
          <h2 style="font-size: 22px; font-weight: 800; color: #1a1a1a; margin-bottom: 8px;">Şifre Sıfırlama</h2>
          <p style="font-size: 15px; color: #555; line-height: 1.7; margin-bottom: 24px;">
            Merhaba ${fullName}, şifre sıfırlama talebinde bulundun. Aşağıdaki butona tıklayarak yeni şifreni belirleyebilirsin.
          </p>
          <div style="text-align: center; margin-bottom: 24px;">
            <a href="${resetUrl}" style="display: inline-block; padding: 14px 32px; background: #FF385C; color: #fff; border-radius: 14px; text-decoration: none; font-size: 15px; font-weight: 700;">Şifremi Sıfırla</a>
          </div>
          <div style="background: #FEF2F2; border-radius: 12px; padding: 14px; margin-bottom: 16px;">
            <p style="font-size: 13px; color: #DC2626; margin: 0;">⚠️ Bu link 1 saat geçerlidir. Eğer bu talebi sen yapmadıysan bu emaili görmezden gelebilirsin.</p>
          </div>
          <p style="font-size: 12px; color: #bbb; text-align: center; margin-top: 32px;">
            Fitpass · İstanbul'un spor platformu
          </p>
        </div>
      </div>
    `,
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
    subject: `Rezervasyon Onaylandı: ${classTitle} 🎉`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f8f8f8; padding: 40px 20px;">
        <div style="background: #fff; border-radius: 20px; padding: 40px; box-shadow: 0 4px 24px rgba(0,0,0,0.08);">
          <div style="text-align: center; margin-bottom: 32px;">
            <h1 style="font-size: 28px; font-weight: 800; color: #FF385C; margin: 0;">fitpass</h1>
          </div>
          <div style="text-align: center; margin-bottom: 24px;">
            <div style="font-size: 48px; margin-bottom: 12px;">🎉</div>
            <h2 style="font-size: 22px; font-weight: 800; color: #1a1a1a; margin: 0;">Rezervasyon Onaylandı!</h2>
          </div>
          <p style="font-size: 15px; color: #555; line-height: 1.7; margin-bottom: 24px;">
            Merhaba ${fullName}, rezervasyonun başarıyla oluşturuldu!
          </p>
          <div style="background: #f9f9f9; border-radius: 16px; padding: 20px; margin-bottom: 24px;">
            <p style="font-size: 16px; font-weight: 700; color: #1a1a1a; margin: 0 0 12px;">${classTitle}</p>
            <div style="display: flex; gap: 20px;">
              <div>
                <p style="font-size: 11px; color: #999; font-weight: 600; text-transform: uppercase; margin: 0 0 4px;">Tarih</p>
                <p style="font-size: 14px; font-weight: 600; color: #1a1a1a; margin: 0;">📅 ${date}</p>
              </div>
              <div>
                <p style="font-size: 11px; color: #999; font-weight: 600; text-transform: uppercase; margin: 0 0 4px;">Saat</p>
                <p style="font-size: 14px; font-weight: 600; color: #1a1a1a; margin: 0;">🕐 ${time}</p>
              </div>
              <div>
                <p style="font-size: 11px; color: #999; font-weight: 600; text-transform: uppercase; margin: 0 0 4px;">Ücret</p>
                <p style="font-size: 14px; font-weight: 600; color: #FF385C; margin: 0;">₺${price}</p>
              </div>
            </div>
          </div>
          <div style="background: #FFF9F0; border-radius: 12px; padding: 14px; margin-bottom: 24px;">
            <p style="font-size: 13px; color: #92400e; margin: 0;">🔒 12 saat öncesine kadar %50 iade garantisi mevcuttur.</p>
          </div>
          <p style="font-size: 12px; color: #bbb; text-align: center; margin-top: 32px;">
            Fitpass · İstanbul'un spor platformu
          </p>
        </div>
      </div>
    `,
  })
}
