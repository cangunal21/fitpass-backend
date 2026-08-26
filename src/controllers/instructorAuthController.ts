import { Request, Response } from 'express'
import bcrypt from 'bcryptjs'
import crypto from 'crypto'
import prisma from '../utils/prisma'
import { generateToken } from '../utils/jwt'
import { isValidEmail, MIN_PASSWORD, clampStr } from '../utils/validate'
import { sendInstructorPasswordResetEmail } from '../utils/email'
import { invalidate } from '../utils/cache'
import { issuePanelRefreshToken, revokeAllPanelRefreshTokens, rotatePanelAccessToken, revokePanelRefreshToken } from '../utils/panelRefreshToken'
import { eksikZorunluOnaylar, eksikOnayMesaji, onaylariKaydet } from '../utils/consent'

// Eğitmen (instructor) auth realm — venue realm'inin aynası. GÜVENLİK: token payload'ı SADECE
// {instructorId, email, role:'instructor'} taşır; venueId ASLA eklenmez → salon finans/check-in
// uçlarına (venueAuth, role='venue') yapısal olarak erişemez.

// Hesap bulunamayınca da bcrypt.compare çalıştırıp zamanlamayı eşitlemek için sabit dummy hash
// (kullanıcı-enumeration timing oracle'ını kapatır).
const DUMMY_HASH = bcrypt.hashSync('sipsakspor-timing-guard', 12)

