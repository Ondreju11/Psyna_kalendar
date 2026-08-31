# Kalendář akcí

Minimalistický generátor sdílených odkazů na události. Pořadatel vyplní údaje
akce a získá odkaz, který nabídne přidání do Apple/iCal, Google Kalendáře,
Outlooku a dalších aplikací podporujících formát `.ics`.

## Vlastnosti

- bez databáze a bez registrace,
- údaje události jsou zakódované přímo ve sdíleném odkazu,
- upozornění v `.ics` souboru,
- kompaktní odkaz bez externího zkracovače,
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

## GitHub Pages

Workflow `.github/workflows/deploy-pages.yml` sestaví a zveřejní web po každém
pushi do větve `main`. V nastavení repozitáře je potřeba jednou vybrat
**Settings → Pages → Source → GitHub Actions**.

Pro bezplatný provoz použijte veřejný GitHub repozitář. Návštěvníci dostanou
pouze adresu webu nebo zkrácený odkaz na událost, nikoliv odkaz do repozitáře.
