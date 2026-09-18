# Kalendář akcí

Minimalistický generátor sdílených odkazů na události. Pořadatel vyplní údaje
akce a získá odkaz, který nabídne přidání do Apple/iCal, Google Kalendáře,
Outlooku a dalších aplikací podporujících formát `.ics`.

## Vlastnosti

- krátké veřejné odkazy přes samostatný Cloudflare Worker,
- události uložené v bezplatné Cloudflare D1 databázi,
- soukromý správcovský odkaz pro pozdější úpravy pod stejnou veřejnou adresou,
- přehled 2–12 akcí pod jedním odkazem pro newslettery; čtenář si vybere akce k importu,
- původní kompaktní odkazy zůstávají kompatibilní a fungují jako záloha,
- denní, týdenní, měsíční či roční opakování do zvoleného data a až pět upozornění v `.ics` souboru,
- volitelné našeptávání adres a míst přes Mapy.com; ruční vyplnění funguje vždy,
- časové pásmo `Europe/Prague`,
- responzivní české rozhraní,
- automatické nasazení na GitHub Pages pod `akce.psynaffuk.cz`.

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
návštěvníkům. Nové události mají ochranný denní limit 20 vytvoření, aby veřejný
formulář nemohl snadno vyčerpat bezplatnou kvótu D1. Stejný limit se vztahuje i
na vytváření společných přehledů. Odkaz přehledu má tvar
`https://kalendar.psynaffuk.cz/s/ABC1234`. Samotný přehled má pevný seznam
akcí, ale úpravy jednotlivých akcí se po otevření projeví i v přehledu.

Soubor `.ics` pro uložené akce generuje vlastní Worker, aby zachoval pražský
čas při opakování a více upozornění. Přímé odkazy Google/Outlook u jednorázové
akce nepřenášejí nastavení upozornění. Kalendářové aplikace mohou upozornění
z `.ics` zpracovat rozdílně, proto si je má příjemce po importu zkontrolovat.
Již importovaný `.ics` soubor se po pozdější úpravě akce automaticky
neaktualizuje; příjemce musí akci znovu přidat či upravit ve svém kalendáři.

Našeptávání Mapy.com vyžaduje vlastní bezplatný API projekt a klíč. Vytvořte
projekt v [portálu Mapy.com](https://developer.mapy.com/cs/rest-api/jak-zacit/),
ponechte placenou spotřebu vypnutou a klíč nastavte jako Cloudflare Worker
secret `MAPY_API_KEY` (například přes `npx wrangler secret put MAPY_API_KEY`
ve složce `worker`). Klíč nikdy nevkládejte do Git repozitáře ani veřejného
frontendového nastavení. Worker má navíc limit 500 dotazů na našeptávání za
den a odpovědi neukládá. Bez klíče zůstává pole „Místo“ běžným textovým
polem. [Ceník a bezplatný limit Mapy.com](https://developer.mapy.com/cs/cena/).

Nové veřejné odkazy mají tvar `https://kalendar.psynaffuk.cz/ABC1234`. Původní
odkazy na `workers.dev/e/ABC1234` zůstávají funkční. Tvůrčí rozhraní běží na
GitHub Pages pod `https://akce.psynaffuk.cz/`; subdoména `kalendar.psynaffuk.cz`
patří Workeru a slouží pro veřejné odkazy a API.

## GitHub Pages

Workflow `.github/workflows/deploy-pages.yml` sestaví a zveřejní web po každém
pushi do větve `main`. V nastavení repozitáře je potřeba jednou vybrat
**Settings → Pages → Source → GitHub Actions**.

Pro bezplatný provoz použijte veřejný GitHub repozitář a Cloudflare Workers/D1
Free. Návštěvníci dostanou pouze krátký odkaz na událost, nikoliv odkaz do
repozitáře ani správcovský klíč.
