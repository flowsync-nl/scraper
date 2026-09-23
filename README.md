# Vacancy Scraper API

API voor het detecteren en extraheren van vacatures van bedrijfswebsites.

## Setup

```bash
# Install dependencies
npm install

# Install Playwright browsers
npx playwright install chromium

# Copy environment file
cp .env.example .env
# Fill in your API keys in .env

# Run development server
npm run dev
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Claude API key (required) |
| `ANTHROPIC_MODEL` | Vacancy extraction model (optional, default `claude-haiku-4-5-20251001`) |
| `REDIS_URL` | Redis connection URL (optional, uses memory cache if not set) |
| `PORT` | Server port (default: 3000) |
| `API_KEY` | Your API key for authentication |

## API Usage

### Scrape vacancies

```bash
curl -X POST http://localhost:3000/api/scrape \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{"domain": "example.nl"}'
```

### Response

```json
{
  "domain": "example.nl",
  "hasVacancies": true,
  "vacancyCount": 3,
  "vacancies": [...],
  "source": {
    "platform": "recruitee",
    "careerPageUrl": "https://example.recruitee.com",
    "method": "parser"
  },
  "cached": false,
  "scrapedAt": "2026-01-23T12:00:00Z"
}
```

## Deployment (Forge)

1. Create a new site on Forge
2. Set Node.js version to 20+
3. Add environment variables
4. Deploy script:

```bash
npm install
npx playwright install chromium
npm run build
npm start
```
