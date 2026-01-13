/**
 * Stage Experiment Engine - Backend Server
 *
 * UPDATED: Now uses lowdb (JSON file storage) - no native compilation needed!
 *
 * Logic:
 * - User does trial_paywall_view → Start 30-min timer
 * - If no trial_initiated within 30 min → Paywall Bouncer
 * - User does trial_initiated → Start 10-min timer
 * - If no trial_activated within 10 min → Checkout Abandoner
 */

import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import cron from 'node-cron';
import { v4 as uuidv4 } from 'uuid';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(express.json());

// Serve static files (landing page)
app.use(express.static(join(__dirname, 'public')));

// ============================================
// DATABASE SETUP (lowdb - JSON file)
// ============================================
const dbPath = process.env.NODE_ENV === 'production'
  ? '/app/data/db.json'
  : join(__dirname, 'db.json');

const defaultData = {
  experiments: [],
  combo_stats: [],
  scheduled_messages: [],
  user_journey: []
};

const adapter = new JSONFile(dbPath);
const db = new Low(adapter, defaultData);

// Initialize database
await db.read();
db.data ||= defaultData;
await db.write();

console.log(`[DB] Using lowdb at ${dbPath}`);

// ============================================
// EVENT DETECTION CONFIG
// ============================================
const eventConfig = {
  trial_paywall_view: {
    waitForEvent: 'trial_initiated',
    timeout: 30 * 60 * 1000, // 30 minutes
    cohortIfMissing: 'paywall_bouncers',
    minViews: 1
  },
  trial_initiated: {
    waitForEvent: 'trial_activated',
    timeout: 10 * 60 * 1000, // 10 minutes
    cohortIfMissing: 'checkout_abandoners'
  },
  payment_failed: {
    immediate: true,
    cohort: 'payment_failed'
  }
};

// ============================================
// FRAMEWORK CONFIGURATION
// ============================================
const frameworks = {
  timing: {
    options: ['2min', '5min', '30min', '1hr', '2hr', '4hr', 'next_morning', 'next_evening', 'payday'],
    delays: {
      '2min': 2 * 60 * 1000,
      '5min': 5 * 60 * 1000,
      '30min': 30 * 60 * 1000,
      '1hr': 60 * 60 * 1000,
      '2hr': 2 * 60 * 60 * 1000,
      '4hr': 4 * 60 * 60 * 1000,
      'next_morning': null,
      'next_evening': null,
      'payday': null
    }
  },
  channel: ['push', 'whatsapp', 'sms'],
  lever: ['scarcity', 'fomo', 'social_proof', 'free_value', 'reciprocity', 'cliffhanger', 'personalization'],
  offer: ['free_episode', 'discount_50', 'rupee_1_trial', 'paytm_cashback', 'no_offer'],
  tone: ['urgent', 'friendly', 'curious', 'personal', 'regional']
};

const cohortIntelligence = {
  checkout_abandoners: {
    timing: ['2min', '1hr', '2hr'],
    channel: ['whatsapp', 'push'],
    lever: ['scarcity', 'fomo', 'loss_aversion'],
    offer: ['discount_50', 'rupee_1_trial', 'free_episode'],
    tone: ['urgent', 'curious']
  },
  payment_failed: {
    timing: ['2min', '5min', '30min'],
    channel: ['whatsapp', 'sms'],
    lever: ['reciprocity', 'personalization', 'free_value'],
    offer: ['rupee_1_trial', 'paytm_cashback'],
    tone: ['friendly', 'personal']
  },
  paywall_bouncers: {
    timing: ['1hr', '2hr', 'next_evening'],
    channel: ['push', 'whatsapp'],
    lever: ['free_value', 'social_proof', 'cliffhanger'],
    offer: ['free_episode', 'extended_preview'],
    tone: ['curious', 'friendly']
  }
};

