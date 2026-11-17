# AdelCo Inc. — Metal Quote & Catalog

Lokalna web aplikacija za katalog metalnih proizvoda, cjenovnik boja, izradu ponuda (quote builder) i upravljanje izdatim ponudama.

## Tehnologije

- **Frontend**: React 19, Vite, Tailwind CSS v4, Lucide Icons
- **Backend**: Node.js, Express, tsx
- **Baza**: SQLite (`better-sqlite3`)
- **Eksporti**: PDF (`pdfkit`), Excel (`exceljs`), Slike (`sharp`), ZIP arhive (`adm-zip`)

## Pokretanje aplikacije

### 1. Instalacija zavisnosti
```bash
npm install
```

### 2. Razvojni mod (Development)
```bash
npm run dev
```
Aplikacija je dostupna na [http://localhost:3000](http://localhost:3000).

### 3. Produkcijski mod (Production Build & Start)
```bash
npm run build
npm start
```
