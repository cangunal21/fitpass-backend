import * as Sentry from '@sentry/node'

// Hata izleme. SENTRY_DSN env yoksa tamamen kapalı (no-op) çalışır.
// Controller'lar hataları try/catch içinde console.error ile loglayıp 500 döndüğü için,
// console.error'a düşen Error nesnelerini de Sentry'ye iletiyoruz — böylece
// getSessions gibi "yakalanıp loglanan" 500'ler de canlıda anında görünür.
// KVKK/GİZLİLİK SERTLEŞTİRMESİ — DSN girilmeden ÖNCE hazır olmalı.
// Sentry bir VERİ İŞLEYEN'dir; hata gövdesine kişisel veri sızarsa bu, gizlilik metninde beyan
// edilmemiş bir yurt dışı aktarım olur. Bu yüzden: otomatik PII kapalı, mesaj/exception/breadcrumb
// metinlerinden e-posta/telefon/TCKN/IBAN/JWT maskelenir, request gövdesi-çerez-başlık hiç gönderilmez.
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g
const PHONE_RE = /(?:\+90|0)?\s?5\d{2}[\s.-]?\d{3}[\s.-]?\d{2}[\s.-]?\d{2}/g
const TCKN_RE = /\b[1-9]\d{10}\b/g
const IBAN_RE = /\bTR\d{2}\s?(?:\d{4}\s?){5}\d{2}\b/gi
const JWT_RE = /\beyJ[\w-]+\.[\w-]+\.[\w-]+/g
const BEARER_RE = /Bearer\s+[\w.-]+/gi
// Opak hex token'lar: parola-sıfırlama (64 hex), verify (64), refresh (96). 24+ hex güvenli eşik
// (checkInCode 8 hex → yanlış-pozitif riski için dahil edilmedi). bcrypt hash de maskelenir.
const HEXTOKEN_RE = /\b[0-9a-f]{24,}\b/gi
const BCRYPT_RE = /\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}/g

export function scrub(text: unknown): string | undefined {
  if (typeof text !== 'string') return undefined
  return text
    .replace(EMAIL_RE, '[eposta]')
    .replace(IBAN_RE, '[iban]')
    .replace(JWT_RE, '[jwt]')
    .replace(BEARER_RE, 'Bearer [token]')
    .replace(PHONE_RE, '[telefon]')
    .replace(TCKN_RE, '[tckn]')
    .replace(BCRYPT_RE, '[hash]')
    .replace(HEXTOKEN_RE, '[token]')
}

function scrubUrl(url: unknown): string | undefined {
  if (typeof url !== 'string') return undefined
  // Doğrulama/sıfırlama linkleri, kupon kodu ve arama metni query'de taşınıyor → maskele
  return url.replace(/([?&](?:token|code|q|search|email)=)[^&#]*/gi, '$1[maskeli]')
}

export function initSentry() {
  const dsn = process.env.SENTRY_DSN
  if (!dsn) {
    console.log('[sentry] SENTRY_DSN tanımlı değil — hata izleme kapalı')
    return
  }

  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'production',
    release: process.env.RAILWAY_GIT_COMMIT_SHA || undefined, // hatayı hangi deploy'un ürettiğini eşler
    // Performans izleme env ile açılır (yük testinde 0.1 yapılacak); varsayılan kapalı.
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || 0),
    sendDefaultPii: false,
    maxBreadcrumbs: 30,
    beforeSend(event) {
      try {
        if (event.message) event.message = scrub(event.message) ?? event.message
        for (const ex of event.exception?.values || []) {
          if (ex.value) ex.value = scrub(ex.value) ?? ex.value
        }
        if (event.request) {
          event.request.url = scrubUrl(event.request.url) ?? event.request.url
          delete (event.request as any).query_string // url'den AYRI alan; ham token/code/email taşıyabilir
          delete event.request.data     // gövde parola/token/PII tasiyabilir
          delete event.request.cookies
          delete (event.request as any).headers
        }
        event.breadcrumbs = (event.breadcrumbs || []).map(b => ({
          ...b,
          message: scrub(b.message) ?? b.message,
          data: undefined, // serbest biçimli → tamamen düşür
        }))
        delete event.user // kimlik eşlemiyoruz (gerekirse userId tag olarak eklenir)
      } catch {
        /* maskeleme hatası olay göndermeyi engellemesin */
      }
      return event
    },
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
