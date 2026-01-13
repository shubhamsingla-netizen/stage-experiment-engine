# Stage Experiment Engine - Backend

Automated re-engagement experiment engine that learns what works.

## How It Works

```
┌─────────────────────────────────────────────────────────────────────┐
│                         DATA FLOW                                    │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│   AMPLITUDE                EXPERIMENT ENGINE              CLEVERTAP  │
│   ─────────                ─────────────────              ────────── │
│                                                                      │
│   User abandons    ───────►  Receives webhook                        │
│   checkout                   Selects best combo                      │
│                              Generates message    ───────►  Sends    │
│                              Schedules delivery              Push/   │
│                                                              WhatsApp│
│                                                                      │
│   ◄─────────────────────────────────────────────────────────────────│
│                                                                      │
│   User converts    ◄───────  Tracks conversion                       │
│   (trial starts)             Updates combo stats                     │
│                              Learns what works                       │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

## Quick Start

### 1. Install Dependencies

```bash
cd backend
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
# Edit .env with your CleverTap credentials
```

### 3. Start Server

```bash
npm start
# or for development with auto-reload:
npm run dev
```

### 4. Test It

```bash
# Trigger a test experiment
curl -X POST http://localhost:3001/api/trigger \
  -H "Content-Type: application/json" \
  -d '{"user_id": "test_user_123", "cohort": "checkout_abandoners"}'

# Check stats
curl http://localhost:3001/api/stats
```

## Connect to Amplitude

### Step 1: Create Amplitude Webhook

1. Go to Amplitude → Data Destinations → Add Destination
2. Select "Webhook"
3. Configure:
   - **URL**: `https://your-server.com/webhook/amplitude`
   - **Events**: Select these events:
     - `checkout_abandoned`
     - `payment_failed`
     - `paywall_viewed`

### Step 2: Event Properties

Make sure your events include these properties:
```json
{
  "event_type": "checkout_abandoned",
  "user_id": "usr_123",
  "event_properties": {
    "region": "Bihar",
    "language": "Bhojpuri",
    "show_name": "Aashram",
    "plan_viewed": "199"
  }
}
```

## Connect to CleverTap

### Step 1: Get Credentials

1. Go to CleverTap Dashboard → Settings → Project
2. Copy:
   - Account ID
   - Passcode

### Step 2: Set Up Conversion Tracking

Create a CleverTap webhook to track when users convert:

1. Go to CleverTap → Engage → Webhooks
2. Create webhook for "trial_activated" event
3. Point to: `https://your-server.com/webhook/converted`
4. Payload:
```json
{
  "user_id": "$Identity",
  "experiment_id": "$event.experiment_id"
}
```

## API Reference

### Webhooks (Incoming)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/webhook/amplitude` | POST | Receives user events from Amplitude |
| `/webhook/opened` | POST | Track when message is opened |
| `/webhook/converted` | POST | Track when user converts |

### API (Outgoing)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/api/stats` | GET | Get experiment statistics |
| `/api/trigger` | POST | Manually trigger an experiment |

### Trigger Experiment

```bash
POST /api/trigger
{
  "user_id": "usr_123",
  "cohort": "checkout_abandoners",
  "attributes": {
    "region": "Bihar",
    "language": "Bhojpuri"
  }
}
```

### Stats Response

```json
{
  "summary": {
    "total_experiments": 1250,
    "total_opened": 450,
    "total_converted": 87,
    "overall_cvr": "6.96%"
  },
  "top_combinations": [
    {
      "combo_key": "2min|whatsapp|scarcity|rupee_1_trial",
      "sent_count": 45,
      "converted_count": 8,
      "cvr": 17.78
    }
  ],
  "worst_combinations": [...]
}
```

## How the AI Learns

The engine uses an **Epsilon-Greedy Multi-Armed Bandit** algorithm:

1. **80% Exploit**: Use combos that have worked best historically
2. **20% Explore**: Try new combos to discover better options

Over time, the system automatically:
- Identifies winning combinations
- Stops using losing combinations
- Adapts to changing user behavior

## Cohorts Supported

| Cohort | Trigger Event | Default Strategy |
|--------|---------------|------------------|
| `checkout_abandoners` | `checkout_abandoned` | Urgent, scarcity, discounts |
| `payment_failed` | `payment_failed` | Helpful, retry-focused |
| `paywall_bouncers` | `paywall_viewed` (3+ times) | Free value, social proof |

## Deployment

### Option 1: Railway (Recommended)

```bash
# Install Railway CLI
npm install -g railway

# Login and deploy
railway login
railway init
railway up
```

### Option 2: Render

1. Connect GitHub repo
2. Set environment variables
3. Deploy

### Option 3: Your Own Server

```bash
# Use PM2 for production
npm install -g pm2
pm2 start server.js --name experiment-engine
```

## Database

Uses SQLite for simplicity. For production scale, migrate to PostgreSQL:

```bash
# The schema is compatible - just change the connection
```

## Monitoring

Check the logs for:
- `[EXPERIMENT]` - New experiments created
- `[SENT]` - Messages sent
- `[ERROR]` - Any failures

```bash
# If using PM2
pm2 logs experiment-engine
```
