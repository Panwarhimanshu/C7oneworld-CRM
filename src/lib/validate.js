'use strict';

const { z } = require('zod');
const { AppError } = require('./errors');

const personName = z
  .string({ error: 'Full name is required.' })
  .trim()
  .min(2, 'Please enter your full name.')
  .max(100, 'Name is too long.')
  .regex(/^[\p{L}\p{M}][\p{L}\p{M} .'\-]*$/u, 'Name can contain letters, spaces, dots, hyphens and apostrophes only.')
  .transform((s) => s.replace(/\s+/g, ' '));

const email = z
  .string({ error: 'Email address is required.' })
  .trim()
  .toLowerCase()
  .max(254, 'Email address is too long.')
  .pipe(z.email('Please enter a valid email address.'));

const id = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);

const roleKey = z.string({ error: 'Select a role.' }).regex(/^[a-z0-9_]{2,60}$/, 'Select a valid role.');
const roleName = z.string({ error: 'Role name is required.' }).trim().min(2, 'Role name is too short.').max(60, 'Role name is too long.')
  .regex(/^[\p{L}\p{N}][\p{L}\p{N} &/().'\-]*$/u, 'Use letters, numbers, spaces and & / ( ) . - only.');
const permissionKey = z.string().regex(/^[a-z_]+\.[a-z_]+$/);

// Sources selectable for new leads. 'other' is kept only for existing records.
const NEW_LEAD_SOURCES = ['walk_in', 'phone', 'referral', 'website', 'social', 'email', 'bulk_upload'];

const schemas = {
  registrationStart: z.strictObject({
    fullName: personName,
    email,
    countryCode: z.string().trim().regex(/^\+?\d{1,3}$/, 'Select a valid country code.').transform((s) => s.replace('+', '')),
    mobile: z.string({ error: 'Mobile number is required.' }).trim().min(6, 'Please enter a valid mobile number.').max(20, 'Please enter a valid mobile number.'),
    channel: z.enum(['sms', 'email']),
    // Honeypot: real visitors never see or fill this field.
    company: z.string().max(0).optional(),
  }),

  registrationRef: z.strictObject({
    requestId: z.string().regex(/^[A-Za-z0-9_-]{32}$/, 'Invalid verification reference.'),
  }),

  registrationVerify: z.strictObject({
    requestId: z.string().regex(/^[A-Za-z0-9_-]{32}$/, 'Invalid verification reference.'),
    code: z.string().trim().regex(/^\d{4,8}$/, 'Enter the numeric code you received.'),
  }),

  login: z.strictObject({
    email,
    password: z.string().min(1, 'Password is required.').max(128),
  }),

  changePassword: z.strictObject({
    currentPassword: z.string().min(1, 'Current password is required.').max(128),
    newPassword: z.string().max(128, 'Password must be at most 128 characters.'),
  }),

  userCreate: z.strictObject({
    fullName: personName,
    email,
    role: roleKey,
  }),

  userUpdate: z.strictObject({
    fullName: personName.optional(),
    role: roleKey.optional(),
    isActive: z.boolean().optional(),
  }),

  // Lead source is set when the lead is created and can never be changed.
  leadUpdate: z.strictObject({
    fullName: personName.optional(),
    email: z.union([z.literal(''), email]).optional(),
  }),

  leadCreate: z.strictObject({
    fullName: personName,
    email: z.union([z.literal(''), email]).optional().default(''),
    countryCode: z.string().trim().regex(/^\+?\d{1,3}$/, 'Select a valid country code.').transform((s) => s.replace('+', '')),
    mobile: z.string({ error: 'Mobile number is required.' }).trim().min(6, 'Enter a valid mobile number.').max(20, 'Enter a valid mobile number.'),
    source: z.enum(NEW_LEAD_SOURCES, { error: 'Select where this lead came from.' }),
    assigneeId: id.nullable().optional(),
    note: z.string().trim().max(2000, 'Note must be at most 2000 characters.').optional().default(''),
  }),

  leadAssign: z.strictObject({
    assigneeId: id.nullable(),
  }),

  leadStage: z.strictObject({
    stage: z.enum(['new', 'contacted', 'working', 'qualified', 'converted', 'unqualified', 'lost_interest', 'lost_to_competitor']),
  }),

  leadImport: z.strictObject({
    csv: z.string().min(1, 'The file is empty.').max(2_000_000, 'The file is larger than 2 MB.'),
    defaultSource: z.enum(NEW_LEAD_SOURCES, { error: 'Select a default lead source.' }).optional().default('bulk_upload'),
    defaultAssigneeId: id.nullable().optional(),
    skipDuplicates: z.boolean().optional().default(true),
    dryRun: z.boolean().optional().default(true),
  }),

  dashboardQuery: z.object({
    from: z.coerce.number().int().nonnegative(),
    to: z.coerce.number().int().positive(),
    owner: z.string().regex(/^(all|me|unassigned|\d{1,15})$/).optional().default('all'),
    tz: z.coerce.number().int().min(-840).max(840).optional().default(0),
    // Previous calendar month in the viewer's time zone (for the "Last month" figure).
    lmFrom: z.coerce.number().int().nonnegative().optional(),
    lmTo: z.coerce.number().int().positive().optional(),
  }),

  // Rupees with up to 2 decimals, converted to paise for storage.
  agreedAmount: z.strictObject({
    amount: z.number({ error: 'Enter the agreed amount.' }).min(0, 'Amount cannot be negative.').max(100_000_000, 'Amount is too large.')
      .refine((v) => Number.isInteger(Math.round(v * 100)) && Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, 'Use at most 2 decimal places.')
      .nullable(),
  }),

  paymentCreate: z.strictObject({
    amount: z.number({ error: 'Enter the amount received.' }).positive('Amount must be more than zero.').max(100_000_000, 'Amount is too large.')
      .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, 'Use at most 2 decimal places.'),
    paidOn: z.number().int(),
    mode: z.enum(['cash', 'upi', 'card', 'bank_transfer', 'cheque', 'other'], { error: 'Select the payment mode.' }),
    reference: z.string().trim().max(60, 'Reference is too long.').optional().default(''),
    note: z.string().trim().max(500, 'Note is too long.').optional().default(''),
  }),

  leadsQuery: z.object({
    q: z.string().trim().max(100).optional().default(''),
    stage: z.enum(['all', 'open', 'new', 'contacted', 'working', 'qualified', 'converted', 'lost']).optional().default('all'),
    owner: z.string().regex(/^(all|me|unassigned|\d{1,15})$/).optional().default('all'),
    status: z.enum(['all', 'none', 'waiting', 'with_counselor', 'completed', 'left']).optional().default('all'),
    page: z.coerce.number().int().min(1).max(100000).default(1),
  }),

  roleCreate: z.strictObject({
    name: roleName,
    description: z.string().trim().max(200, 'Description is too long.').optional().default(''),
    copyFrom: roleKey.optional(),
  }),

  roleUpdate: z.strictObject({
    name: roleName.optional(),
    description: z.string().trim().max(200, 'Description is too long.').optional(),
  }),

  rolePermissions: z.strictObject({
    permissions: z.array(permissionKey).max(100),
  }),

  userPermissions: z.strictObject({
    overrides: z.record(permissionKey, z.boolean()),
  }),

  roleParam: z.object({ key: roleKey }),

  noteCreate: z.strictObject({
    body: z.string().trim().min(1, 'Note cannot be empty.').max(2000, 'Note must be at most 2000 characters.'),
  }),

  visitUpdate: z.strictObject({
    status: z.enum(['waiting', 'with_counselor', 'completed', 'left']).optional(),
    counselorId: id.nullable().optional(),
  }),

  walkinQuery: z.object({
    from: z.coerce.number().int().nonnegative(),
    to: z.coerce.number().int().positive(),
    status: z.enum(['all', 'waiting', 'with_counselor', 'completed', 'left']).default('all'),
    q: z.string().trim().max(100).optional().default(''),
  }),

  auditQuery: z.object({
    page: z.coerce.number().int().min(1).max(10000).default(1),
    action: z.string().trim().regex(/^[a-z_.]*$/).max(60).optional().default(''),
  }),

  idParam: z.object({ id }),
};

// A bulk-upload row follows exactly the same rules as Quick Create.
schemas.leadImportRow = schemas.leadCreate;

function parse(schema, input) {
  const result = schema.safeParse(input ?? {});
  if (result.success) return result.data;
  const fields = {};
  for (const issue of result.error.issues) {
    const key = issue.path.join('.') || '_';
    if (!fields[key]) fields[key] = issue.code === 'unrecognized_keys' ? 'Unexpected field.' : issue.message;
  }
  throw new AppError(422, 'VALIDATION_FAILED', 'Please correct the highlighted fields.', { fields });
}

module.exports = { schemas, parse };
