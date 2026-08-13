import js from '@eslint/js'
import tseslint from 'typescript-eslint'

/**
 * BACKEND LINT — üç repo arasında SÜREÇ PARİTESİ için eklendi (13 Ağu 2026).
 *
 * Web'de eslint vardı, mobilde yoktu (bugün eklendi), backend'de de YOKTU. Üstelik kodda
 * `// eslint-disable-next-line ...` yorumları duruyordu: birileri lint olduğunu varsayıp
 * susturucu yazmış, ama hiçbir zaman koşan bir lint olmamış — yani o yorumlar yıllardır
 * hiçbir şey yapmıyordu.
 *
 * DURUŞ (web/mobil ile aynı): HATALAR CI'ı kırar, bilinen borç UYARI kalır. Amaç lint'i
 * yeşile boyamak değil, YENİ kusurun sessizce girmesini engellemek.
 *
 * NEDEN TİP-FARKINDA DEĞİL: `typescript-eslint`in tip bilgisi isteyen kuralları (no-floating-
 * promises gibi) her dosya için tip çözümü yapar ve bu kod tabanında CI süresini dakikalarca
 * uzatır. Tip güvenliği zaten `tsc --noEmit` ile SIKI biçimde denetleniyor (CI'da iki ayrı
 * adım: src ve src+scripts+prisma). Lint burada tsc'nin GÖRMEDİĞİ şeyler için: ölü değişken,
 * ulaşılamaz kod, yanlış kaçış, bilinçsiz `any`.
 */
export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'prisma/migrations/**', 'coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        process: 'readonly', console: 'readonly', Buffer: 'readonly',
        __dirname: 'readonly', __filename: 'readonly', module: 'writable',
        require: 'readonly', exports: 'writable', global: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly',
        setInterval: 'readonly', clearInterval: 'readonly',
        fetch: 'readonly', URL: 'readonly', TextEncoder: 'readonly', TextDecoder: 'readonly',
      },
    },
    rules: {
      /**
       * UYARI — BİLİNEN BORÇ, ayrı bir iş.
       * Bu kod tabanında `any` çoğunlukla Express'in `Request`ine eklenen alanlarda
       * (`(req as any).userId`) ve Prisma yanıtlarının biçimlendirilmesinde. Gerçek çözüm
       * paylaşılan bir tip katmanı; tek tek `any` kovalamak yüzeysel bir temizlik olurdu.
       * (Web ikizinde de aynı gerekçeyle uyarı — 205 adet.)
       */
      '@typescript-eslint/no-explicit-any': 'warn',

      // Kullanılmayan değişken GERÇEK kusurdur (ölü kod, unutulmuş import) ama `_` ile
      // başlayanlar bilinçli olarak "kullanmıyorum" demektir (Express'in `next` parametresi gibi).
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],

      // `require` bu projede BİLEREK kullanılıyor: ağır/isteğe bağlı modüller (cloudinary,
      // chaos route'ları) istek anında yükleniyor ki bozuk yapılandırma sunucuyu düşürmesin.
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    // Test/araç betikleri: burada esneklik meşru (kurgulanmış veri, kasıtlı bozuk girdi).
    files: ['scripts/**/*.ts', 'scripts/**/*.cjs'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'warn',
      /**
       * BOŞ `catch {}` test koşucularında bilinçli bir deyimdir: "bu hatayı umursamıyorum,
       * senaryonun devamı önemli". src/ altında ise hâlâ HATA — orada bir hatayı yutuyorsan
       * gerekçesini yazmalısın (kod tabanının deyimi zaten `catch { /* sebep *\/ }`).
       */
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    // CommonJS betikleri (db-deploy, i18n taraması): modül sistemi ve global'ler farklı.
    // ESM kurallarıyla denetlemek anlamsız gürültü üretir.
    files: ['**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      // .cjs dosyaları yalnız Node'da koşar; Node global'leri burada TANIMLIDIR.
      globals: {
        require: 'readonly', module: 'writable', exports: 'writable',
        __dirname: 'readonly', __filename: 'readonly',
        process: 'readonly', console: 'readonly', Buffer: 'readonly',
      },
    },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
)
