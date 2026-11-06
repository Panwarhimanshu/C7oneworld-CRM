# C7one — Lead Management System

**Phase 1: walk-in registration and reception desk.**

A visitor arriving at the office scans a QR code (or uses the reception tablet) and fills in a short form. They verify their mobile number (or email) with a one-time code. Verified visitors show up at once on the **Walk-ins** screen for reception. Reception opens the lead's profile, assigns a counselor and tracks the visit to completion.

---

## Quick start

Requirements: **Node.js 22+**.

```bash
npm install
npm run setup                                   # creates .env with a fresh secret, initialises the database
npm run create-admin -- --name "Your Name" --email you@company.com
npm start
```

| URL | Who uses it |
|---|---|
| `http://localhost:3000/register` | Visitors (QR code / reception tablet) |
| `http://localhost:3000/login` | Staff |

`create-admin` prints a one-time password. You must replace it at first sign-in.

In development, OTP codes are printed to the server console (`SMS_PROVIDER=console`). To skip the code entirely, set `OTP_DEV_BYPASS_CODE=123456` in `.env`: every code becomes `123456`, and the verify screen shows a hint. Both settings are refused when `NODE_ENV=production`.

Run the tests with `npm test`.

---

## The walk-in flow

1. **Details:** full name, email and mobile number (with country code). The visitor chooses SMS or email for the code.
2. **Verify:** a 6-digit code, valid for 5 minutes.
   - Wrong code: the visitor sees how many attempts remain and can re-enter it or request a new one.
   - After 5 wrong attempts the code is locked and the visitor must start again.
   - Resend has a 30-second cooldown and a limit of 3 resends. A new code invalidates the old one.
3. **Done:** "Thank you for registering. Please take a seat. A counselor will connect with you shortly." The screen resets after 20 seconds, so a shared tablet never shows the previous visitor's details.

**Nothing reaches the lead list until the OTP is verified.**

### Returning visitors and duplicates

- A lead is matched **only on the identifier the visitor just proved they own**: the mobile number for SMS, the email address for email.
- A returning visitor gets a **new visit** on their existing lead, not a duplicate lead.
- Registering twice while already waiting does not create a second visit.
- The public form **never overwrites** an existing lead's details. If someone types different details, these are kept on the visit and flagged to reception, who can accept them with *Edit details*.
- Leads that share a mobile number or email with another lead show a "possible duplicate" warning.

### Visit statuses

```
Waiting ──► With counselor ──► Completed
   │              │
   │              └──► back to Waiting (return to queue)
   └──► Left without meeting
```

- A counselor must be assigned before a consultation can start.
- Completed and left visits are closed and cannot be reopened.
- Today's view always includes visits still open from earlier days, so nobody waiting is lost at midnight.

---

## Lead visibility

**A lead is visible only to the people who are meant to work on it.**

- **Reception and Super Admin** see every lead. They have the **Walk-ins** menu (the live front-desk queue) and the **Leads** menu (all leads).
- **Counselors, Coaching Admins and any custom role** have no Walk-ins menu. Their **My leads** menu lists only leads assigned to them.
- A lead is assigned in either of two ways:
  - Reception starts a walk-in consultation with a counselor.
  - Someone with "Assign and reassign leads" picks an owner in the lead's **Lead owner** panel.
- Reassigning a lead removes it from the previous owner's view at once.
- If someone opens a lead they are not allowed to see, even by typing its address, the server answers "not found". This means they cannot even confirm that the lead exists.
- The duplicate-lead warning is shown only to people who can see all leads, so it cannot leak other leads.
- **Finding unassigned leads through search.** Counselors and Coaching Admins have the "Find unassigned leads in search" permission by default.
  - Searching at least 3 characters, in the global search or the Leads search box, also returns **unassigned** leads, tagged *Unassigned · view only*.
  - Opening such a lead is **view only**: they can read it and **add notes (remarks)**, but cannot edit any field or change the stage. The server enforces this.
  - Editing unlocks only once the lead is assigned to them.
  - Leads assigned to *another* counselor never appear in their search.
- Search results always open in the same tab.

## Dashboard

Every login lands on **Dashboard**. The period can be Today, This week, This month, Last month, Last 90 days or a custom range.

**Leads section:**
- Lead count, compared with the previous period of the same length.
- Converted, conversion %, in pipeline and lost.
- Lead-source and stage breakdowns.
- Leads over time.
- The front desk also sees walk-ins and unassigned leads.

**Who sees what:**
- **Counselors and Coaching Admins** see their own leads, counted by the date each lead was assigned to them, and their own revenue.
- **Reception** sees the whole office's lead and walk-in figures, but no revenue.
- **Super Admin** sees everything, plus revenue for the whole office, and can filter to one counselor or to unassigned leads.

