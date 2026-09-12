# AppLynx 🐱⚡

> **Mobile Market Intelligence & App Analytics Platform**  
> 100% Free, Zero-Subscription Alternative to AppKittie, Sensor Tower, and Data.ai.

AppLynx is an open, high-performance mobile market intelligence dashboard providing daily revenue, download velocity, 30-day growth trajectories, multi-network ad creative intelligence, and customer reviews sentiment across 6,500+ top mobile apps and games.

---

## 🌟 Key Features

- **📊 Comprehensive App Library (6,570+ Apps)**: Daily estimated revenues, downloads, ranks, developer attribution, release dates, and category tags.
- **📈 High-Performance Inline SVG Sparklines**: Custom cubic bezier spline engine rendering 30-day velocity curves without heavy chart library dependencies.
- **🎯 Multi-Network Ad Intelligence**:
  - Direct integration and deep-links into official transparency centers: **Meta Ad Library (FB/IG)**, **Google Ads Transparency**, **TikTok Creative Center**, and **YouTube Video Placements**.
  - High-converting creative preview cards with platform badges, format tags, video overlays, and primary copy.
  - Interactive network filter pills (All, Meta, Google, TikTok, YouTube).
- **⭐ Auto-Loading Reviews & Sentiment Analytics**:
  - Instant loading upon drawer opening with zero required manual clicks.
  - App Rating & Sentiment Breakdown card displaying overall score, total verified ratings, positive sentiment %, and 5★–1★ progress bars.
  - Resilient multi-store fallback crawler (us, gb, ca).
- **🔍 2-Tier Stacked Table & Popover Filters**:
  - Stacked micro-typography with relative dates (2y ago, 6d ago).
  - Popover dropdown filter pills with removable active tag chips.
  - Category exclusion filters, revenue/download thresholds, and sortable headers.
- **🚀 Dual-Mode Architecture (Static Netlify + Local Backend)**:
  - **Netlify Edge**: Runs statically using data/apps.json with instant sub-2ms in-memory client-side searching, sorting, and filtering.
  - **Local Python Server**: SQLite database query engine with iTunes live search bridge and YouTube scraper.
- **🤖 Automated Daily Updates**:
  - Pre-configured GitHub Actions workflow runs every single day at **06:00 UTC**.
  - Crawls latest Apple Store top-grossing charts, recalculates daily deltas, updates data/apps.json, and commits back to GitHub.
  - Automatically triggers Netlify build hooks to keep production data 100% fresh.

---

## 🚀 Quick Start

### 1. Run Locally

#### Option A: Quick Launch (Windows)
Double-click start.bat in the project root.

#### Option B: Python Server
`ash
python server.py
`
Open http://localhost:8001 in your browser.

#### Option C: Pure Static (Any HTTP Server)
`ash
python -m http.server 8080
`

---

## 🚢 Deploy to Netlify

AppLynx is pre-configured for instant zero-configuration deployment to Netlify:

1. Push this repository to your GitHub account:
   `ash
   git remote add origin https://github.com/Ishak-ctrl-ui/applynx.git
   git branch -M main
   git push -u origin main
   `
2. Log into [Netlify](https://app.netlify.com/).
3. Click **Add new site** > **Import an existing project** > **GitHub**.
4. Select pplynx.
5. Netlify will read 
etlify.toml automatically:
   - **Publish directory**: .
   - **Build command**: *(leave blank or python export_json.py)*
6. Click **Deploy Site**. Your app analytics dashboard is live worldwide!

---

## 📁 Repository Structure

`
├── .github/workflows/
│   └── daily_update.yml    # Automated daily cron crawler (runs 06:00 UTC)
├── assets/
│   ├── css/
│   │   └── styles.css      # Dual-tone modern responsive stylesheet
│   ├── js/
│   │   └── app.js          # AppLynx client (filtering, sparklines, ads, reviews)
│   ├── img/                # Visual assets and banners
│   └── logo.png            # Custom neon-rimmed lynx silhouette mascot
├── data/
│   ├── apps.json           # Enriched static library of 6,570+ apps (Netlify data source)
│   └── appkitty.db         # SQLite historical snapshot database
├── build_daily.py          # Daily Apple crawl & delta calculator script
├── export_json.py          # Database to static JSON exporter
├── server.py               # Local Python HTTP & API server
├── netlify.toml            # Netlify hosting headers & routing configuration
├── index.html              # Main single-page application dashboard
└── README.md               # Documentation
`

---

## 📜 License

MIT License — Free for personal and commercial use.
