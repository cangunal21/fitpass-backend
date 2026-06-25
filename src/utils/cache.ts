/*
 * Çok hafif in-memory cache — statik/yavaş değişen okuma uçları için (kategori, mahalle, liderlik).
 * Amaç: yük altında her isteğin DB'ye gitmesini engelleyip bağlantı havuzunu rahatlatmak.
 * Tek süreç içi; çok-instance'ta her instance kendi cache'ini tutar (statik veri için sorun değil).
 */
type Entry = { value: unknown; exp: number }
const store = new Map<string, Entry>()

export async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = store.get(key)
  if (hit && hit.exp > Date.now()) return hit.value as T
  const value = await fn()
  store.set(key, { value, exp: Date.now() + ttlMs })
  return value
}

// Belirli bir anahtarı veya prefix'i geçersiz kıl (veri değişince çağrılır)
export function invalidate(prefix: string) {
  for (const k of store.keys()) if (k === prefix || k.startsWith(prefix)) store.delete(k)
}
