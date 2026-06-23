// Streak (üst üste gidilen gün/hafta) hesaplama yardımcıları.
// Türkiye saati UTC+3 (DST yok) varsayılır.

export const istanbulDayKey = (d: Date): string =>
  new Date(d.getTime() + 3 * 3600 * 1000).toISOString().slice(0, 10)

// Tarihin ait olduğu haftanın Pazartesi'si (YYYY-MM-DD, İstanbul)
export const istanbulMondayKey = (d: Date): string => {
  const shifted = new Date(d.getTime() + 3 * 3600 * 1000)
  const dow = (shifted.getUTCDay() + 6) % 7 // Pzt=0 ... Paz=6
  const monday = new Date(shifted.getTime() - dow * 86400000)
  return monday.toISOString().slice(0, 10)
}

export const istanbulHour = (d: Date): number =>
  new Date(d.getTime() + 3 * 3600 * 1000).getUTCHours()

const keyDiffDays = (a: string, b: string): number =>
  Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000)

// En uzun üst üste gün serisi
export const longestDailyStreak = (dates: Date[]): number => {
  if (dates.length === 0) return 0
  const keys = Array.from(new Set(dates.map(istanbulDayKey))).sort()
  let longest = 1, current = 1
  for (let i = 1; i < keys.length; i++) {
    if (keyDiffDays(keys[i - 1], keys[i]) === 1) current++
    else current = 1
    if (current > longest) longest = current
  }
  return longest
}

// Bugüne/düne kadar süren güncel günlük seri (kopmuşsa 0)
export const currentDailyStreak = (dates: Date[], now = new Date()): number => {
  if (dates.length === 0) return 0
  const keys = Array.from(new Set(dates.map(istanbulDayKey))).sort()
  const today = istanbulDayKey(now)
  const last = keys[keys.length - 1]
  if (keyDiffDays(last, today) > 1) return 0
  let streak = 1
  for (let i = keys.length - 1; i > 0; i--) {
    if (keyDiffDays(keys[i - 1], keys[i]) === 1) streak++
    else break
  }
  return streak
}

// Bu haftaya/geçen haftaya kadar süren güncel haftalık seri (kopmuşsa 0)
export const currentWeeklyStreak = (dates: Date[], now = new Date()): number => {
  if (dates.length === 0) return 0
  const keys = Array.from(new Set(dates.map(istanbulMondayKey))).sort()
  const thisMonday = istanbulMondayKey(now)
  const last = keys[keys.length - 1]
  if (keyDiffDays(last, thisMonday) > 7) return 0
  let streak = 1
  for (let i = keys.length - 1; i > 0; i--) {
    if (keyDiffDays(keys[i - 1], keys[i]) === 7) streak++
    else break
  }
  return streak
}
