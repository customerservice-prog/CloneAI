#!/usr/bin/env node
/**
 * One-time: register Live (or Test) webhook after the API has a public HTTPS URL.
 * Prints STRIPE_WEBHOOK_SECRET=whsec_... — add to Render env and restart.
 *
 * Usage (from backend/):
 *   node scripts/create-stripe-webhook.mjs https://cloneai-api.onrender.com/api/billing/webhook
 */
import 'dotenv/config';
import Stripe from 'stripe';

const url = (process.argv[2] || process.env.STRIPE_WEBHOOK_URL || '').trim();
if (!url.startsWith('https://')) {
  console.error('Pass the full webhook URL (must be https), e.g.:');
  console.error('  node scripts/create-stripe-webhook.mjs https://YOUR_API_HOST/api/billing/webhook');
  process.exit(1);
}

const key = process.env.STRIPE_SECRET_KEY?.trim();
if (!key) {
  console.error('Missing STRIPE_SECRET_KEY in backend/.env');
  process.exit(1);
}

const stripe = new Stripe(key);
const endpoint = await stripe.webhookEndpoints.create({
  url,
  enabled_events: [
    'checkout.session.completed',
    'customer.subscription.updated',
    'customer.subscription.deleted',
    'invoice.payment_failed',
  ],
});

if (!endpoint.secret) {
  console.error('Stripe did not return a signing secret; check dashboard → Webhooks.');
  process.exit(1);
}

console.log('\nAdd this to Render (or backend/.env), then redeploy / restart:\n');
console.log(`STRIPE_WEBHOOK_SECRET=${endpoint.secret}\n`);
console.log(`Webhook id: ${endpoint.id}`);
