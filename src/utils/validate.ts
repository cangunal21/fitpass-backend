// Ortak girdi doğrulama / sınırlama yardımcıları (güvenlik + veri hijyeni).

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export const isValidEmail = (e: unknown): boolean =>
  typeof e === 'string' && e.length <= 254 && EMAIL_RE.test(e.trim())

export const MIN_PASSWORD = 8

// String alanları üst sınıra kırp (DoS/şişirme önlemi). undefined ise dokunma.
export const clampStr = (v: unknown, max: number): string | undefined =>
  v === undefined || v === null ? undefined : String(v).slice(0, max)

// Geçerli, Postgres int4 aralığında pozitif tamsayı ise döndürür; değilse undefined.
// query/body'den gelen ID'ler için: "abc"/taşan sayı → undefined → Prisma'ya NaN/overflow gitmez (500 önlenir).
export const parseIntSafe = (v: unknown): number | undefined => {
  if (v === undefined || v === null || v === '') return undefined
  const n = Number(v)
  return Number.isInteger(n) && n >= 1 && n <= 2147483647 ? n : undefined
}

// Geçerli tarih ise Date döndürür, "xxx" gibi geçersizse undefined (Invalid Date → Prisma 500 önlenir).
export const parseDateSafe = (v: unknown): Date | undefined => {
  if (v === undefined || v === null || v === '') return undefined
  const d = new Date(String(v))
  return Number.isNaN(d.getTime()) ? undefined : d
}
