import prisma from './prisma'

// Expo push gönderimi. Üç sertleştirme:
// (1) TIMEOUT — eskiden yoktu: yavaş/asılı Expo isteği, bu fonksiyonu await eden cron job'larını
//     (reminder/streak/rating, kullanıcı başına seri çağrı) süresiz bekletebiliyordu.
// (2) YANIT KONTROLÜ — HTTP hatası ve bilet (ticket) durumu hiç okunmuyordu; hata sessizce yutuluyordu.
// (3) ÖLÜ TOKEN TEMİZLİĞİ — 'DeviceNotRegistered' bileti hiç görülmediği için uygulamayı silmiş
//     kullanıcının token'ı sonsuza dek denenmeye devam ediyordu.
const PUSH_TIMEOUT_MS = 8000

export const sendPushNotification = async (pushToken: string, title: string, body: string, data?: Record<string, unknown>) => {
  if (!pushToken?.startsWith('ExponentPushToken')) return
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), PUSH_TIMEOUT_MS)
  try {
    const res = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        to: pushToken,
        title,
        body,
        sound: 'default',
        data: data || {},
      }),
      signal: ctrl.signal,
    })
    if (!res.ok) {
      console.error('[push FAIL] HTTP', res.status, title)
      return
    }
    const json: any = await res.json().catch(() => null)
    const ticket = Array.isArray(json?.data) ? json.data[0] : json?.data
    if (ticket?.status === 'error') {
      const code = ticket?.details?.error
      console.error('[push ticket error]', code || ticket?.message, title)
      if (code === 'DeviceNotRegistered') {
        // Token artık geçersiz (uygulama silinmiş/yeniden kurulmuş) → bir daha denenmesin
        await prisma.user.updateMany({ where: { pushToken }, data: { pushToken: null } }).catch(() => {})
      }
    }
  } catch (err: any) {
    console.error('Push notification error:', err?.name === 'AbortError' ? 'timeout' : err)
  } finally {
    clearTimeout(timer)
  }
}
