import { Request } from 'express'

// Desteklenen bildirim dilleri. Arayüz (web+mobil) yalnız TR/EN sunuyor; buraya yeni dil eklenirse
// notifyText.ts kataloğuna ve web/mobil i18n sözlüklerine de AYNI anahtarlarla eklenmeli.
export type Locale = 'tr' | 'en'
export const DEFAULT_LOCALE: Locale = 'tr'

// Serbest girdiyi güvenli dile indirger. Bilinmeyen/bozuk değer sessizce varsayılana düşer —
// dil bir güvenlik sınırı değil, yalnız sunum tercihi (whitelist yeterli).
export function normalizeLocale(v: unknown): Locale {
  const s = String(v ?? '').trim().toLowerCase().slice(0, 8)
  if (s === 'en' || s.startsWith('en-')) return 'en'
  if (s === 'tr' || s.startsWith('tr-')) return 'tr'
  return DEFAULT_LOCALE
}

// İstemcinin o anki arayüz dili. Web/mobil api sarmalayıcıları her istekte `X-Locale` gönderir.
// Accept-Language'a DÜŞMÜYORUZ: kullanıcının uygulama içindeki dil tercihi (localStorage/AsyncStorage)
// tarayıcı/cihaz dilinden farklı olabilir ve doğru kaynak uygulamadaki seçimdir.
export function localeFromReq(req: Request): Locale {
  return normalizeLocale(req.headers['x-locale'])
}
