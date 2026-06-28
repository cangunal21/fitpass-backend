// Ortak girdi doğrulama / sınırlama yardımcıları (güvenlik + veri hijyeni).

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export const isValidEmail = (e: unknown): boolean =>
  typeof e === 'string' && e.length <= 254 && EMAIL_RE.test(e.trim())

export const MIN_PASSWORD = 8

// String alanları üst sınıra kırp (DoS/şişirme önlemi). undefined ise dokunma.
export const clampStr = (v: unknown, max: number): string | undefined =>
  v === undefined || v === null ? undefined : String(v).slice(0, max)

// Geçerli tamsayı ise döndürür, değilse undefined. query/body'den gelen ID'ler için:
// "abc" → undefined olur, böylece Prisma'ya NaN gitmez (NaN filtre/lookup → 500 bug'ı önlenir).
export const parseIntSafe = (v: unknown): number | undefined => {
  if (v === undefined || v === null || v === '') return undefined
  const n = parseInt(String(v), 10)
  return Number.isNaN(n) ? undefined : n
}
