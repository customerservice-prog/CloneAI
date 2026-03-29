import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { withBillingLock, loadState, saveState } from './billingStore.js';
import {
  normalizeUserId,
  PLANS,
  planFromStripePriceId,
  ensureBillingUser,
  normalizeAccountEmail,
  findConflictingLoginEmailOwner,
} from './billingService.js';

function generateAccountPassword() {
  return randomBytes(14).toString('base64url').replace(/[^a-zA-Z0-9]/g, '').slice(0, 14) + '1A';
}

/**
 * Resolve plan + Stripe ids from an expanded Checkout Session (subscription mode).
 * @param {import('stripe').Stripe.Checkout.Session} session
 */
function subscriptionFieldsFromCheckoutSession(session) {
  const sub =
    session.subscription && typeof session.subscription === 'object' ? session.subscription : null;
  const subId = typeof session.subscription === 'string' ? session.subscription : sub?.id;
  const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;
  let plan =
    session.metadata?.plan && [PLANS.STARTER, PLANS.PRO, PLANS.POWER].includes(session.metadata.plan)
      ? session.metadata.plan
      : null;
  const priceFromMeta = session.metadata?.priceId?.trim();
  if (!plan && priceFromMeta) plan = planFromStripePriceId(priceFromMeta);
  const linePrice = sub?.items?.data?.[0]?.price?.id;
  if (!plan && linePrice) plan = planFromStripePriceId(String(linePrice));
  let stripePriceId = priceFromMeta || (linePrice ? String(linePrice) : undefined);
  return { plan, subId, customerId, stripePriceId };
}

/**
 * After a paid Starter/Pro checkout: attach login email + one-time password, sync plan from Stripe.
 * @param {import('stripe').Stripe} stripe
 * @param {string} sessionId
 * @param {string | null | undefined} headerUserId
 */
export async function claimSubscriptionAccount(stripe, sessionId, headerUserId) {
  const uid = normalizeUserId(headerUserId);
  if (!uid) {
    return { ok: false, code: 'MISSING_USER_ID', error: 'MISSING_USER_ID' };
  }
  const sid = String(sessionId || '').trim();
  if (!sid || sid.length > 128) {
    return { ok: false, code: 'INVALID_SESSION', error: 'Invalid session.' };
  }

  let session;
  try {
    session = await stripe.checkout.sessions.retrieve(sid, { expand: ['subscription'] });
  } catch {
    return { ok: false, code: 'SESSION_LOOKUP_FAILED', error: 'Could not verify checkout session.' };
  }

  const paid =
    session.payment_status === 'paid' || session.payment_status === 'no_payment_required';
  if (!paid) {
    return { ok: false, code: 'NOT_PAID', error: 'Checkout is not complete yet.' };
  }
  if (session.mode !== 'subscription') {
    return { ok: false, code: 'NOT_SUBSCRIPTION', error: 'This checkout is not a subscription plan.' };
  }

  const ref = normalizeUserId(session.client_reference_id || session.metadata?.cloneaiUserId);
  if (!ref || ref !== uid) {
    return { ok: false, code: 'SESSION_USER_MISMATCH', error: 'This checkout belongs to a different session.' };
  }

  return withBillingLock(async () => {
    const state = loadState();
    const u = ensureBillingUser(state, uid);
    const { plan, subId, customerId, stripePriceId } = subscriptionFieldsFromCheckoutSession(session);

    if (!plan) {
      return {
        ok: false,
        code: 'PLAN_PENDING',
        error: 'Your plan is still updating. Wait a few seconds and try again.',
      };
    }

    u.plan = plan;
    if (customerId) u.stripeCustomerId = customerId;
    if (subId) u.stripeSubscriptionId = subId;
    if (stripePriceId) u.stripePriceId = stripePriceId;
    u.updatedAt = new Date().toISOString();

    const emailRaw = session.customer_details?.email || session.customer_email || '';
    const loginEmail = normalizeAccountEmail(emailRaw);
    if (!loginEmail) {
      saveState(state);
      return {
        ok: false,
        code: 'NO_CHECKOUT_EMAIL',
        error: 'No email on this checkout. Contact support with your receipt.',
      };
    }

    const other = findConflictingLoginEmailOwner(state, loginEmail, uid);
    if (other) {
      saveState(state);
      return {
        ok: false,
        code: 'EMAIL_IN_USE',
        error: 'That email is already linked to another CloneAI account.',
      };
    }

    if (!u.loginEmail) u.loginEmail = loginEmail;
    else if (u.loginEmail !== loginEmail) {
      saveState(state);
      return {
        ok: false,
        code: 'EMAIL_MISMATCH',
        error: 'Checkout email does not match this account.',
      };
    }

    if (u.credentialsDelivered) {
      saveState(state);
      return { ok: true, alreadyDelivered: true, login: u.loginEmail };
    }

    const passwordPlain = generateAccountPassword();
    u.passwordHash = await bcrypt.hash(passwordPlain, 10);
    u.credentialsDelivered = true;
    u.updatedAt = new Date().toISOString();
    saveState(state);
    return { ok: true, login: u.loginEmail, password: passwordPlain };
  });
}

/**
 * @param {string} loginRaw
 * @param {string} password
 */
export async function loginWithEmailPassword(loginRaw, password) {
  const login = normalizeAccountEmail(loginRaw);
  const pw = String(password || '');
  if (!login || !pw) {
    return { ok: false, code: 'INVALID_REQUEST', error: 'Enter email and password.' };
  }

  return withBillingLock(async () => {
    const state = loadState();
    let matchId = null;
    let hash = null;
    for (const [id, u] of Object.entries(state.users || {})) {
      if ((u.loginEmail || '').toLowerCase() === login) {
        matchId = id;
        hash = u.passwordHash;
        break;
      }
    }
    if (!matchId || !hash) {
      return { ok: false, code: 'AUTH_FAILED', error: 'Invalid email or password.' };
    }
    const ok = await bcrypt.compare(pw, hash);
    if (!ok) {
      return { ok: false, code: 'AUTH_FAILED', error: 'Invalid email or password.' };
    }
    return { ok: true, userId: matchId };
  });
}
