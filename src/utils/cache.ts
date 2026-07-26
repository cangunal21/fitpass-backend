/*
 * Çok hafif in-memory cache — statik/yavaş değişen okuma uçları için (kategori, mahalle, liderlik).
 * Amaç: yük altında her isteğin DB'ye gitmesini engelleyip bağlantı havuzunu rahatlatmak.
 * Tek süreç içi; çok-instance'ta her instance kendi cache'ini tutar (statik veri için sorun değil).
 */
type Entry = { value: unknown; exp: number }
const store = new Map<string, Entry>()
// Saldırgan-kontrollü cache anahtarları (ör. liderlik ?branch=<rastgele>) belleği sınırsız şişirmesin:
// süresi dolan girdiler ASLA silinmiyordu (yalnız okumada atlanıyordu) → cap + süpürme eklendi.
const MAX_ENTRIES = 5000

export async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = store.get(key)
  if (hit && hit.exp > Date.now()) return hit.value as T
  const value = await fn()
  // Yeni girdi eklemeden önce cap aşıldıysa: önce süresi DOLMUŞ girdileri süpür; hâlâ doluysa en eskiyi at
  // (Map ekleme sırasını korur → ilk anahtar en eski).
  if (store.size >= MAX_ENTRIES) {
    const now = Date.now()
    for (const [k, v] of store) if (v.exp <= now) store.delete(k)
    while (store.size >= MAX_ENTRIES) {
      const oldest = store.keys().next().value
      if (oldest === undefined) break
      store.delete(oldest)
    }
  }
  store.set(key, { value, exp: Date.now() + ttlMs })
  return value
}

// Belirli bir anahtarı veya prefix'i geçersiz kıl (veri değişince çağrılır)
export function invalidate(prefix: string) {
  for (const k of store.keys()) if (k === prefix || k.startsWith(prefix)) store.delete(k)
}
