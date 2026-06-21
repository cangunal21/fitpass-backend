export const sendPushNotification = async (pushToken: string, title: string, body: string, data?: Record<string, unknown>) => {
  if (!pushToken.startsWith('ExponentPushToken')) return
  try {
    await fetch('https://exp.host/--/api/v2/push/send', {
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
    })
  } catch (err) {
    console.error('Push notification error:', err)
  }
}