const messageTemplates = {
  scarcity: ["Only {hours} hours left!", "Offer expires soon", "Limited time only"],
  fomo: ["{count} people watching right now", "Trending in {region}", "Everyone's talking about this"],
  social_proof: ["Rated 4.8 by 10K viewers", "Join 1 lakh+ subscribers", "Top rated in {region}"],
  free_value: ["FREE episode waiting", "On us - no strings attached", "Your free gift inside"],
  reciprocity: ["We saved your spot", "Your show is waiting", "We kept it ready for you"],
  cliffhanger: ["Did she find out the truth?", "You won't believe what happens next", "The twist is coming"],
  personalization: ["Picked just for you, {name}", "Based on what you love", "Your personalized pick"]
};

const offerMessages = {
  free_episode: "Watch Episode 1 FREE",
  discount_50: "50% OFF today only",
  rupee_1_trial: "Just ₹1 to start",
  paytm_cashback: "Get ₹50 Paytm cashback",
  no_offer: "Continue your journey"
};

// ============================================
// AMPLITUDE WEBHOOK - Process Events
// ============================================
app.post('/webhook/amplitude', async (req, res) => {
  const events = req.body.events || [req.body];
  let processed = 0;

  for (const event of events) {
    const eventType = event.event_type;
    const userId = event.user_id || event.device_id;
    const properties = event.event_properties || {};

    if (!userId) continue;

    console.log(`[EVENT] ${eventType} from user ${userId}`);

    // Check if this is a conversion event
    await checkForConversion(userId, eventType);

    // Check event config
    const config = eventConfig[eventType];
    if (!config) continue;

    if (config.immediate) {
      await createExperiment(userId, config.cohort, properties);
      console.log(`[IMMEDIATE] Created experiment for ${userId} (${config.cohort})`);
    } else if (config.waitForEvent) {
      const checkAt = new Date(Date.now() + config.timeout).toISOString();

      db.data.user_journey.push({
        id: uuidv4(),
        user_id: userId,
        event_type: eventType,
        event_time: new Date().toISOString(),
        properties: JSON.stringify(properties),
        check_at: checkAt,
        checked: false
      });
      await db.write();

      console.log(`[SCHEDULED] Will check ${userId} for ${config.waitForEvent} at ${checkAt}`);
    }

    processed++;
  }

  res.json({ processed });
});

// Check if user completed the expected next step
async function checkForConversion(userId, eventType) {
  if (eventType === 'trial_initiated') {
    db.data.user_journey
      .filter(j => j.user_id === userId && j.event_type === 'trial_paywall_view' && !j.checked)
      .forEach(j => j.checked = true);
    await db.write();
  }

  if (eventType === 'trial_activated') {
    db.data.user_journey
      .filter(j => j.user_id === userId && j.event_type === 'trial_initiated' && !j.checked)
      .forEach(j => j.checked = true);

    // Find recent experiment and mark as converted
    const experiment = db.data.experiments
      .filter(e => e.user_id === userId && ['sent', 'opened'].includes(e.status))
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];

    if (experiment) {
      experiment.converted_at = new Date().toISOString();
      experiment.status = 'converted';

      const comboKey = `${experiment.timing}|${experiment.channel}|${experiment.lever}|${experiment.offer}`;
      updateComboStats(comboKey, experiment, true);

      console.log(`[CONVERTED] User ${userId} converted! Experiment ${experiment.id}`);
    }
    await db.write();
  }
}

// ============================================
// CRON: Check for Abandonment
// ============================================
cron.schedule('* * * * *', async () => {
  const now = new Date().toISOString();

  const pendingChecks = db.data.user_journey.filter(
    j => j.check_at <= now && !j.checked
  ).slice(0, 100);

  for (const journey of pendingChecks) {
    const config = eventConfig[journey.event_type];
    if (!config || !config.waitForEvent) continue;

    // Check if user did the expected follow-up event
    const followUp = db.data.user_journey.find(
      j => j.user_id === journey.user_id &&
           j.event_type === config.waitForEvent &&
           j.event_time > journey.event_time
    );

    if (!followUp) {
      console.log(`[ABANDONED] User ${journey.user_id} didn't do ${config.waitForEvent} → ${config.cohortIfMissing}`);
      const properties = JSON.parse(journey.properties || '{}');
      await createExperiment(journey.user_id, config.cohortIfMissing, properties);
    } else {
      console.log(`[OK] User ${journey.user_id} did ${config.waitForEvent}`);
    }

    journey.checked = true;
  }

  await db.write();
});

