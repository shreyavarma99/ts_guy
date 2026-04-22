# CivicSight

A data-driven road safety intelligence platform for Austin, TX.

Built with Node.js, TypeScript, React, and Mapbox GL JS. Uses real public crash data from the City of Austin Open Data Portal and road geometry from OpenStreetMap to score every road segment and intersection in Austin by predicted crash risk.

---

## 📄 White Paper

Full technical documentation, modeling methodology, and system design:

**[→ Download White Paper (PDF)](./CivicSight_WhitePaper.pdf)**

---

## Quick Start

```bash
# Backend
cd backend && npm install && npm start

# Frontend
cd frontend && npm install && npm run dev
```

Add your `MAPBOX_TOKEN` and `SOCRATA_TOKEN` to `backend/.env` before starting.

---

## Stack

- **Backend:** Node.js · TypeScript · Express
- **Frontend:** React · Vite · Mapbox GL JS
- **Model:** Ridge Regression (closed-form)
- **Data:** Austin Open Data Portal · OpenStreetMap · Mapbox Tilequery

---

*Academic research prototype — The University of Texas at Austin, 2026*
