# CivicSight

**A Data-Driven Road Safety Intelligence Platform for Austin, TX**

> *The University of Texas at Austin · April 2026*

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [Repo Structure](#repo-structure)
3. [White Paper](#white-paper)
   - [Abstract](#abstract)
   - [1. The Problem](#1-the-problem)
   - [2. Approach](#2-approach)
   - [3. Data Sources](#3-data-sources)
   - [4. Dataset Construction and Feature Engineering](#4-dataset-construction-and-feature-engineering)
   - [5. Predictive Modeling](#5-predictive-modeling)
   - [6. System Architecture](#6-system-architecture)
   - [7. Testing and Model Validation](#7-testing-and-model-validation)
   - [8. Limitations and Caveats](#8-limitations-and-caveats)
   - [9. Future Work](#9-future-work)
   - [10. Conclusion](#10-conclusion)
   - [References](#references)
4. [License](#license)

---

## Quick Start

**Prerequisites:** Node.js 18+, a Mapbox API token, and a Socrata app token (optional but recommended for rate limits).

```bash
# Clone and install
git clone https://github.com/your-org/civicsight.git
cd civicsight

# Backend
cd backend
npm install
cp .env.example .env        # add MAPBOX_TOKEN and SOCRATA_TOKEN
npm run build
npm start

# Frontend (separate terminal)
cd ../frontend
npm install
cp .env.example .env        # add VITE_MAPBOX_TOKEN
npm run dev
```

The backend builds the dataset and trains the model on startup (~2–4 min depending on network). The frontend polls `/health` and renders once the server reports `ready`.

**Run tests:**
```bash
cd backend
npm test
```

---

## Repo Structure

```
civicsight/
├── backend/
│   ├── src/
│   │   ├── data/
│   │   │   ├── crashes.ts          # Socrata API ingestion
│   │   │   ├── roads.ts            # OSM Overpass API ingestion
│   │   │   ├── crosswalks.ts       # OSM crossing node detection
│   │   │   └── intersections.ts    # Mapbox Tilequery confirmation
│   │   ├── features/
│   │   │   ├── engineer.ts         # Feature extraction & standardization
│   │   │   └── buffers.ts          # Spatial join (22m / 42m buffers)
│   │   ├── model/
│   │   │   ├── ridge.ts            # Ridge regression (closed-form)
│   │   │   └── score.ts            # Safety score + explainability
│   │   ├── routes/
│   │   │   ├── health.ts
│   │   │   ├── segments.ts
│   │   │   ├── intersections.ts
│   │   │   └── whatif.ts
│   │   └── server.ts
│   └── testing/
│       └── model.test.ts           # Unit tests + A/B ablation study
├── frontend/
│   ├── src/
│   │   ├── components/
│   │   │   ├── Map.tsx             # Mapbox GL JS 3D map
│   │   │   ├── Dashboard.tsx       # Right-side risk inventory
│   │   │   ├── ScoreBreakdown.tsx  # Per-feature explanation panel
│   │   │   └── CrosswalkSim.tsx    # Drag-and-drop what-if simulator
│   │   └── App.tsx
│   └── vite.config.ts
└── README.md
```

---

## White Paper

---

### Abstract

Urban transportation planners are routinely asked to allocate safety investments across road networks that are too large and too complex to evaluate through manual inspection alone. CivicSight addresses this challenge by constructing an automated pipeline that ingests real public data about Austin's road network and crash history, trains an interpretable statistical model to identify correlates of elevated crash rates, and assigns every road segment and intersection a continuous safety score. Results are served through a geospatial API and rendered in an interactive 3D map interface with per-feature score explanations and a crosswalk counterfactual simulator. The system is designed to be transparent, explainable, and grounded entirely in publicly available data sources.

---

### 1. The Problem

Traffic fatalities and serious injuries represent one of the most persistent and preventable public health challenges in American cities. In Austin alone, thousands of vehicle crashes are recorded each year, a substantial proportion of which result in injury or death. Research in traffic safety engineering has established for decades that crash risk is strongly mediated by the physical design of roads: posted speed limits, lane configurations, the presence or absence of pedestrian infrastructure, and whether a location functions as a high-volume intersection. The mechanisms are well understood. What has remained difficult is translating that understanding into prioritized, data-supported action at the city level.

A city the size of Austin contains thousands of distinct road segments. Crash records exist in the public domain, but arrive as raw lists of GPS coordinates and incident codes—not as ranked risk inventories. Road geometry data is similarly available, but resides in separate systems with different schemas. Integrating these datasets, engineering meaningful features from them, and producing actionable spatial rankings requires sustained engineering investment that most municipal planning departments do not have the resources to sustain.

The challenge compounds when planners seek to reason about prospective interventions. A common and consequential planning question is: *if a marked crosswalk were installed at a given location, how would that change the expected crash rate?* Answering that question today typically requires commissioning a formal traffic study—a process that is slow, expensive, and ill-suited to the early stages of priority-setting. There is no existing fast-cycle, data-driven mechanism for comparing intervention options before committing capital resources.

There is also an equity dimension to this gap. The road segments most in need of safety investment are frequently located in neighborhoods that have historically received less of it. A system that surfaces risk objectively—based on data rather than on which communities have the loudest advocacy presence—has meaningful implications for equitable resource allocation.

CivicSight is designed to address each of these gaps. It is not intended to replace qualified engineering judgment or site-specific field investigation. Rather, it functions as a first-pass decision support layer: helping planners quickly identify where risk is concentrated, understand which road characteristics drive that risk, and estimate how targeted infrastructure changes might shift predicted outcomes.

---

### 2. Approach

CivicSight treats every road segment in Austin as a unit of observation. For each segment, measurable characteristics are extracted—speed limit, lane count, road classification, presence of a marked crosswalk, proximity to a confirmed intersection, and estimated traffic volume—and a statistical model is trained to identify the relationship between those characteristics and observed crash frequency. Once trained, the model can score any segment in the network and respond to counterfactual queries by varying a single feature while holding all others constant.

The approach is analogous to the automated valuation models used in real estate: just as a property estimator learns that square footage, school district, and construction age each contribute to predicted market value, CivicSight learns that speed limits, lane counts, and crosswalk presence each contribute to predicted crash incidence. And just as a valuation model can answer "what happens to this estimate if a bathroom is added?", CivicSight can answer "what happens to the predicted score if a crosswalk is added here?"

A core design requirement throughout is that the system must be auditable. Every prediction is decomposable into additive per-feature contributions, every data source is publicly accessible, and every modeling decision is documented. This transparency is not incidental—it is a prerequisite for a tool that asks city planners to trust its outputs.

---

### 3. Data Sources

#### 3.1 Crash Records

Crash data are retrieved from the City of Austin Open Data Portal via the Socrata API (dataset identifier: `y2wy-tgr5`). This dataset records every reported vehicle crash within Austin's jurisdiction, including GPS coordinates, incident date, and severity classification. Each record is treated as a distinct crash event and spatially associated with nearby road segments and intersection points through proximity buffers described in Section 4.

#### 3.2 Road Geometry

Road centerlines and attributes are obtained from OpenStreetMap (OSM) via the Overpass API. All features tagged `way["highway"]` within Austin's bounding box are retrieved, with pedestrian-only classifications excluded. OSM encodes useful metadata on most road segments—posted speed limits, lane counts, and road classification—which are parsed directly. Where attributes are absent, class-specific defaults are applied: for example, residential streets without a speed tag are assigned 25 mph, consistent with Austin's local ordinance.

#### 3.3 Crosswalk Detection

Crosswalk presence is determined through two complementary signals. First, OSM way-level tags (`crossing=marked` and related variants) are inspected on each road segment. Second, a spatial join identifies OSM nodes tagged `highway=crossing` within approximately 22 meters of a segment centerline. A segment is assigned `crosswalk_present=1` if either signal is detected.

#### 3.4 Intersection Confirmation

Candidate intersection locations are derived from OSM topology—points where two or more road ways share a vertex or exhibit elevated node degree. Each candidate is subsequently confirmed using the Mapbox Tilequery API against the `mapbox.mapbox-streets-v8` tileset, requiring at least two distinct road features within a small search radius. Candidates that fail this confirmation step are discarded, eliminating false positives arising from grade-separated crossings and OSM tagging artifacts.

**Table 1. Summary of data sources.**

| Source | Access Method | Content |
|---|---|---|
| City of Austin Open Data | Socrata API (`y2wy-tgr5`) | Historical crash records |
| OpenStreetMap | Overpass API | Road geometry & attributes |
| OSM Node Tags | Overpass API | Crosswalk node locations |
| Mapbox Tilequery | REST API | Intersection confirmation |

**Figure 1. End-to-end data pipeline.**

```
┌─────────────────────┐     ┌─────────────────────┐     ┌─────────────────────┐     ┌─────────────────────┐     ┌─────────────────────┐
│  Austin Open Data   │────▶│  OpenStreetMap /    │────▶│  Feature            │────▶│  Ridge              │────▶│  GeoJSON API        │
│  Portal             │     │  Overpass API        │     │  Engineering        │     │  Regression         │     │  Scores + Explain   │
│  Crash Records      │     │  Road Geometry       │     │  Buffers & Join     │     │  Model Training     │     │                     │
└─────────────────────┘     └─────────────────────┘     └─────────────────────┘     └─────────────────────┘     └─────────────────────┘
```

---

### 4. Dataset Construction and Feature Engineering

Each row in the training dataset corresponds to one road segment (represented as a LineString) or one confirmed intersection point. The prediction target is `accident_count`: the number of distinct crash records whose reported GPS position falls within a defined proximity buffer of the unit.

- **Road segments:** 22-meter buffer (approximately the width of a two-lane road with shoulders)
- **Intersection points:** 42-meter radius (to capture crashes occurring in the immediate approach zones)

These thresholds are heuristic and represent a deliberate tradeoff between attribution precision and coverage completeness.

**Table 2. Feature definitions, types, and sources.**

| Feature | Type | Source / Derivation |
|---|---|---|
| `traffic_volume` | Continuous | OSM highway class proxy (deterministic mapping) |
| `speed_limit` | Continuous | OSM `maxspeed` tag; class-based fallback |
| `num_lanes` | Continuous | OSM `lanes` tag; class-based fallback |
| `road_type` | Categorical | OSM `highway` value (top 12 classes, one-hot encoded) |
| `urban_density` | Continuous | Normalized local crash intensity within bounding area |
| `is_intersection` | Binary | 1 if confirmed by Mapbox Tilequery; 0 otherwise |
| `crosswalk_present` | Binary | 1 if OSM crossing tag or node within 22 m; 0 otherwise |

Continuous features—`log1p(traffic_volume)`, `speed_limit`, `num_lanes`, and `urban_density`—are standardized to zero mean and unit variance prior to model training. The `road_type` categorical variable is one-hot encoded, retaining the twelve most frequently occurring highway classes; all remaining classes collapse to an implicit reference level.

> **Notable limitation:** Traffic volume is currently proxied from OSM road classification rather than integrated from TxDOT AADT measurements. This introduces systematic error for atypical roads and represents the highest-priority data integration task for future development.

---

### 5. Predictive Modeling

#### 5.1 Model Selection

Ridge regression was selected as the core estimator. The model fits a weighted linear combination of input features to the training target, with an L2 regularization penalty that stabilizes coefficient estimates under conditions of multicollinearity—a concern given the presence of correlated road-type dummy variables.

More expressive models such as gradient-boosted trees were deliberately excluded on two grounds: first, the moderate size of the dataset does not warrant the additional model complexity; second, ridge regression produces a fully interpretable formula in which each feature carries a single coefficient, enabling the per-feature score decompositions described in Section 5.4. Black-box accuracy is an insufficient criterion for a tool intended to support consequential public planning decisions.

#### 5.2 Log-Transformed Target

Crash count distributions are right-skewed: the majority of road segments record zero or very few crashes, while a small number of high-risk intersections account for a disproportionate share of incidents. Training a linear model on raw crash counts would allow those high-count outliers to dominate the loss function, producing poor generalization across the full road network.

To address this, the model is trained on a log-transformed target:

```
y = log(1 + accident_count)
```

The additive constant ensures that zero-crash segments receive a finite target value. Predictions are converted back to crash count estimates via the inverse transformation:

```
ĉ = max(0, exp(ŷ) − 1)
```

#### 5.3 Safety Score Computation

CivicSight converts predicted crash counts into a normalized safety score on the interval [0, 1] using an exponential decay function:

```
safety_score = exp( −0.08 × ĉ )
```

A score of **1.0** corresponds to a predicted crash count of zero. Scores approach **0** as predicted crash incidence increases. The decay constant `0.08` was calibrated to distribute scores meaningfully across the observed range of Austin crash densities.

#### 5.4 Score Explainability

For every scored segment, CivicSight decomposes the log-space prediction into additive per-feature contributions. Because ridge regression is a linear model, this decomposition is exact: the total prediction equals the sum of the intercept and the product of each standardized feature value and its corresponding coefficient. Road-type one-hot contributions are aggregated into a single term for readability.

**Figure 2. Illustrative per-feature score decomposition (high-risk segment example).**

```
Feature              Contribution
────────────────────────────────────────────────
Intercept            ████████████  +0.30
Traffic Volume       ███████████   +0.28
Road Type            ███████       +0.18
Speed Limit          █████         +0.12
Crosswalk Absent     ████          +0.09
Is Intersection      █             +0.03
────────────────────────────────────────────────
                     Predicted Log Score → Safety Score: 0.31
```

---

### 6. System Architecture

#### 6.1 Backend

The backend is implemented in Node.js with TypeScript and Express. On startup, the server immediately begins accepting connections while data ingestion and model training proceed asynchronously. During this initialization window, all API endpoints return HTTP 503 with a machine-readable loading status; the frontend polls automatically and transitions upon readiness.

**Primary API endpoints:**

| Endpoint | Description |
|---|---|
| `GET /health` | Returns system readiness state: `loading \| ready \| error` |
| `GET /segments` | GeoJSON FeatureCollection of all road segments with `safety_score`, `predicted_accident_count`, per-feature explanation vector, and raw features |
| `GET /intersections?max_safety=<n>` | Intersection Points below a configurable safety score threshold |
| `POST /what-if/crosswalk` | Accepts `segment_id`; returns baseline score (`crosswalk_present=0`) and counterfactual score (`crosswalk_present=1`) |

#### 6.2 Frontend

The frontend is a React + Vite single-page application using Mapbox GL JS with:

- **Basemap:** `satellite-streets` style with 3D terrain, atmospheric fog, and building extrusions
- **Road layer:** Segments colored green → red by safety score
- **Dashboard:** Right-side panel listing at-risk intersections, filtered by an adjustable safety threshold slider
- **Score breakdown:** Per-feature contribution panel on segment selection
- **Crosswalk simulator:** Drag-and-drop what-if tool; renders a zebra crosswalk overlay at the drop location and calls `POST /what-if/crosswalk` to display before/after score change

---

### 7. Testing and Model Validation

#### 7.1 Unit Testing

The test suite in `backend/testing/model.test.ts` validates three behavioral properties using synthetic road segment data:

1. The ridge regressor fits without numerical error on well-formed input
2. The safety score function produces values strictly within [0, 1] for any non-negative predicted crash count
3. The crosswalk coefficient has the expected sign: `crosswalk_present=1` segments receive lower predicted crash counts than otherwise identical `crosswalk_present=0` segments

#### 7.2 A/B Crosswalk Ablation Study

To assess whether the crosswalk feature carries meaningful predictive signal, CivicSight conducts a systematic A/B ablation across all scored segments. Each segment is evaluated twice:

- **Condition A (baseline):** `crosswalk_present = 0`, all other features at observed values
- **Condition B (counterfactual):** `crosswalk_present = 1`, all other features at observed values

**Figure 3. A/B test design.**

```
                    ┌───────────────────────────┐
                    │    Segment Feature Vector  │
                    └─────────────┬─────────────┘
                                  │
               ┌──────────────────┴──────────────────┐
               ▼                                      ▼
  ┌────────────────────────┐          ┌────────────────────────┐
  │  Condition A           │          │  Condition B           │
  │  crosswalk_present = 0 │          │  crosswalk_present = 1 │
  └────────────┬───────────┘          └───────────┬────────────┘
               ▼                                  ▼
       Score: 0.44 (baseline)            Score: 0.61 (+38.6%)
```

The A/B test serves two purposes:

1. **Sign check:** Confirms the model has learned a directionally correct relationship—crosswalk presence should be associated with lower predicted crash counts. A sign reversal would indicate endogeneity: crosswalks installed at historically high-crash locations causing the model to learn a spurious positive association.

2. **Magnitude sanity check:** The distribution of score deltas across all segments is compared against published traffic engineering estimates. Per FHWA guidance, marked crosswalks are associated with 10–40% reductions in pedestrian-involved crash rates at mid-block locations. Score improvements in that range constitute a meaningful sanity check on model calibration.

Results from the A/B ablation confirm the expected sign across all tested segments. Condition B consistently produces lower predicted crash counts and correspondingly higher safety scores than Condition A. The mean absolute score improvement is nontrivial, indicating the crosswalk feature contributes meaningfully to predictions rather than being absorbed into noise.

> **Important:** A/B ablation on a trained observational model is not equivalent to a randomized controlled experiment. The score difference reflects a learned statistical association, not a causal treatment effect. This distinction is disclosed prominently in the application interface.

---

### 8. Limitations and Caveats

| Limitation | Detail |
|---|---|
| **Correlation ≠ causation** | The what-if simulator performs feature-level ablation, not causal inference. Confounders such as pedestrian volume, driver familiarity, and sight-line geometry are not captured. |
| **Traffic volume approximation** | `traffic_volume` is proxied from OSM road class rather than TxDOT AADT measurements, introducing systematic bias for atypical roads. |
| **OSM completeness** | Crosswalk detection and attribute inference depend on OSM contributor tagging, which varies substantially across Austin. Under-tagged segments may carry incorrect feature values. |
| **Spatial buffer heuristics** | The 22 m and 42 m proximity buffers are heuristic. At complex junctions or dense road spacing, crashes may be misattributed to adjacent features. |
| **No temporal modeling** | The model treats crash records as a static aggregate. Seasonal variation and the before/after effect of prior interventions are not modeled. |
| **No held-out evaluation** | The prototype does not partition data into training and test sets. Formal cross-validated evaluation (RMSE, MAE, Spearman rank correlation) is planned for the next development cycle. |

---

### 9. Future Work

- Integration of TxDOT AADT traffic volume measurements to replace the OSM-class proxy
- Formal train/test partitioning and cross-validated evaluation with RMSE, MAE, and Spearman rank correlation reporting
- Extension of the what-if simulator to additional infrastructure levers: speed limit changes, lane reductions, and signal timing modifications
- Incorporation of Capital Metro transit stop locations and pedestrian count data as activity-level signals
- Structured validation sessions with Austin Department of Transportation staff to assess score calibration and identify data gaps
- Exploration of Poisson regression and negative binomial GLMs as statistically more appropriate alternatives for count-distributed targets
- Temporal modeling to capture seasonal crash patterns and measure the retrospective effect of previously completed interventions

---

### 10. Conclusion

Road safety is fundamentally a data problem. The information required to identify Austin's highest-risk road segments and to reason systematically about intervention options already exists in the public domain. What has been absent is an integrated system that connects these datasets, learns from them at scale, and presents results in a form that planning professionals can interrogate and act upon.

CivicSight demonstrates that this integration is achievable with a lean, open-source technical stack and a sustained commitment to explainability. By grounding every prediction in real crash records and surfacing per-feature contributions alongside each score, the platform is designed to earn planner trust rather than demand it. The crosswalk counterfactual simulator provides a low-cost mechanism for exploring infrastructure options before committing capital resources—while clearly communicating the limitations of correlational inference.

The most consequential next step is structured engagement with Austin planning practitioners. Score validity, interface usability, and the appropriate framing of model limitations are all questions best answered through direct stakeholder feedback. CivicSight is a working prototype that establishes what is technically possible; its value as a planning tool will be determined by how well it adapts to the realities of institutional practice.

---

### References

1. City of Austin Open Data Portal. Vehicle Crash Records. Socrata dataset `y2wy-tgr5`. https://data.austintexas.gov
2. OpenStreetMap contributors. Road network data accessed via Overpass API. https://overpass-api.de
3. Mapbox. Tilequery API documentation. https://docs.mapbox.com/api/maps/tilequery
4. Hoerl, A.E. and Kennard, R.W. "Ridge Regression: Biased Estimation for Nonorthogonal Problems." *Technometrics*, 12(1), 1970.
5. Federal Highway Administration. "Pedestrian Safety Guide and Countermeasure Selection System." FHWA-SA-04-003, 2004.
6. Texas Department of Transportation. Crash Records Information System (CRIS). https://cris.dot.state.tx.us
7. Breiman, L. "Statistical Modeling: The Two Cultures." *Statistical Science*, 16(3), 2001.
8. Lord, D. and Mannering, F. "The statistical analysis of crash-frequency data: A review and assessment of methodological alternatives." *Transportation Research Part A*, 44(5), 2010.

---

> **Disclaimer:** CivicSight is an academic research prototype developed at The University of Texas at Austin. Predicted safety scores are statistical estimates derived from historical public data and do not constitute engineering assessments, legal opinions, or official municipal policy recommendations. Infrastructure decisions should be informed by qualified traffic engineers and site-specific field investigation.

---

## License

MIT License. See `LICENSE` for details.
