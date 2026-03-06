# Syft Backend API

Node.js + Express + PostgreSQL (PostGIS) backend for the Syft deal-discovery app.

## Quick start (local)

```bash
# 1. Install dependencies
npm install

# 2. Copy env template and fill in your values
cp .env.example .env

# 3. Apply the database schema (requires a running PostgreSQL with PostGIS)
npm run db:migrate

# 4. Start dev server (auto-reloads on file change)
npm run dev
```

## Deploy to Railway

1. Push this folder to a GitHub repo
2. Create a new project on [Railway](https://railway.app)
3. Add a **PostgreSQL** service — Railway sets `DATABASE_URL` automatically
4. Add the repo as a service — Railway detects Node and runs `node server.js`
5. Set env vars in Railway's dashboard (see `.env.example`)
6. Done — Railway gives you a public HTTPS URL

## API endpoints

### Auth
| Method | Path | Description |
|--------|------|-------------|
| POST | `/auth/signup` | Email + password sign up |
| POST | `/auth/login` | Email + password sign in |
| POST | `/auth/apple` | Apple Sign In (iOS identity token) |
| POST | `/auth/google` | Google Sign In (ID token) |
| GET | `/auth/me` | Get current user *(auth required)* |
| PATCH | `/auth/me` | Update display name / role *(auth required)* |

### Deals
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/deals/nearby?lat=&lng=&radius=` | Get deals near a location |
| GET | `/api/deals/:id` | Get a single deal |
| POST | `/api/deals` | Create a deal *(business only)* |
| PATCH | `/api/deals/:id` | Update a deal *(business only)* |
| DELETE | `/api/deals/:id` | Delete a deal *(business only)* |
| POST | `/api/deals/:id/redeem` | Redeem a deal *(auth required)* |
| GET | `/api/deals/saved/list` | List saved deals *(auth required)* |
| POST | `/api/deals/:id/save` | Save a deal *(auth required)* |
| DELETE | `/api/deals/:id/save` | Unsave a deal *(auth required)* |

### Businesses
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/businesses/mine` | List your businesses *(business only)* |
| POST | `/api/businesses` | Register a business *(auth required)* |
| PATCH | `/api/businesses/:id` | Update a business *(owner only)* |

### System
| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check (DB ping) |

## Connecting the Syft iOS app

Replace the `FIREBASE_ENABLED` flag and `SyftDeals.getNearby()` call with:

```js
const API = 'https://your-railway-url.up.railway.app';

async function loadNearbyDeals(lat, lng) {
  const res = await fetch(`${API}/api/deals/nearby?lat=${lat}&lng=${lng}&radius=2000`);
  const { deals } = await res.json();
  return deals;
}
```

Auth calls follow the same pattern — POST to `/auth/login` or `/auth/apple`, store the returned `token` in localStorage, and send it as `Authorization: Bearer <token>` on protected requests.
