/**
 * Route table, grouped by actor.
 *
 *   seller   /v1/sellers               sign in by email, record the wallet made from it
 *   seller   /v1/invoices              create, list, get, request confirmation
 *   seller   /v1/invoices/:id/list     offer it into the book; /delist takes it back off
 *   debtor   /v1/confirm/:token        public, token-authenticated, no wallet, no signup
 *   seller   /v1/invoices/:id/quote    the price that is already there
 *   buyer    /v1/mandates              post, fund, list, withdraw, exposure
 *   both     /v1/trades                execute, list, get
 *   both     /v1/trades/:id/proof      the audit view, one click from any trade
 *
 * `/health` sits outside the version prefix: it is operational, not product surface.
 */

import { Hono } from 'hono';
import type { AppEnv } from '../middleware/context.js';
import { confirmationRoutes, invoiceRoutes } from './invoices.js';
import { mandateRoutes } from './mandates.js';
import { proofRoutes } from './proof.js';
import { quoteRoutes } from './quotes.js';
import { sellerRoutes } from './sellers.js';
import { tradeRoutes } from './trades.js';

export const v1Routes = new Hono<AppEnv>();

v1Routes.route('/sellers', sellerRoutes);
v1Routes.route('/invoices', invoiceRoutes);
v1Routes.route('/confirm', confirmationRoutes);
v1Routes.route('/mandates', mandateRoutes);
v1Routes.route('/trades', tradeRoutes);

// Mounted at the root of /v1 because their paths are nested under another actor's
// resource: `/invoices/:id/quote` and `/trades/:id/proof`.
v1Routes.route('/', quoteRoutes);
v1Routes.route('/', proofRoutes);

export { healthRoutes } from './health.js';