// EĞİTMEN GİRİŞİ
export const instructorLogin = async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body
    if (!email || !password) {
      return res.status(400).json({ error: 'Email ve şifre gerekli.' })
    }
    // email @unique DEĞİL (prod db push için) → findFirst + orderBy (deterministik); küçük harf saklanır.
    // Tekillik uygulama düzeyinde (create/update/invite dupe kontrolü + DB partial unique index) sağlanır.
    const instructor = await prisma.instructor.findFirst({ where: { email: String(email).toLowerCase().trim() }, orderBy: { id: 'asc' } })
    if (!instructor || !instructor.passwordHash) {
      await bcrypt.compare(String(password), DUMMY_HASH).catch(() => {}) // timing'i eşitle (enumeration önleme)
      return res.status(401).json({ error: 'Email veya şifre hatalı.' })
    }
    const isValid = await bcrypt.compare(password, instructor.passwordHash)
    if (!isValid) {
      return res.status(401).json({ error: 'Email veya şifre hatalı.' })
    }
    if (!instructor.isActive) {
      return res.status(403).json({ error: 'Eğitmen hesabınız aktif değil. Salonunuzla iletişime geçin.' })
    }
    // MEKÂNSIZ (bireysel) HOCA: bağlı olduğu salon YOK, dolayısıyla salon kapısı da yok.
    // Onaysızken de GİRİŞ YAPABİLİR — salon tarafında da böyle (venueLogin onaysız salonu
    // içeri alıp yanıtta `isApproved` döner, panel "onay bekliyor" ekranını çizer). Aksi halde
    // başvurusunu bekleyen hoca durumunu göremez ve profilini tamamlayamazdı.
    // Onay kapısı SATIŞ tarafındadır: ders/seans açma isApproved ister (instructorPortalController).
    if (instructor.venueId != null) {
      // SALON DURUM KAPISI: eğitmen bir salona bağlı; salon askıya alınmış/onayı geri alınmışsa
      // eğitmen de yeni token üretememeli (aksi halde donmuş salonun eğitmeni süresiz iş yapmaya
      // devam eder — check-in salon-durum bulgusunun kök nedeni buydu).
      const vGate = await prisma.venue.findUnique({ where: { id: instructor.venueId }, select: { isApproved: true, isActive: true, isSuspended: true } })
      if (!vGate || !vGate.isApproved || !vGate.isActive || vGate.isSuspended) {
        return res.status(403).json({ error: 'Bağlı olduğunuz salon şu anda aktif değil.' })
      }
    }
    const token = generateToken({ instructorId: instructor.id, email: instructor.email || '', role: 'instructor' })
    // Access token artık 1 saat (eskiden 7 gün) → oturum kesintisiz sürsün diye refresh jetonu.
    const refreshToken = await issuePanelRefreshToken({ instructorId: instructor.id })
    return res.json({
      refreshToken,
      message: 'Giriş başarılı!',
      token,
      instructor: {
        id: instructor.id,
        fullName: instructor.fullName,
        email: instructor.email,
        avatarUrl: instructor.avatarUrl,
      },
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// EĞİTMEN ŞİFRE SIFIRLAMA TALEBİ (enumeration-safe)
export const instructorForgotPassword = async (req: Request, res: Response) => {
  try {
    const { email } = req.body
    const instructor = await prisma.instructor.findFirst({ where: { email: String(email || '').toLowerCase().trim() }, orderBy: { id: 'asc' } })
    // GÜVENLİK: forgot-password YALNIZCA zaten girişi kurulmuş (passwordHash olan) hesap için token
    // üretir. Aksi halde davet-kapısı atlatılıp self-provisioning yapılabilirdi (salon daveti olmadan
    // login kurma). İlk şifre belirleme yalnız salon davetiyle olur. Enumeration-safe: yine aynı mesaj.
    if (!instructor || !instructor.email || !instructor.passwordHash) {
      return res.json({ message: 'Email gönderildi' })
    }
    const token = crypto.randomBytes(32).toString('hex')
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000)
    await prisma.instructorPasswordResetToken.create({ data: { instructorId: instructor.id, token, expiresAt } })
    sendInstructorPasswordResetEmail(instructor.email, instructor.fullName, token).catch(err =>
      console.error('Instructor reset mail gönderilemedi:', err)
    )
    return res.json({ message: 'Email gönderildi' })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// EĞİTMEN ŞİFRE BELİRLE (hem DAVET hem RESET aynı token mekanizması + aynı sayfa)
export const instructorSetPassword = async (req: Request, res: Response) => {
  try {
    const { token } = req.body
    const password = req.body.password
    // typeof guard: string olmayan password bcrypt.hash'i patlatıp 500 vermesin (temiz 400)
    if (!token || typeof password !== 'string' || password.length < MIN_PASSWORD) {
      return res.status(400).json({ error: `Şifre en az ${MIN_PASSWORD} karakter olmalı.` })
    }
    const resetToken = await prisma.instructorPasswordResetToken.findFirst({
      where: { token, used: false, expiresAt: { gt: new Date() } },
    })
    if (!resetToken) {
      return res.status(400).json({ error: 'Geçersiz veya süresi dolmuş link.' })
    }
    const passwordHash = await bcrypt.hash(password, 12)
    // CAS + parola yazması TEK TRANSACTION. Eskiden token used=true AYRI commit'leniyor, sonra
    // instructor.update AYRI yazılıyordu → ikinci adım başarısız olursa token YANMIŞ ama parola
    // yazılmamış olur: link ölür, eğitmen parolayı bir daha belirleyemez. Atomik olunca ikisi
    // birlikte olur ya da hiç olmaz.
    const ok = await prisma.$transaction(async (tx) => {
      const claimed = await tx.instructorPasswordResetToken.updateMany({
        where: { id: resetToken.id, used: false },
        data: { used: true },
      })
      if (claimed.count === 0) return false
      // passwordChangedAt: bkz. Venue — eğitmen token'ı da 7 gün, refresh yok.
      await tx.instructor.update({ where: { id: resetToken.instructorId }, data: { passwordHash, inviteStatus: 'active', passwordChangedAt: new Date() } })
      return true
    })
    if (!ok) return res.status(400).json({ error: 'Geçersiz veya süresi dolmuş link.' })
    await revokeAllPanelRefreshTokens({ instructorId: resetToken.instructorId })
    invalidate(`instructorActive:${resetToken.instructorId}`) // eski token'lar ANINDA geçersiz olsun
    return res.json({ message: 'Şifre belirlendi. Artık giriş yapabilirsiniz.' })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// EĞİTMEN PROFİLİM (instructorAuth) — FİNANS YOK. venue yalnız id+name.
export const getInstructorMe = async (req: Request, res: Response) => {
  try {
    const instructorId = (req as any).instructorId
    const instructor = await prisma.instructor.findUnique({
      where: { id: instructorId },
      select: {
        id: true, fullName: true, specialty: true, specialtyEn: true,
        bio: true, bioEn: true, avatarUrl: true, phone: true, email: true,
        avgRating: true, totalReviews: true, verified: true, isActive: true,
        // MEKÂNSIZ (bireysel) hocanın portalı "onay bekliyor" durumunu çizebilsin diye:
        // `venueId === null` ise satış kapısı `isApproved`'dır (salon paneliyle simetrik —
        // orada da venueLogin `isApproved` döndürüp panel bekleme ekranını gösteriyor).
        venueId: true, isApproved: true, rejectionReason: true,
        venue: { select: { id: true, name: true } },
      },
    })
    if (!instructor) return res.status(404).json({ error: 'Eğitmen bulunamadı.' })
    return res.json({ instructor })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// ACCESS TOKEN YENİLE (eğitmen) — bkz. venueRefresh; aynı gerekçe, aynı davranış.
export const instructorRefresh = async (req: Request, res: Response) => {
  try {
    const cift = await rotatePanelAccessToken(String(req.body?.refreshToken || ''))
    if (!cift) return res.status(401).json({ error: 'Oturum süresi doldu, lütfen tekrar giriş yapın.' })
    return res.json({ token: cift.token, refreshToken: cift.refreshToken }) // bkz. venueRefresh — jeton döndürülür

  } catch (err) {
    console.error('instructorRefresh error:', err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// ÇIKIŞ (eğitmen) — refresh jetonunu iptal et.
export const instructorLogout = async (req: Request, res: Response) => {
  try {
    await revokePanelRefreshToken(String(req.body?.refreshToken || ''))
    return res.json({ message: 'Çıkış yapıldı.' })
  } catch (err) {
    console.error('instructorLogout error:', err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MEKÂNSIZ (BİREYSEL) EĞİTMEN KAYDI
// ─────────────────────────────────────────────────────────────────────────────
// Bugüne kadar eğitmen YALNIZCA bir salon tarafından davet edilerek var olabiliyordu; kendi
// kaydolma yolu HİÇ YOKTU. Online ders satacak mekânsız hoca için bu yol gerekli.
//
// Salon kaydının (venueRegister) aynası: kayıt SERBEST, yayına çıkmak ADMİN ONAYINA bağlı.
// Onaysız hesap giriş yapabilir (durumunu görsün, profilini tamamlasın) ama ders/seans AÇAMAZ —
// o kapı instructorPortalController.satisKapisi'nde.
//
// POST /api/instructor/register
export const instructorRegister = async (req: Request, res: Response) => {
  try {
    const { email, password, fullName, specialty, bio, phone, onaylar } = req.body
    if (!email || !password || !fullName) {
      return res.status(400).json({ error: 'Ad soyad, e-posta ve şifre zorunludur.' })
    }

    // Sözleşme onayı hesap açılmadan ÖNCE doğrulanır (bkz. utils/consent.ts).
    const eksikOnay = eksikZorunluOnaylar('instructor', onaylar)
    if (eksikOnay.length) {
      return res.status(400).json({ error: eksikOnayMesaji(eksikOnay), eksikOnaylar: eksikOnay })
    }
    if (!isValidEmail(email)) return res.status(400).json({ error: 'Geçerli bir e-posta girin.' })
    if (String(password).length < MIN_PASSWORD) {
      return res.status(400).json({ error: `Şifre en az ${MIN_PASSWORD} karakter olmalı.` })
    }

    const normalized = String(email).trim().toLowerCase()

    // Instructor.email'de DB tekilliği YOK (şema yorumuna bakınız: prod db push veri-kaybı
    // uyarısına takılmamak için uygulama düzeyinde tutuluyor) → burada da uygulama düzeyinde
    // kontrol ediyoruz. Yarış hâlinde iki kayıt oluşabilir; login findFirst kullandığı için
    // ikincisi giriş yapamaz. Gerçek çözüm kolona unique index; ödeme turunda ele alınacak.
    const existing = await prisma.instructor.findFirst({
      where: { email: { equals: normalized, mode: 'insensitive' } },
      select: { id: true },
    })
    if (existing) {
      // Salon tarafında olduğu gibi AÇIK mesaj: bu bir hesap-numaralandırma yüzeyi değil,
      // e-postanın kayıtlı olduğunu zaten "şifremi unuttum" da söylüyor ve kullanıcının
      // "neden kaydolamıyorum" diye takılmaması daha önemli.
      return res.status(409).json({ error: 'Bu e-posta ile kayıtlı bir eğitmen zaten var.' })
    }

    const passwordHash = await bcrypt.hash(String(password), 12)
    const instructor = await prisma.instructor.create({
      data: {
        // venueId YOK — mekânsız hocayı tanımlayan şey tam olarak bu.
        fullName: clampStr(fullName, 80) || '',
        email: normalized,
        phone: clampStr(phone, 30) || null,
        specialty: clampStr(specialty, 200) || null,
        bio: clampStr(bio, 1000) || null,
        passwordHash,
        inviteStatus: 'active', // davetle değil kendi kaydıyla geldi
        isActive: true,
        isApproved: false,      // yayına çıkış admin onayında
        submittedAt: new Date(),
      },
      select: { id: true, fullName: true, email: true, isApproved: true },
    })

    // Onay kaydı — hesap açıldıktan HEMEN sonra, ispat yükü bizde olduğu için.
    await onaylariKaydet(req, 'instructor', instructor.id, onaylar)

    // Bilerek TOKEN DÖNMÜYOR: kullanıcı kayıttan sonra giriş ekranına gider. Kayıt yanıtında
    // oturum açmak, e-posta doğrulaması olmayan bir realm'de hesabı doğrudan kullanılabilir
    // kılardı; salon tarafı da aynı şekilde çalışıyor.
    return res.status(201).json({
      message: 'Başvurunuz alındı. Onaylandığında ders ekleyebileceksiniz.',
      instructor,
    })
  } catch (err) {
    console.error('instructorRegister error:', err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}
