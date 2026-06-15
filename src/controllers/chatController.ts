import { Request, Response } from 'express'
import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// Basit rate limiting: IP başına dakikada max 5 mesaj
const rateLimitMap = new Map<string, { count: number; resetAt: number }>()

const checkRateLimit = (ip: string): boolean => {
  const now = Date.now()
  const entry = rateLimitMap.get(ip)
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + 60_000 })
    return true
  }
  if (entry.count >= 5) return false
  entry.count++
  return true
}

const SYSTEM_PROMPT = `Sen Şipşakspor platformunun yardımcı asistanısın. Şipşakspor, İstanbul'daki spor salonlarını ve dersleri tek bir platformda toplayan bir rezervasyon uygulamasıdır.

Platform hakkında bilmen gerekenler:
- Kullanıcılar yoga, pilates, boks, padel, halı saha, basketbol, HIIT, dans, yüzme, crossfit ve binicilik derslerine rezervasyon yapabilir
- Salonlar sisteme kayıt olur, admin onayladıktan sonra aktif olur
- Rezervasyon yapabilmek için kayıt olmak gerekir
- İptal politikası: 24 saat öncesine kadar tam iade, 12-24 saat arası yarım iade, 12 saatten az kala iptal edilemez
- Drop-in: basketbol, padel ve halı saha için anlık katılım sistemi var
- Liderlik tablosu: en çok ders alan kullanıcılar ve en yüksek puanlı salonlar görüntülenebilir
- Sosyal: diğer sporcuları takip edebilir, aynı ilçedeki insanları keşfedebilirsin
- Favoriler: beğendiğin salonları favorilere ekleyebilirsin
- Bekleme listesi: dolu seanslar için bekleme listesine girebilirsin, yer açılınca bildirim alırsın

Kuralların:
- Sadece Şipşakspor ve spor/sağlık konularında yardım et
- Kısa ve net cevaplar ver (max 3-4 cümle)
- Türkçe konuş, samimi ve enerjik ol
- Fiyat bilgisi için "salon sayfasını kontrol et" de, kesin fiyat verme
- Platform dışı konularda nazikçe "Ben sadece Şipşakspor konularında yardımcı olabilirim" de`

export const chat = async (req: Request, res: Response) => {
  try {
    const ip = req.ip || req.socket.remoteAddress || 'unknown'
    if (!checkRateLimit(ip)) {
      return res.status(429).json({ error: 'Çok fazla mesaj gönderdiniz. Lütfen 1 dakika bekleyin.' })
    }

    const { messages } = req.body
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'Mesaj gerekli.' })
    }

    // Son 10 mesajı al (context limiti)
    const recent = messages.slice(-10).map((m: any) => ({
      role: m.role as 'user' | 'assistant',
      content: String(m.content).slice(0, 500), // mesaj başına max 500 karakter
    }))

    const response = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 300,
      system: SYSTEM_PROMPT,
      messages: recent,
    })

    const text = response.content[0].type === 'text' ? response.content[0].text : ''
    return res.json({ reply: text })
  } catch (err) {
    console.error('Chat error:', err)
    return res.status(500).json({ error: 'Asistan şu an yanıt veremiyor, lütfen tekrar deneyin.' })
  }
}