// ============================================
// SMART COMBO SELECTION
// ============================================
function selectCombo(cohort, userAttributes = {}) {
  const intelligence = cohortIntelligence[cohort] || cohortIntelligence.checkout_abandoners;

  const stats = db.data.combo_stats
    .filter(s => s.sent_count >= 5)
    .map(s => ({
      ...s,
      cvr: s.sent_count > 0 ? s.converted_count / s.sent_count : 0
    }))
    .sort((a, b) => b.cvr - a.cvr);

  const explore = Math.random() < 0.2;
  let combo;

  if (!explore && stats.length > 0) {
    const topCombos = stats.slice(0, 5);
    const selected = topCombos[Math.floor(Math.random() * topCombos.length)];
    combo = {
      timing: selected.timing,
      channel: selected.channel,
      lever: selected.lever,
      offer: selected.offer
    };
  } else {
    combo = {
      timing: randomFrom(intelligence.timing),
      channel: randomFrom(intelligence.channel),
      lever: randomFrom(intelligence.lever),
      offer: randomFrom(intelligence.offer)
    };
  }

  combo.tone = randomFrom(intelligence.tone || ['friendly']);
  return combo;
}

function randomFrom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ============================================
// MESSAGE GENERATION
// ============================================
function generateMessage(combo, userAttributes = {}) {
  const leverTemplates = messageTemplates[combo.lever] || ["Check out Stage"];
  const offerMsg = offerMessages[combo.offer] || "Start watching";

  let template = randomFrom(leverTemplates);
  template = template
    .replace('{name}', userAttributes.name || 'there')
    .replace('{region}', userAttributes.region || 'your city')
    .replace('{count}', Math.floor(Math.random() * 5000) + 1000)
    .replace('{hours}', Math.floor(Math.random() * 4) + 2);

  let message;
  if (combo.tone === 'urgent') {
    message = `⏰ ${template}! ${offerMsg} - hurry!`;
  } else if (combo.tone === 'friendly') {
    message = `Hey! 👋 ${template}. ${offerMsg}`;
  } else if (combo.tone === 'curious') {
    message = `🤔 ${template}... ${offerMsg}`;
  } else if (combo.tone === 'regional') {
    message = `🎬 Apne liye kuch khaas! ${offerMsg}`;
  } else {
    message = `${template}. ${offerMsg}`;
  }

  return message;
}

// ============================================
// CLEVERTAP INTEGRATION
// ============================================
async function sendViaCleverTap(userId, message, channel, experimentId) {
  const CLEVERTAP_ACCOUNT_ID = process.env.CLEVERTAP_ACCOUNT_ID;
  const CLEVERTAP_PASSCODE = process.env.CLEVERTAP_PASSCODE;

  if (!CLEVERTAP_ACCOUNT_ID || !CLEVERTAP_PASSCODE) {
    console.log('[MOCK] Would send via CleverTap:', { userId, message, channel });
    return { success: true, mock: true };
  }

  const payload = {
    to: { "Identity": [userId] },
    tag_group: "experiment_engine",
    respect_frequency_caps: false,
    content: {
      title: "Stage",
      body: message,
      platform_specific: {
        android: { deep_link: `stage://experiment/${experimentId}` },
        ios: { deep_link: `stage://experiment/${experimentId}` }
      }
    }
  };

  const endpoints = {
    push: 'https://api.clevertap.com/1/send/push.json',
    whatsapp: 'https://api.clevertap.com/1/send/whatsapp.json',
    sms: 'https://api.clevertap.com/1/send/sms.json'
  };

  try {
    const response = await axios.post(endpoints[channel] || endpoints.push, payload, {
      headers: {
        'X-CleverTap-Account-Id': CLEVERTAP_ACCOUNT_ID,
        'X-CleverTap-Passcode': CLEVERTAP_PASSCODE,
        'Content-Type': 'application/json'
      }
    });
    return { success: true, data: response.data };
  } catch (error) {
    console.error('CleverTap error:', error.message);
    return { success: false, error: error.message };
  }
}

