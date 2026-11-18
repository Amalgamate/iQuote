# iQuote

Simple self-serve quotation software for small businesses. A business sets up its profile, adds customers, creates a quote, and shares a public approval link.

## Local development

iQuote uses the locally installed PostgreSQL service. Docker is not required for the Node development workflow.

1. Create the local PostgreSQL role and database, then configure `api/.env` with a `DATABASE_URL` that points to `localhost:5432/iquote`. See `api/.env.example` for the shape of the setting.
2. In `api/`, install packages and prepare the database:

   ```powershell
   cd api
   npm install
   npx prisma generate
   npx prisma db push
   npm run dev
   ```

3. In another terminal, run the web app:

   ```powershell
   cd web
   npm install
   npm run dev -- --host 0.0.0.0 --port 5174
   ```

Open http://localhost:5174. Local Node development uses port 5174 to avoid clashing with other local websites. The API health endpoint is http://localhost:4000/health.

The web app reads `VITE_API_URL` from `web/.env`; its local default is `http://localhost:4000`.

New accounts use a four-step onboarding flow with local email-code simulation, business setup, and a 14-day simulated plan trial. iQuote's platform account sends signup verification codes (OTP) and welcome/onboarding emails. Set `RESEND_API_KEY` and a Resend-verified `RESEND_FROM_EMAIL` in `api/.env`; keep both values server-side and out of the web app. `EMAIL_SETTINGS_ENCRYPTION_KEY` is a separate random 32-byte base64url secret used to encrypt tenant-owned Resend keys at rest. Generate one with `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`, place it in `api/.env`, and keep it stable because rotating it makes previously stored tenant keys unreadable. Never commit `.env` or paste secrets into chat. Without the platform Resend values, local development displays the verification code in the onboarding screen and sends no real email. Subscription selection is stored for development, but payment collection is not connected.

### Email sending ownership

- Platform Resend credentials in `api/.env` send signup verification OTP and welcome emails before a tenant workspace exists, and provide iQuote-managed sending when available.
- A tenant's own Resend key and verified sender domain are separate workspace settings. Tenant keys are encrypted in PostgreSQL using `EMAIL_SETTINGS_ENCRYPTION_KEY`; only the tenant can update its settings. DNS verification still requires the tenant to add Resend's records with their DNS provider.
- A tenant cannot supply its own email key before signup verification because no tenant/workspace exists yet. Signup OTP therefore always uses iQuote's platform sender.

### WhatsApp onboarding messages

WhatsApp delivery is not implemented yet. For production OTP and onboarding messages, use the official WhatsApp Business Platform (Cloud API) or an approved provider such as Twilio. You need a Meta business portfolio, a WhatsApp Business Account and sender phone number, an access token with the WhatsApp messaging permission, a webhook endpoint/token for delivery and inbound status, and approved message templates for business-initiated messages outside the customer-service window. Keep the platform WhatsApp token in API-side environment/secrets, never in the web app. The app will also need a normalized phone number (including country code) and a fallback policy when a number is missing or WhatsApp delivery fails. Do not send OTP by WhatsApp until consent, template approval, rate limiting, and abuse controls are in place.

## Docker

`docker-compose.yml` remains available for Docker based environments. It is separate from the local PostgreSQL workflow above.

## Product plan

See `CHECKLIST.md` for staged delivery and `DESIGN.md` for the interface and document style.
