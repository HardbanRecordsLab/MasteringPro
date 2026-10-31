/**
 * MasteringPro database schema (PostgreSQL, database `masteringpro`).
 *
 * No audio is ever stored — only file metadata, analysis results and chain
 * parameters (JSON). See HBRL-VPS/DB-POLICY.md for the hosting rules.
 */
import {
  pgTable,
  uuid,
  text,
  real,
  integer,
  smallint,
  boolean,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
  primaryKey,
} from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  displayName: text('display_name'),
  plan: text('plan').notNull().default('free'), // free | pro
  // AI Mastering / Copilot run on real backend compute (OpenRouter), unlike the
  // client-side DSP console, which stays free and unmetered. 3 free credits are
  // granted at signup (see routes/auth.js) so a new account can try AI features
  // before buying a pack; see services/stripeBilling.js for pack definitions.
  credits: integer('credits').notNull().default(3),
  emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
  // HRL Wallet account (credits and password live there while WALLET_ENABLED); null = the old local credits (operator accounts)
  walletAccountId: text('wallet_account_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const creditPurchases = pgTable('credit_purchases', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  stripeSessionId: text('stripe_session_id').notNull().unique(),
  packId: text('pack_id').notNull(),
  creditsAdded: integer('credits_added').notNull(),
  amountTotal: integer('amount_total'),
  currency: text('currency'),
  // lets a refund (charge.refunded) be traced back to the purchase and the credits taken back
  paymentIntentId: text('payment_intent_id'),
  refundedAt: timestamp('refunded_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// One row per (account, track) that has been paid for. Re-exporting the same track (other formats, fixes) inside the
// window costs nothing; after it expires the next export of that track is charged again.
export const exportCharges = pgTable(
  'export_charges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    trackKey: text('track_key').notNull(), // sha-256 of "name|size|lastModified" of the SOURCE file — the audio never leaves the browser
    label: text('label'),
    chargedAt: timestamp('charged_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex('export_charges_user_track_uq').on(t.userId, t.trackKey)],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    userAgent: text('user_agent'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('sessions_token_hash_idx').on(t.tokenHash)],
);

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    sourceName: text('source_name'),
    sourceSampleRate: integer('source_sample_rate'),
    sourceChannels: smallint('source_channels'),
    sourceDurationS: real('source_duration_s'),
    sourceHash: text('source_hash'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('projects_user_updated_idx').on(t.userId, t.updatedAt)],
);

export const projectVersions = pgTable(
  'project_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    label: text('label'),
    chainParams: jsonb('chain_params').notNull(),
    analysis: jsonb('analysis'),
    targetPlatform: text('target_platform'),
    targetLufs: real('target_lufs'),
    targetTp: real('target_tp'),
    aiConfig: jsonb('ai_config'),
    aiReport: jsonb('ai_report'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('project_versions_project_created_idx').on(t.projectId, t.createdAt)],
);

export const presets = pgTable('presets', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }), // null = factory
  name: text('name').notNull(),
  genre: text('genre'),
  chainParams: jsonb('chain_params').notNull(),
  isFactory: boolean('is_factory').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const renders = pgTable('renders', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectVersionId: uuid('project_version_id')
    .notNull()
    .references(() => projectVersions.id, { onDelete: 'cascade' }),
  format: text('format').notNull(),
  sampleRate: integer('sample_rate'),
  integratedLufs: real('integrated_lufs'),
  truePeakDb: real('true_peak_db'),
  lra: real('lra'),
  renderedAt: timestamp('rendered_at', { withTimezone: true }).notNull().defaultNow(),
});

export const referenceProfiles = pgTable('reference_profiles', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  spectrum: jsonb('spectrum').notNull(),
  loudness: jsonb('loudness').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const albums = pgTable('albums', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  targetLufs: real('target_lufs'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const albumTracks = pgTable(
  'album_tracks',
  {
    albumId: uuid('album_id').notNull().references(() => albums.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    gapS: real('gap_s').notNull().default(2),
  },
  (t) => [primaryKey({ columns: [t.albumId, t.projectId] })],
);