**Revenue figures** (stored in paise, shown in ₹):
- **Amount collected:** payments dated in the period, compared with the previous period.
- **Previous month:** collected last calendar month.
- **Agreed amount:** fees agreed in the period.
- **Outstanding:** owed as of today, agreed minus collected.
- **Collection rate:** total collected against total agreed.
- **Super Admin tables:** *By counselor* and *By lead source*, each showing leads, converted, conversion %, agreed, collected and outstanding.

## Fees & payments

The lead profile has a **Fees & payments** section, for people with "Record fees and payments" on leads they own:
- **Set agreed amount.**
- **Record payment:** amount, date, mode (Cash, UPI, Card, Bank transfer, Cheque, Other), reference, note.

Payments **cannot be edited or deleted**, and the database refuses it. Every payment is in the lead's activity and the audit log. The office revenue dashboard is a Super-Admin-only permission.

## Bulk upload (Super Admin only)

**Leads → Bulk upload** (also in Quick Create) imports many leads from a **CSV** file. In Excel use *File → Save As → CSV*. Only Super Admin has this permission, and it cannot be granted to any other role or login.

1. **Choose file.** **Download template** shows the format:
   - Required columns: `Full name`, `Mobile`.
   - Optional: `Country code` (default 91), `Email`, `Source`, `Assign to (login email)`, `Note`.
   - Pick a default source and, optionally, a default counselor.
2. **Check.** Every row is validated first. You see how many rows are ready, which are duplicates (same mobile or email as an existing lead, or as another row in the file), and which have errors, each with the row number and reason. Nothing is saved yet.
3. **Import.** Valid rows are created in one step (all or nothing). Duplicates are skipped unless you untick that option. Assigned counselors get one notification with their count, and the upload is recorded in the audit log.

Limits: 2,000 rows and 2 MB per file. Imported leads follow every normal rule: the source is locked, and visibility depends on assignment.

## Top bar

- **Quick Create:**
  - **New lead** adds an enquiry that didn't come through the Walk-in Form (phone call, referral, website and so on). Email is optional, a source is required, and you can assign the lead immediately. Someone who can only see their own leads automatically becomes the owner of any lead they create.
  - Also offers New login, New role and Registration QR, depending on the person's permissions.
- **Clock:** the number of visitors waiting at the front desk. Click it to open Walk-ins on the Waiting tab. Only logins with the Walk-ins menu see it.
- **Bell:** notifications, delivered live and stored per login with read/unread state:
  - *New walk-in*, for front-desk logins.
  - *Lead assigned to you*, for the new owner.
  - *Lead moved off your list*, for the previous owner. This one carries no link, because they can no longer open the lead.
  - Notifications are kept for 90 days.
- **User menu:** My account and Sign out.

## Roles & permissions

Super Admin manages access from two screens:

- **Administration → Roles & permissions** lets you create roles (for example a department such as "IELTS" or "Visa") and tick which menus and actions each role gets. Changes apply on the person's next action, without signing them out.
- **Administration → Logins** lets you create logins and assign a role. **Access** adjusts one person on top of their role: grant or remove individual permissions. Changes are shown as "Added for this login" or "Removed for this login".

Default roles:

| Permission | Super Admin | Reception | Counselor | Coaching Admin |
|---|:-:|:-:|:-:|:-:|
| Walk-ins menu | ✓ | ✓ | | |
| Manage walk-in visits | ✓ | ✓ | | |
| Leads menu: all leads | ✓ | ✓ | | |
| Leads menu: assigned leads only | ✓ | | ✓ | ✓ |
| Can be assigned leads | | | ✓ | ✓ |
| Assign and reassign leads | ✓ | ✓ | | |
| Edit lead details | ✓ | ✓ | | |
| Add notes | ✓ | ✓ | ✓ | ✓ |
| Logins, Roles & permissions, Audit log | ✓ | | | |

**Safeguards**

- The Super Admin role is locked to full access, and at least one active Super Admin must always exist.
- Logins, Roles & permissions and Audit log can never be granted to another role or login. This prevents anyone from promoting themselves.
- Dependencies between permissions are enforced (for example, "Manage walk-in visits" needs "Walk-ins"). The screen ticks and unticks these automatically.
- Built-in roles cannot be deleted, and a custom role can only be deleted once no logins use it.
- Every role and access change is recorded in the audit log.

The list of available permissions is in [src/permissions.js](src/permissions.js). Phase 2 modules add their own permissions there, and they then appear on the Roles screen automatically.

---

## Security controls

