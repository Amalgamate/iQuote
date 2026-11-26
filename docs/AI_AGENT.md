# AI assistant for iQuote: design and build plan

**Status (25 Nov 2026):** design plus a tested-on-paper safety module. **No AI call is wired up yet.**
`api/src/ai-quote.ts` and `api/tests/ai-quote.test.ts` exist and are unused. Nothing here has been
compiled or run. Costs, credit prices and trial allowances below are **placeholders to decide**, not
recommendations built on real usage data.

## Decisions made (owner, 25 Nov 2026)

| Question | Decision |
|---|---|
| How AI is sold | **Credit packs bought by M-Pesa.** Free allowance during trials. |
| What the agent may do alone | **Auto-draft; ask before anything is sent to a customer.** |
| First capability | **Create quotes from plain text or voice notes.** |

## Scope of the first release (MVP)

The user types (or dictates) something like:
"Quote Wanjiru for 3 hours pipe repair and 2 new taps at 1,800 each, valid 14 days"
and gets a **DRAFT quote** in the normal quote editor, with:
- lines matched to their **service catalogue** (using the catalogue's own price and tax rate),
- blanks clearly highlighted where no price was given,
- a short list of **assumptions** and **questions** the assistant had.

The MVP **never sends anything**. The user reviews the draft and uses the existing Send button, which
is already a deliberate human action. That satisfies "ask before sending to customers" without a new
approval system. Invoices, replies to customers and chasing payments come later.

## How it works

```
Browser                      API (index.ts)                         Anthropic API
  | POST /api/ai/quote-draft     |                                       |
  |  { text, idempotencyKey } -> | auth, plan/credits check, rate limit  |
  |                              | load catalogue + org defaults         |
  |                              | build prompt  ----------------------> | propose_quote (forced tool)
  |                              | <------------------------------------ | structured proposal
  |                              | validateProposal(...)  (ai-quote.ts)  |
  |                              | match customer (server side)          |
  |                              | create DRAFT quote, charge 1 credit   |
  | <- { quote, warnings, ... }  |                                       |
```

- **One model call, forced tool**, not an open-ended agent loop. It is cheaper, faster and easier to make safe. A full tool-using agent comes later, when sending and replies need it.
- **Call it with `fetch`** (the API already uses `fetch` for Resend), so no new dependency:

```ts
const response = await fetch('https://api.anthropic.com/v1/messages', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY!, 'anthropic-version': '2023-06-01' },
  body: JSON.stringify({
    model: process.env.AI_QUOTE_MODEL ?? 'claude-haiku-5-5',   // configurable; try Sonnet 5.5 if Haiku misses too often
    max_tokens: 1500,
    system: SYSTEM_PROMPT,
    tools: [PROPOSE_QUOTE_TOOL],
    tool_choice: { type: 'tool', name: 'propose_quote' },
    messages: [{ role: 'user', content: text }],
  }),
  signal: AbortSignal.timeout(30_000),
})
```
Check Anthropic's current docs for exact request fields, model names and prompt caching before building.

- **Customers are matched on the server.** The model only returns the name the user said. The server looks it up: one match uses it; several matches ask the user to pick; no match offers "create new customer" for the user to confirm. **The customer list is not sent to the model**, which limits data sharing.
- **Catalogue is sent** (id, name, unit, price) up to a cap (for example 150 items), so the model can match "pipe repair" to the right item.

## The rule that matters most: no invented prices

Implemented and tested in `ai-quote.ts`:
- A price is accepted only if it is **from the catalogue** (the server overrides whatever number the model returned) or **the user actually wrote that number** (the number must appear in their message, including forms like `2,500` and `5k`).
- Everything else is left at 0 and flagged `needsPrice`. The editor should show those lines highlighted and block **Send** until they are filled.
- Quantities, descriptions, line counts and text lengths are bounded; bad lines are dropped with a warning rather than silently accepted.

## Credits and billing

- **1 credit = 1 successful draft quote.** Failed or unusable results cost nothing. Simple to explain to a plumber.
- **Trial:** a free allowance at workspace creation (the number is yours to set, say 20 to start), granted once per organisation. Watch for people abusing sign-ups for free credits.
- **After the trial:** buy packs by M-Pesa STK (reuse the existing NCBA STK code). Use a **new** purchase table rather than the subscription payment table, because subscription activation logic assumes a subscription.
- **Ledger, not a counter.** Proposed model (not applied):

```prisma
model AiCreditLedger {
  id             String       @id @default(cuid())
  organisationId String
  organisation   Organisation @relation(fields: [organisationId], references: [id], onDelete: Cascade)
  delta          Int          // +grant / +pack purchase / -1 per draft / +refund / +admin adjustment
  reason         String       // TRIAL_GRANT | PACK_PURCHASE | QUOTE_DRAFT | REFUND | ADMIN_ADJUST
  sourceKey      String       @unique   // idempotency, e.g. "draft:<idempotencyKey>"
  createdAt      DateTime     @default(now())

  @@index([organisationId, createdAt])
}
```
  Balance is the sum of `delta`. Debit inside a transaction and re-check the balance there so two simultaneous requests cannot overspend.
- **Pack sizes and prices:** decide after measuring real cost per draft in the pilot (tokens in and out per call, at current Anthropic prices). Price each credit comfortably above cost, and remember M-Pesa fees.

## Safety and abuse

- **Authenticated and tenant-scoped.** The workspace always comes from the session, never from the model or the request body.
- **Limits:** input capped at 2,000 characters; a per-workspace rate limit (for example 10 drafts a minute); a global monthly spend ceiling with a kill switch (env flag) so a bug cannot run up a bill.
- **Prompt injection:** in the MVP the only free text going to the model is what the signed-in user typed, plus their own catalogue. Do **not** add customer messages, decision comments or inbound email to the prompt until the later "draft replies" feature, and treat all of that as untrusted data when you do.
- **No dangerous tools in the MVP.** The model can only propose a quote. It cannot send, delete, record payments or issue refunds. Keep it that way for payments and refunds permanently unless you add a separate strong confirmation.
- **Audit:** record each AI event (organisation, user, model, tokens in and out, outcome, timestamp). Decide whether to store the text; if you do, tell users and delete it after a short period.
- **Currency and tax** come from the organisation's settings, not the model.

## Privacy and legal (needs a professional)

Customer and pricing data would be sent to Anthropic's API. Before launch: update your privacy policy
and customer terms to disclose it, review the current API data-handling terms, and check Kenya Data
Protection Act obligations (consent, purpose, cross-border transfer). I am not a lawyer; please have
one review this.

## Voice notes

Typed text works first. **Phone keyboards already have a microphone/dictation button**, which gives
"voice" in the text box for free. A true voice-note upload needs speech-to-text, and to my knowledge
the Anthropic API does not transcribe audio, so you would add a separate provider. Test candidates
on Kenyan English, Swahili and Sheng mixed speech before choosing; accuracy varies a lot.

## Quality: test before trusting

- Build a test set of **40 to 50 real phrasings** from pilot users (English, Swahili and code-switched). For each, record the expected lines.
- Measure: lines found, correct catalogue matches, and **invented prices (target: zero)**. Also track how often users edit the draft and how often they abandon it.
- Re-run the set whenever the prompt or model changes.

## Build order

1. Add `ANTHROPIC_API_KEY` and `AI_QUOTE_MODEL` to the environment (production and local). *You do this.*
2. Prisma: `AiCreditLedger` (and an AI event log), trial grant on workspace creation.
3. Endpoint `POST /api/ai/quote-draft` with credits, rate limit and `validateProposal`.
4. Web: a "Describe the job" box on the new-quote screen, showing the draft, highlighted blanks, assumptions and questions.
5. Credit meter in the app and a **buy credits** flow with M-Pesa STK.
6. Pilot with a handful of businesses; run the test set; adjust the prompt.
7. Only then: send/resend by the assistant with an approval card, invoice drafting, reply drafting.

## Open decisions for you

- Trial allowance (credits per new workspace) and credit pack sizes and prices.
- Who owns the Anthropic account and billing, and a monthly spend ceiling.
- Speech-to-text provider (or defer voice notes).
- How long to keep the text of requests, if at all.
- Languages to support at launch (English only, or English and Swahili).