// ============================================
// CREATE EXPERIMENT
// ============================================
async function createExperiment(userId, cohort, userAttributes = {}) {
  // Check if we already have a recent experiment for this user
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const recent = db.data.experiments.find(
    e => e.user_id === userId && e.cohort === cohort && e.created_at > oneHourAgo
  );

  if (recent) {
    console.log(`[SKIP] Already have recent experiment for ${userId}`);
    return recent;
  }

  const experimentId = uuidv4();
  const combo = selectCombo(cohort, userAttributes);
  const message = generateMessage(combo, userAttributes);
  const now = new Date().toISOString();

  const experiment = {
    id: experimentId,
    user_id: userId,
    cohort,
    timing: combo.timing,
    channel: combo.channel,
    lever: combo.lever,
    offer: combo.offer,
    tone: combo.tone,
    message,
    created_at: now,
    sent_at: null,
    opened_at: null,
    converted_at: null,
    status: 'pending'
  };

  db.data.experiments.push(experiment);

  // Calculate send time
  const delay = frameworks.timing.delays[combo.timing];
  let sendAt;

  if (delay) {
    sendAt = new Date(Date.now() + delay);
  } else if (combo.timing === 'next_morning') {
    sendAt = getNextTime(8, 0);
  } else if (combo.timing === 'next_evening') {
    sendAt = getNextTime(19, 0);
  } else {
    sendAt = new Date(Date.now() + 60000);
  }

  db.data.scheduled_messages.push({
    id: uuidv4(),
    experiment_id: experimentId,
    user_id: userId,
    send_at: sendAt.toISOString(),
    status: 'pending'
  });

  await db.write();

  console.log(`[EXPERIMENT] Created ${experimentId} for ${userId} (${cohort}) - sending at ${sendAt.toISOString()}`);
  return { id: experimentId, combo, message, sendAt };
}

function getNextTime(hour, minute) {
  const now = new Date();
  const target = new Date(now);
  target.setHours(hour, minute, 0, 0);
  if (target <= now) target.setDate(target.getDate() + 1);
  return target;
}

function updateComboStats(comboKey, experiment, converted) {
  let stats = db.data.combo_stats.find(s => s.combo_key === comboKey);

  if (stats) {
    stats.sent_count += 1;
    if (converted) stats.converted_count += 1;
    stats.last_updated = new Date().toISOString();
  } else {
    db.data.combo_stats.push({
      combo_key: comboKey,
      timing: experiment.timing,
      channel: experiment.channel,
      lever: experiment.lever,
      offer: experiment.offer,
      sent_count: 1,
      converted_count: converted ? 1 : 0,
      last_updated: new Date().toISOString()
    });
  }
}

// ============================================
// CRON: Send Scheduled Messages
// ============================================
cron.schedule('* * * * *', async () => {
  const now = new Date().toISOString();

  const pendingMessages = db.data.scheduled_messages.filter(
    sm => sm.status === 'pending' && sm.send_at <= now
  ).slice(0, 100);

  for (const msg of pendingMessages) {
    const experiment = db.data.experiments.find(e => e.id === msg.experiment_id);
    if (!experiment) continue;

    try {
      await sendViaCleverTap(msg.user_id, experiment.message, experiment.channel, msg.experiment_id);

      msg.status = 'sent';
      experiment.sent_at = new Date().toISOString();
      experiment.status = 'sent';

      const comboKey = `${experiment.timing}|${experiment.channel}|${experiment.lever}|${experiment.offer}`;
      updateComboStats(comboKey, experiment, false);

      console.log(`[SENT] ${msg.experiment_id} to ${msg.user_id} via ${experiment.channel}`);
    } catch (error) {
      console.error(`[ERROR] Failed to send ${msg.experiment_id}:`, error.message);
    }
  }

  await db.write();
});

