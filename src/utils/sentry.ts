import * as Sentry from '@sentry/node'

// Hata izleme. SENTRY_DSN env yoksa tamamen kapalı (no-op) çalışır.
// Controller'lar hataları try/catch içinde console.error ile loglayıp 500 döndüğü için,
// console.error'a düşen Error nesnelerini de Sentry'ye iletiyoruz — böylece
// getSessions gibi "yakalanıp loglanan" 500'ler de canlıda anında görünür.
export function initSentry() {
  const dsn = process.env.SENTRY_DSN
  if (!dsn) {
    console.log('[sentry] SENTRY_DSN tanımlı değil — hata izleme kapalı')
    return
  }

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || 'production',
    tracesSampleRate: 0, // sadece hatalar (performans izleme kapalı)
  })

  const original = console.error.bind(console)
  console.error = (...args: any[]) => {
    original(...args)
    try {
      const err = args.find(a => a instanceof Error)
      if (err) {
        Sentry.captureException(err)
      }
    } catch {
      /* izleme hatası uygulamayı etkilemesin */
    }
  }

  console.log('[sentry] hata izleme aktif')
}

export { Sentry }
