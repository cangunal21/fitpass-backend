import { Request, Response } from 'express'
import crypto from 'crypto'
import prisma from '../utils/prisma'
import { sendRemindersJob } from '../jobs/reminderJob'

// Kaynağa GÖMÜLÜ varsayılan YOK (adminAuth deseni) — commit'lenen 'cron-secret-2024' benzeri default,
// NODE_ENV yanlış/eksik olan bir deploy'da bu side-effect'li ucu herkese açardı. Secret yoksa HER ortamda 503.
const CRON_SECRET = process.env.CRON_SECRET || ''
const CRON_CONFIGURED = CRON_SECRET.length > 0
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return crypto.timingSafeEqual(ab, bb)
}

export const sendReminders = async (req: Request, res: Response) => {
  try {
    // CRON_SECRET set DEĞİLSE HER ortamda reddet (dahili 30-dk job zaten hatırlatmaları gönderiyor → bu uç yedek).
    if (!CRON_CONFIGURED) {
      return res.status(503).json({ error: 'Cron yapılandırılmamış.' })
    }
    const secret = req.headers['x-cron-secret']
    if (typeof secret !== 'string' || !safeEqual(secret, CRON_SECRET)) {
      return res.status(401).json({ error: 'Yetkisiz.' })
    }

    // TEK KAYNAK: sorguyu burada TEKRARLAMA. Kopya sorgu, dahili job'daki iki filtreyi (emailReminders
    // opt-out + banli kullanici) atliyordu -> bu uctan tetiklenince opt-out eden ve banli kullanicilara
    // mail gidiyordu, ayrica push hic gonderilmiyordu. Artik ayni job cagriliyor.
    const sent = await sendRemindersJob()
    return res.json({ message: `${sent} hatirlatma gonderildi.`, sent })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}