**Visitor form and OTP**
- OTPs are generated with a cryptographically secure random generator.
- They are stored only as an HMAC-SHA256 hash and compared in constant time.
- OTPs are never returned by the API.
- Each verification has an attempt limit, an expiry time, a resend cooldown and a resend limit.
- Caps against SMS pumping (toll fraud) apply per mobile/email per day, per IP per hour, and globally per hour. These caps count failed sends too.
- A hidden honeypot field catches bots, and there is a per-IP rate limit.
- Unverified registration attempts, which hold personal data, are purged after 24 hours.

**Staff authentication**
- Passwords are hashed with scrypt using a random salt per password, with parameters stored for future upgrades.
- Password policy: at least 12 characters, a complexity rule or 16+ characters, and it must not contain the user's name or email or be a common password.
- New and reset accounts receive a one-time password and must change it before doing anything else.
- The account locks for 15 minutes after 5 failed sign-ins. There is also a per-IP sign-in rate limit.
- Error messages are generic and timing is equalised, so attackers cannot discover which accounts exist.
- Sessions are server-side, with only a 256-bit random token in the cookie and its SHA-256 hash in the database.
- The cookie is `HttpOnly`, `SameSite=Strict`, and `Secure` with the `__Host-` prefix in production.
- Sessions time out after 30 minutes idle and 12 hours in total.
- Changing a password signs out the user's other devices. Deactivating a user, changing their role or resetting their password ends all their sessions immediately, including the live feed.

**Web layer**
- Every state-changing request needs a per-session CSRF token. Origin and `Sec-Fetch-Site` are checked, and only JSON bodies (max 10 KB) are accepted.
- Strict Content Security Policy: scripts only from this server, no inline scripts or styles, no `eval`, and `frame-ancestors 'none'`.
- Helmet hardening headers are set, plus HSTS in production, `Referrer-Policy: no-referrer`, a Permissions-Policy and `Cache-Control: no-store` on all API responses.
- The front end never uses `innerHTML`. All data is rendered as text, which prevents stored XSS.
- All SQL uses prepared statements, and search escapes `LIKE` wildcards.
- Every input passes strict schema validation: unknown fields are rejected, and names are restricted to letters.
- Authorisation is checked on the server for every endpoint. The UI hiding a button is never relied on.
- There are no open redirects after login.
- The live feed only says that something changed. Clients re-fetch through authorised endpoints, so no personal data travels on the stream.

**Record retention**
- No one can delete a lead, whatever their role (Super Admin included). There is no delete button, no delete endpoint and no delete permission.
- The database itself refuses deletion of leads, visits and notes. This lock is a database rule (a trigger), so even a future code change or a manual database query cannot remove them.
- A lead that is no longer active should be closed with **Close as lost**, which keeps its full history.

**Accountability**
- The audit log records sign-ins (successful, failed and blocked), every lead profile view, every edit and status change, user management actions and OTP lock-outs, each with user, time and IP.

`npm audit` reports 0 known vulnerabilities in dependencies at the time of writing.

---

## Going to production

1. Set `NODE_ENV=production` and `PUBLIC_BASE_URL=https://your-domain` (HTTPS is required).
2. Configure a real SMS provider:
   - **MSG91** (India, DLT-registered template containing `##otp##`): `SMS_PROVIDER=msg91`, `MSG91_AUTH_KEY`, `MSG91_TEMPLATE_ID`.
   - **Twilio:** `SMS_PROVIDER=twilio`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`.
3. Configure SMTP for email codes (`EMAIL_PROVIDER=smtp`, `SMTP_*`), or set `OTP_CHANNELS=sms`.
4. Put the app behind Nginx or a load balancer that terminates TLS, and set `TRUST_PROXY=1`. A wrong value lets clients spoof their IP and dodge rate limits.
5. Back up `data/c7one.db` regularly. Keep `.env` out of version control (it is already in `.gitignore`).
6. Run the app under a process manager (systemd, PM2 or Windows Service) so it restarts automatically.

Rate limits are kept in memory, which suits a single server. If you ever run several instances, move them to Redis.

---

## Project layout

```
src/
  server.js            entry point, housekeeping (expired sessions, OTP data retention)
  app.js               Express app: security middleware, routes, error handling
  config.js            environment configuration, with production safety checks
  permissions.js       role → permission matrix
  db/                  SQLite connection and versioned migrations
  routes/api.js        HTTP API
  services/            registration (OTP), auth, users, leads/visits, audit log
  middleware/          sessions, CSRF, RBAC, security headers
  providers/           SMS (console, Twilio, MSG91) and email (console, SMTP)
public/
  register.html        visitor form
  login.html           staff sign-in
  app.html + assets/js/app/   staff workspace (walk-ins, lead profile, users, audit, account)
scripts/               setup and create-admin
test/                  API test suite (node --test)
```

## Phase 2 (planned)

Counselor workspace and follow-ups, coaching enrolments, lead pipeline stages through to purchase, and reporting. The schema and permission matrix are designed to extend without reworking Phase 1.
