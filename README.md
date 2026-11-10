# autoteď.cz – autodoprava

Jednoduchý responzivní web autoteď.cz zaměřený především na dodávkovou autodopravu do 3,5 t z Chomutova po celé ČR. Stěhování s pomocí při nošení a vyklízení jsou doplňkové služby. Návštěvníka vede od stručného představení autodopravy přes tři kroky objednání a ukázkový ceník až k poptávkovému formuláři. Kontakty, ceny, marketing, služby i vozový park se upravují v `src/data/marketing.json`. SMTP přihlašovací údaje jsou záměrně oddělené v serverovém prostředí `.env`.

## Ukázková verze

Web je nyní v režimu `demoMode` v `src/data/marketing.json`. Kontakty, jméno a IČO, ceny, dodavatelé, lhůty a parametry vozidla jsou fiktivní; výrazné upozornění se zobrazuje na webu i v zásadách. Místní SVG obrázky jsou vlastní ukázkové ilustrace, nikoli fotografie skutečné firmy nebo vozidel. Režim zároveň brání indexaci vyhledávači, nepřidává smyšlená strukturovaná data, neaktivuje ukázkový telefon/e-mail a formulář pouze ověří vyplnění — data nikam neposílá. Server navíc odmítne poptávku i při přímém volání API, i kdyby bylo SMTP nastavené.

Ukázková čísla, identifikační údaje ani obrázky nepoužívejte v produkci. Před zveřejněním nahraďte je ověřenými údaji a vlastními fotografiemi a teprve poté nastavte `demoMode` na `false`.

## Spuštění

Je potřeba Node.js 20.6 nebo novější.

V kořenové složce projektu nainstalujte závislosti a vytvořte místní soubor s nastavením:

```powershell
npm install
Copy-Item .env.example .env
```

Spusťte web i s nevyplněným SMTP nastavením:

```powershell
npm start
```

Web poběží na `http://localhost:3000`. V současném demo režimu formulář pouze otestuje vyplnění a nic neodešle. Po doplnění reálných údajů a vypnutí `demoMode` vyplňte v `.env` nastavení SMTP, aby bylo možné přijímat poptávky e-mailem. Samotný statický server (`python -m http.server`) nestačí, protože neumí přijímat poptávky ani odesílat e-maily.

## GitHub Pages – statická ukázka

Pro sestavení statické ukázky spusťte `npm run build`. Výstup bude ve složce `dist/`. Build obsahuje jen stránky, veřejné obrázky, CSS, JavaScript a webovou konfiguraci; server, SMTP nastavení ani `.env` do něj nekopíruje.

Repozitář lze publikovat přes GitHub Pages: nahrajte zdrojový projekt na GitHub do větve `main`, v **Settings → Pages** vyberte **GitHub Actions** a workflow web sestaví a nasadí. Workflow podporuje také ruční spuštění přes **Actions**. Cesty se nastaví i pro adresu projektu ve tvaru `uzivatel.github.io/nazev-repozitare`.

GitHub Pages nepodporuje Node.js server ani API `/api/quote`. Proto je tento build určen pouze pro současnou ukázkovou konfiguraci (`demoMode: true`); formulář na Pages nic neodesílá. Pro skutečné e-mailové poptávky je potřeba nasadit `server.js` na hosting podporující Node.js a nastavit SMTP. Statický build se záměrně zastaví, pokud je `demoMode` vypnutý.

## Před zveřejněním

Nahraďte ukázkový obsah v `src/data/marketing.json` skutečným ověřeným telefonem, e-mailem, údaji podnikající osoby, cenami, podmínkami, parametry vozidla a skutečnými údaji o ochraně soukromí. Vlastní fotografie uložte do `public/images` a aktualizujte cesty v konfiguraci. Ověřte zásady ochrany osobních údajů podle skutečných postupů a poskytovatelů. Nastavte skutečnou adresu webu v `siteUrl`, připravte SMTP údaje přes `.env` nebo bezpečné proměnné hostingu a otestujte poptávkový formulář. Teprve poté vypněte `demoMode`; tím se aktivuje telefonní odkaz, e-mailový odkaz a běžná SEO indexace.

SMTP heslo nikdy nevkládejte do `marketing.json` ani front-endového kódu. Bez nakonfigurovaného SMTP API vrátí srozumitelnou chybu a formulář nezobrazí falešné potvrzení o úspěšném odeslání.

## Struktura

- `index.html` – sémantická kostra stránky a přístupné prvky.
- `ochrana-osobnich-udaju.html` – ukázková stránka zásad ochrany osobních údajů s viditelným upozorněním na fiktivní údaje.
- `src/styles/style.css` – vizuální styl, responzivní rozvržení a animace.
- `src/scripts/script.js` – vykreslení obsahu, ceníku ke stažení, navigace, formuláře, metadat a galerie.
- `src/scripts/privacy.js` – načítání identifikačních a provozních údajů do zásad ochrany osobních údajů.
- `src/data/marketing.json` – editovatelný obsah, SEO a provozní nastavení.
- `public/images/` – lokální ukázkové SVG ilustrace a prostor pro budoucí vlastní fotografie.
- `server.js` – statický web, API `/api/quote` a SMTP doručení poptávky.
- `.env.example` – vzor nastavení serveru a SMTP bez skutečných přístupových údajů.
- `package.json`, `package-lock.json` – závislosti a reprodukovatelná instalace.
- `tests/server.test.js` – testy validace, sestavení e-mailu a API.
- `marketing.md` – klíčová slova pro stěhování a doplňkovou přepravu, lokální SEO, návrhy reklam a obsah pro sociální sítě.
- `public/robots.txt`, `public/sitemap.xml` – soubory pro crawlery.

## SEO

Titulky, popis, Open Graph metadata, kontakty, služby a strukturovaná data Schema.org se sestavují z `src/data/marketing.json`. Node server generuje `robots.txt` a `sitemap.xml` z jednoho nastavení `siteUrl` a zpřístupňuje je spolu s favicon v kořeni webu.