// ============================================
// API ENDPOINTS
// ============================================
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/stats', (req, res) => {
  const experiments = db.data.experiments;
  const total = experiments.length;
  const converted = experiments.filter(e => e.status === 'converted').length;
  const opened = experiments.filter(e => ['opened', 'converted'].includes(e.status)).length;
  const sent = experiments.filter(e => ['sent', 'opened', 'converted'].includes(e.status)).length;

  const topCombos = db.data.combo_stats
    .filter(s => s.sent_count >= 5)
    .map(s => ({
      ...s,
      cvr: (s.converted_count / s.sent_count * 100).toFixed(2)
    }))
    .sort((a, b) => parseFloat(b.cvr) - parseFloat(a.cvr))
    .slice(0, 10);

  const worstCombos = db.data.combo_stats
    .filter(s => s.sent_count >= 5)
    .map(s => ({
      ...s,
      cvr: (s.converted_count / s.sent_count * 100).toFixed(2)
    }))
    .sort((a, b) => parseFloat(a.cvr) - parseFloat(b.cvr))
    .slice(0, 5);

  const pendingJourneys = db.data.user_journey.filter(j => !j.checked).length;

  res.json({
    summary: {
      total_experiments: total,
      total_sent: sent,
      total_opened: opened,
      total_converted: converted,
      overall_cvr: sent > 0 ? (converted / sent * 100).toFixed(2) + '%' : '0%',
      pending_abandonment_checks: pendingJourneys
    },
    top_combinations: topCombos,
    worst_combinations: worstCombos
  });
});

app.post('/api/trigger', async (req, res) => {
  const { user_id, cohort, attributes } = req.body;
  if (!user_id || !cohort) return res.status(400).json({ error: 'user_id and cohort required' });

  const experiment = await createExperiment(user_id, cohort, attributes || {});
  res.json({ success: true, experiment });
});

// List all experiments (for debugging)
app.get('/api/experiments', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const experiments = db.data.experiments
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, limit);
  res.json(experiments);
});

// ============================================
// START SERVER
// ============================================
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════════════╗
║          STAGE EXPERIMENT ENGINE - RUNNING                     ║
╠════════════════════════════════════════════════════════════════╣
║  Server:     http://localhost:${PORT}                             ║
╠════════════════════════════════════════════════════════════════╣
║  HOW IT WORKS:                                                 ║
║  1. Amplitude sends events to POST /webhook/amplitude          ║
║  2. Engine detects abandonment (no follow-up event)            ║
║  3. Creates experiment with smart combo                        ║
║  4. Sends message via CleverTap at right time                  ║
║  5. Tracks conversion and learns                               ║
╠════════════════════════════════════════════════════════════════╣
║  YOUR EVENTS:                                                  ║
║  - trial_paywall_view → wait 30min → paywall_bouncers          ║
║  - trial_initiated    → wait 10min → checkout_abandoners       ║
║  - payment_failed     → immediate  → payment_failed            ║
║  - trial_activated    → marks conversion!                      ║
╠════════════════════════════════════════════════════════════════╣
║  TEST IT:                                                      ║
║  curl http://localhost:${PORT}/health                             ║
║  curl http://localhost:${PORT}/api/stats                          ║
║  curl -X POST http://localhost:${PORT}/api/trigger \\              ║
║       -H "Content-Type: application/json" \\                   ║
║       -d '{"user_id":"test123","cohort":"checkout_abandoners"}'║
╚════════════════════════════════════════════════════════════════╝
  `);
});
