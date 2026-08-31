# Kalendář akcí

Minimalistický generátor sdílených odkazů na události. Pořadatel vyplní údaje
akce a získá odkaz, který nabídne přidání do Apple/iCal, Google Kalendáře,
Outlooku a dalších aplikací podporujících formát `.ics`.

## Vlastnosti

- krátké veřejné odkazy přes samostatný Cloudflare Worker,
- události uložené v bezplatné Cloudflare D1 databázi,
- soukromý správcovský odkaz pro pozdější úpravy pod stejnou veřejnou adresou,
- původní kompaktní odkazy zůstávají kompatibilní a fungují jako záloha,
- upozornění v `.ics` souboru,
- časové pásmo `Europe/Prague`,
- responzivní české rozhraní,
- automatické nasazení na GitHub Pages.

## Lokální spuštění

```bash
npm install
npm run dev
```

Produkční kontrola:

```bash
npm run lint
npm run build
```

## Cloudflare Worker a D1

Backend je oddělený od webu i ostatních Cloudflare projektů. Konfigurace je v
`worker/wrangler.jsonc` a databázové migrace v `worker/migrations`.

Po přihlášení přes `npx wrangler login` lze migrace a Worker nasadit příkazy:

```bash
npm run worker:migrate
npm run worker:deploy
```

Veřejný odkaz obsahuje pouze sedmimístné ID události. Správcovský odkaz navíc
obsahuje tajný klíč ve fragmentu URL; je potřeba ho uložit a neposílat
návštěvníkům. Nové události mají ochranný denní limit 250 vytvoření, aby veřejný
formulář nemohl snadno vyčerpat bezplatnou kvótu D1.

## GitHub Pages

Workflow `.github/workflows/deploy-pages.yml` sestaví a zveřejní web po každém
pushi do větve `main`. V nastavení repozitáře je potřeba jednou vybrat
**Settings → Pages → Source → GitHub Actions**.

Pro bezplatný provoz použijte veřejný GitHub repozitář a Cloudflare Workers/D1
Free. Návštěvníci dostanou pouze krátký odkaz na událost, nikoliv odkaz do
repozitáře ani správcovský klíč.
