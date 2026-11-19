# Stage 13 — Marketplace Pilot Schema Design

**Status:** Design only — do not add to `schema.prisma` or create migrations until Stage 12 produces a GO or NARROW decision.
**Prerequisite:** Stage 12 GO or specific NARROW decision recorded in `docs/marketplace/DECISION_RECORD.md`
**Scope:** Pilot cohort only — approved category, geography, and user group from the Stage 12 decision.

---

## 1. Design Principles

1. **Reuse existing infrastructure:** Marketplace models build on the existing `Organisation`, `User`, `Customer`, and `Quote` models. No duplication of tenant boundaries, auth, or document generation.
2. **Privacy by query:** Providers cannot see other invitations or proposals. Buyers cannot see proposals they didn't receive. This is enforced at the Prisma `where` clause level, not just in the UI.
3. **Audit everything:** Every marketplace action (RFQ create, invite, proposal submit, select, withdraw, expire) is written to `MarketplaceAudit`.
4. **Proposals are not quotes:** A marketplace proposal is a provider's response to an RFQ. When the buyer selects it, it converts to an ordinary `Quote` in the buyer's organisation. The proposal record is retained for audit.
5. **Tenant-safe:** All models are scoped to `Organisation`. The `requireAuth` + `organisationId` pattern from existing routes applies to all marketplace endpoints.
6. **Pilot-scoped:** Models include `verificationStatus` and pilot cohort markers so non-pilot organisations are excluded from marketplace features.

---

## 2. Models

### 2.1 MarketplaceProfile

Extends `Organisation` for marketplace participation. An organisation can act as a buyer (posts RFQs), a provider (receives invitations and submits proposals), or both.

```prisma
model MarketplaceProfile {
  id                String   @id @default(cuid())
  organisationId    String   @unique
  organisation      Organisation @relation(fields: [organisationId], references: [id], onDelete: Cascade)
  role              String   @default("BUYER") // BUYER | PROVIDER | BOTH
  serviceCategories Json     @default("[]") // ["printing", "signage", "branding"]
  coverageAreas     Json     @default("[]") // ["Nairobi", "Kiambu", "Machakos"]
  capacityPerMonth  Int?     // max jobs per month
  verificationStatus String  @default("UNVERIFIED") // UNVERIFIED | PENDING | VERIFIED | REJECTED
  verifiedAt        DateTime?
  verifiedBy        String?  // admin userId
  pilotCohort       Boolean  @default(false) // true = part of approved pilot cohort
  active            Boolean  @default(true)
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt

  rfqsCreated       RFQ[]    @relation("BuyerRFQs")
  invitations       RFQInvitation[]
  proposals         MarketplaceProposal[]

  @@index([role, active, verificationStatus])
  @@index([pilotCohort, active])
}
```

**Field notes:**
- `serviceCategories`: JSON array of category strings. During pilot, categories are restricted to the approved set from Stage 12.
- `coverageAreas`: JSON array of geographic area strings. Used for matching.
- `verificationStatus`: Admin-controlled. Only VERIFIED providers can receive invitations in the pilot.
- `pilotCohort`: Boolean flag. Only organisations with `pilotCohort = true` participate in the pilot. This makes it easy to exclude non-pilot organisations and to wind down the pilot.

### 2.2 RFQ (Request for Quote)

A buyer's request posted to the marketplace. The buyer is the `Organisation` that creates the RFQ.

```prisma
enum RFQStatus {
  DRAFT
  OPEN
  CLOSED
  AWARDED
  EXPIRED
}

model RFQ {
  id                String      @id @default(cuid())
  buyerOrganisationId String
  buyerOrganisation Organisation @relation("BuyerRFQs", fields: [buyerOrganisationId], references: [id], onDelete: Cascade)
  buyerCustomerId   String?     // link to Customer if the RFQ is for a specific customer
  scope             String      // description of what is needed
  category          String      // must match an approved pilot category
  location          String      // geographic location of the work
  timingNeeded      String      // when the work is needed
  timingFlexibility String?     // flexible / exact / urgent
  budgetMin         Decimal?    @db.Decimal(14, 2)
  budgetMax         Decimal?    @db.Decimal(14, 2)
  budgetVisible     Boolean     @default(true) // can providers see the budget range?
  attachments       Json        @default("[]") // [{filename, url, mimeType}]
  deadline          DateTime    // deadline for proposal submission
  eligibilityNotes  String?     // any specific provider requirements
  status            RFQStatus   @default(DRAFT)
  createdBy         String      // userId of the buyer's user who created it
  createdAt         DateTime    @default(now())
  updatedAt         DateTime    @updatedAt
  closedAt          DateTime?
  awardedAt         DateTime?

  invitations       RFQInvitation[]
  proposals         MarketplaceProposal[]
  auditEntries      MarketplaceAudit[]

  @@index([buyerOrganisationId, status, createdAt])
  @@index([category, status, deadline])
  @@index([status, deadline])
}
```

**Field notes:**
- `buyerCustomerId`: Optional link to the existing `Customer` model if the RFQ is for a specific customer of the buyer's organisation.
- `budgetVisible`: If false, providers see "budget not disclosed" instead of the range. Some buyers prefer not to anchor providers on price.
- `eligibilityNotes`: Free-text requirements (e.g., "must have offset printing capability", "must be able to deliver to Westlands").
- `status` transitions:
  - DRAFT → OPEN (buyer publishes)
  - OPEN → CLOSED (deadline passed or buyer closes early)
  - OPEN → AWARDED (buyer selects a proposal)
  - OPEN/CLOSED → EXPIRED (no selection within a grace period after deadline)

### 2.3 RFQInvitation

A private invitation to a specific provider organisation to submit a proposal for an RFQ.

```prisma
enum InvitationStatus {
  PENDING
  ACCEPTED
  DECLINED
  EXPIRED
}

model RFQInvitation {
  id                String   @id @default(cuid())
  rfqId             String
  rfq               RFQ      @relation(fields: [rfqId], references: [id], onDelete: Cascade)
  providerOrganisationId String
  providerOrganisation Organisation @relation(fields: [providerOrganisationId], references: [id], onDelete: Cascade)
  providerProfileId String
  providerProfile   MarketplaceProfile @relation(fields: [providerProfileId], references: [id], onDelete: Cascade)
  status            InvitationStatus @default(PENDING)
  sentAt            DateTime @default(now())
  respondedAt       DateTime?
  acceptedAt        DateTime?
  declinedAt        DateTime?
  expiredAt         DateTime?
  createdBy         String   // userId who sent the invitation (buyer or system)

  auditEntries      MarketplaceAudit[]

  @@unique([rfqId, providerOrganisationId]) // no duplicate invitations
  @@index([providerOrganisationId, status])
  @@index([rfqId, status])
}
```

**Privacy enforcement:**
- A provider querying `RFQInvitation` can only see rows where `providerOrganisationId = req.organisationId`.
- There is no endpoint that lists invitations for an RFQ visible to providers. Only the buyer and platform admins can see the full invitation list for an RFQ.
- The `@@unique([rfqId, providerOrganisationId])` constraint prevents accidental double-invitation.

### 2.4 MarketplaceProposal

A provider's response to an RFQ they were invited to.

```prisma
enum ProposalStatus {
  SUBMITTED
  WITHDRAWN
  SELECTED
  DECLINED
}

model MarketplaceProposal {
  id                String   @id @default(cuid())
  rfqId             String
  rfq               RFQ      @relation(fields: [rfqId], references: [id], onDelete: Cascade)
  providerOrganisationId String
  providerOrganisation Organisation @relation(fields: [providerOrganisationId], references: [id], onDelete: Cascade)
  providerProfileId String
  providerProfile   MarketplaceProfile @relation(fields: [providerProfileId], references: [id], onDelete: Cascade)
  invitationId      String   @unique
  invitation        RFQInvitation @relation(fields: [invitationId], references: [id], onDelete: Restrict)
  lineItems         Json     // [{description, quantity, unit, unitPrice, taxRate}]
  terms             String?
  timeline          String   // when they can do it, how long it takes
  total             Decimal  @db.Decimal(14, 2)
  taxTotal          Decimal  @default(0) @db.Decimal(14, 2)
  subtotal          Decimal  @default(0) @db.Decimal(14, 2)
  currency          String   @default("KES")
  notes             String?
  status            ProposalStatus @default(SUBMITTED)
  submittedAt       DateTime @default(now())
  withdrawnAt       DateTime?
  selectedAt        DateTime?
  declinedAt        DateTime?
  convertedQuoteId  String?  // link to Quote if selected and converted
  createdBy         String   // userId of the provider's user who submitted

  auditEntries      MarketplaceAudit[]

  @@index([rfqId, status])
  @@index([providerOrganisationId, status])
}
```

**Privacy enforcement:**
- A buyer querying proposals sees only rows where `rfq.buyerOrganisationId = req.organisationId`.
- A provider querying proposals sees only rows where `providerOrganisationId = req.organisationId`.
- There is no endpoint that returns all proposals for an RFQ to a provider. Providers see only their own proposal(s).
- `convertedQuoteId`: Set when the buyer selects this proposal and it is converted to a `Quote`. Links the marketplace world to the existing quote workflow.

### 2.5 MarketplaceAudit

Audit trail for all marketplace actions. Append-only — records are never modified or deleted.

```prisma
enum AuditAction {
  RFQ_CREATED
  RFQ_PUBLISHED
  RFQ_CLOSED
  RFQ_EXPIRED
  RFQ_AWARDED
  INVITATION_SENT
  INVITATION_ACCEPTED
  INVITATION_DECLINED
  INVITATION_EXPIRED
  PROPOSAL_SUBMITTED
  PROPOSAL_WITHDRAWN
  PROPOSAL_SELECTED
  PROPOSAL_DECLINED
  PROPOSAL_CONVERTED_TO_QUOTE
  PROFILE_VERIFIED
  PROFILE_REJECTED
  PROFILE_DEACTIVATED
  MODERATION_FLAGGED
  MODERATION_RESOLVED
}

model MarketplaceAudit {
  id              String   @id @default(cuid())
  action          AuditAction
  actorUserId     String?  // who performed the action
  actorOrganisationId String? // which organisation
  rfqId           String?
  rfq             RFQ?     @relation(fields: [rfqId], references: [id], onDelete: SetNull)
  invitationId    String?
  invitation      RFQInvitation? @relation(fields: [invitationId], references: [id], onDelete: SetNull)
  proposalId      String?
  proposal        MarketplaceProposal? @relation(fields: [proposalId], references: [id], onDelete: SetNull)
  targetOrganisationId String? // organisation affected by the action
  detail          Json?    // additional context (old status, new status, reason, etc.)
  ipAddress       String?
  createdAt       DateTime @default(now())

  @@index([action, createdAt])
  @@index([actorOrganisationId, createdAt])
  @@index([rfqId, createdAt])
}
```

**Audit requirements:**
- Every state transition (RFQ status change, invitation status change, proposal status change) writes an audit entry.
- Every admin action (verification, moderation) writes an audit entry.
- Audit entries are append-only. No `updatedAt` — the model has only `createdAt`.
- `detail` captures before/after states and free-text reasons.

---

## 3. Schema Relationships Diagram

```
Organisation (existing)
  │
  ├── 1:1 ── MarketplaceProfile
  │             │
  │             ├── 1:N ── RFQ (as buyer, via buyerOrganisationId on RFQ)
  │             ├── 1:N ── RFQInvitation (as provider)
  │             └── 1:N ── MarketplaceProposal (as provider)
  │
  ├── 1:N ── RFQ (buyerOrganisationId)
  ├── 1:N ── RFQInvitation (providerOrganisationId)
  ├── 1:N ── MarketplaceProposal (providerOrganisationId)
  └── 1:N ── Quote (existing, from converted proposals)

RFQ
  ├── N:1 ── Organisation (buyer)
  ├── 1:N ── RFQInvitation
  ├── 1:N ── MarketplaceProposal
  └── 1:N ── MarketplaceAudit

RFQInvitation
  ├── N:1 ── RFQ
  ├── N:1 ── Organisation (provider)
  ├── N:1 ── MarketplaceProfile (provider)
  └── 1:1 ── MarketplaceProposal (invitationId is unique on proposal)

MarketplaceProposal
  ├── N:1 ── RFQ
  ├── N:1 ── Organisation (provider)
  ├── N:1 ── MarketplaceProfile (provider)
  ├── N:1 ── RFQInvitation (unique)
  └── N:1?── Quote (convertedQuoteId, set when selected & converted)

MarketplaceAudit
  ├── N:1?── RFQ
  ├── N:1?── RFQInvitation
  └── N:1?── MarketplaceProposal

Customer (existing) ←── RFQ.buyerCustomerId (optional)
Quote (existing)    ←── MarketplaceProposal.convertedQuoteId (optional)
```

---

## 4. Privacy Rules Enforcement at Query Level

Privacy is enforced in the API layer using Prisma `where` clauses, not in the UI. These are the patterns for each participant type.

### 4.1 Provider queries

**Provider sees their invitations:**
```typescript
prisma.rFQInvitation.findMany({
  where: {
    providerOrganisationId: req.organisationId,
    // NOT including rfqId in a way that reveals other invitees
  },
  include: {
    rfq: { select: { id: true, scope: true, category: true, location: true, deadline: true } }
  }
})
```
- Provider queries are always filtered by `providerOrganisationId = req.organisationId`.
- Provider never gets a list of invitations for an RFQ — only their own.
- Provider cannot query `RFQInvitation` by `rfqId` alone.

**Provider sees their own proposals:**
```typescript
prisma.marketplaceProposal.findMany({
  where: {
    providerOrganisationId: req.organisationId,
  }
})
```
- Provider sees only their own proposals. No endpoint returns proposals by `rfqId` for providers.

**Provider cannot see other proposals on an RFQ:**
- There is no `GET /api/marketplace/rfqs/:id/proposals` endpoint accessible to providers.
- The proposal list endpoint for providers is `GET /api/marketplace/proposals` (their own only).

### 4.2 Buyer queries

**Buyer sees their own RFQs:**
```typescript
prisma.rFQ.findMany({
  where: {
    buyerOrganisationId: req.organisationId,
  }
})
```

**Buyer sees proposals only for their own RFQs:**
```typescript
prisma.marketplaceProposal.findMany({
  where: {
    rfq: {
      buyerOrganisationId: req.organisationId,
    },
    status: { in: ['SUBMITTED', 'SELECTED', 'DECLINED'] }
  }
})
```
- Buyer cannot see WITHDRAWN proposals (those are filtered out).
- Buyer queries are always scoped through the `rfq.buyerOrganisationId` relation.

**Buyer sees invitations for their own RFQs:**
```typescript
prisma.rFQInvitation.findMany({
  where: {
    rfq: {
      buyerOrganisationId: req.organisationId,
    }
  }
})
```
- Buyer can see which providers they invited (it's their RFQ).
- But the buyer cannot see other buyers' RFQs or invitations.

### 4.3 Admin queries

**Superadmin sees all marketplace data via moderation views:**
- `GET /api/superadmin/marketplace/rfqs` — all RFQs with pagination
- `GET /api/superadmin/marketplace/proposals` — all proposals
- `GET /api/superadmin/marketplace/audit` — audit trail

These endpoints require `requireSuperadmin` middleware. Every admin query is itself logged to `MarketplaceAudit`.

### 4.4 Query-level privacy summary

| Action | Provider | Buyer (RFQ owner) | Superadmin |
|---|---|---|---|
| See RFQ details | Only invited RFQs | Own RFQs only | All |
| See invitations | Own invitations only | Own RFQ's invitations | All |
| See proposals | Own proposals only | Own RFQ's proposals | All |
| See other providers' proposals | Never | Never | Yes (audited) |
| See other buyers' RFQs | Never | Never | Yes (audited) |

---

## 5. Proposal-to-Quote Conversion

When a buyer selects a proposal, the marketplace proposal converts to an ordinary `Quote` in the buyer's organisation. This connects the marketplace to the existing quote workflow.

### Conversion procedure (design — not yet implemented):

1. **Buyer selects proposal:** `POST /api/marketplace/rfqs/:rfqId/proposals/:proposalId/select`
   - Sets `MarketplaceProposal.status = SELECTED`
   - Sets `RFQ.status = AWARDED`
   - Sets all other proposals for this RFQ to `DECLINED`
   - Writes audit entries for each state change

2. **System creates Quote:**
   - Creates a new `Quote` in the buyer's `Organisation` with:
     - `organisationId = rfq.buyerOrganisationId`
     - `customerId = rfq.buyerCustomerId` (or creates a new Customer if not set)
     - `currency = proposal.currency`
     - `subtotal`, `taxTotal`, `total` copied from proposal
     - `status = DRAFT` (buyer reviews before sending)
   - Creates `QuoteLine` records from `proposal.lineItems` JSON
   - Sets `proposal.convertedQuoteId = quote.id`
   - Writes `PROPOSAL_CONVERTED_TO_QUOTE` audit entry

3. **Buyer reviews and sends quote:**
   - The quote appears in the buyer's normal Quotes list
   - Buyer can edit, add notes, adjust terms before sending
   - Once sent, it follows the existing quote workflow (SENT → VIEWED → APPROVED/DECLINED)
   - The quote is an ordinary quote — no marketplace-specific fields on the Quote model

4. **Provider notification:**
   - Provider is notified that their proposal was selected
   - Provider does NOT see the final quote (that's the buyer's document)
   - Provider sees only `proposal.status = SELECTED` in their proposals list

### Why proposals are not quotes:
- A proposal is the provider's offer. A quote is the buyer's document sent to their customer.
- The conversion step creates a proper `Quote` with correct numbering, tax rules, and terms from the buyer's organisation settings.
- The proposal is retained as an immutable record of what the provider offered.

---

## 6. Audit Trail Requirements

### What must be audited:

| Event | AuditAction | Actor | Detail to capture |
|---|---|---|---|
| RFQ created | RFQ_CREATED | buyer user | `{rfqId, category, location}` |
| RFQ published | RFQ_PUBLISHED | buyer user | `{rfqId, deadline}` |
| RFQ closed manually | RFQ_CLOSED | buyer user | `{rfqId, reason}` |
| RFQ expired | RFQ_EXPIRED | system | `{rfqId, expiredAt}` |
| Invitation sent | INVITATION_SENT | buyer user | `{rfqId, providerOrganisationId}` |
| Invitation accepted | INVITATION_ACCEPTED | provider user | `{rfqId, providerOrganisationId}` |
| Invitation declined | INVITATION_DECLINED | provider user | `{rfqId, providerOrganisationId, reason?}` |
| Invitation expired | INVITATION_EXPIRED | system | `{rfqId, providerOrganisationId}` |
| Proposal submitted | PROPOSAL_SUBMITTED | provider user | `{rfqId, proposalId, total}` |
| Proposal withdrawn | PROPOSAL_WITHDRAWN | provider user | `{rfqId, proposalId, reason?}` |
| Proposal selected | PROPOSAL_SELECTED | buyer user | `{rfqId, proposalId, providerOrganisationId}` |
| Proposal declined (not selected) | PROPOSAL_DECLINED | buyer user/system | `{rfqId, proposalId}` |
| Proposal converted to quote | PROPOSAL_CONVERTED_TO_QUOTE | system | `{proposalId, quoteId}` |
| Profile verified | PROFILE_VERIFIED | superadmin | `{organisationId}` |
| Profile rejected | PROFILE_REJECTED | superadmin | `{organisationId, reason}` |
| Profile deactivated | PROFILE_DEACTIVATED | superadmin | `{organisationId, reason}` |
| Moderation flag | MODERATION_FLAGGED | any user/superadmin | `{targetType, targetId, reason}` |
| Moderation resolved | MODERATION_RESOLVED | superadmin | `{targetType, targetId, resolution}` |

### Audit query patterns:
- By RFQ: `GET /api/marketplace/rfqs/:id/audit` (buyer or superadmin)
- By organisation: `GET /api/marketplace/audit?organisationId=X` (superadmin)
- By action type: `GET /api/marketplace/audit?action=PROPOSAL_SELECTED` (superadmin)
- By date range: `GET /api/marketplace/audit?from=...&to=...` (superadmin)

### Audit retention:
- Audit entries are retained for the lifetime of the marketplace pilot plus 90 days.
- If the pilot is STOPPED, audit entries are retained per the data retention rules in `INTEGRATION_POINTS.md`.

---

## 7. Migration Plan (when approved)

When Stage 12 produces a GO or NARROW decision, the schema is added via a versioned Prisma migration:

1. Add the five models to `schema.prisma`
2. Run `prisma migrate dev --name add_marketplace_pilot` in a development environment
3. Review the generated migration SQL
4. Test against a non-production database copy
5. Deploy via the established migration procedure from Stage 9

**No `prisma db push` in production.** The migration is versioned and reviewed.

### Indexes to verify:
- `MarketplaceProfile`: `(role, active, verificationStatus)` and `(pilotCohort, active)` — for provider matching queries
- `RFQ`: `(buyerOrganisationId, status, createdAt)` — for buyer's RFQ list; `(category, status, deadline)` — for matching; `(status, deadline)` — for expiry sweeps
- `RFQInvitation`: `(providerOrganisationId, status)` — for provider inbox; `(rfqId, status)` — for buyer's invitation overview
- `MarketplaceProposal`: `(rfqId, status)` — for buyer's proposal view; `(providerOrganisationId, status)` — for provider's proposal list
- `MarketplaceAudit`: `(action, createdAt)`, `(actorOrganisationId, createdAt)`, `(rfqId, createdAt)` — for audit queries

---

## 8. API Endpoint Design (reference — not yet implemented)

These endpoints are documented for planning. Implementation happens in Stage 13 after the schema migration.

### Buyer endpoints:
- `POST /api/marketplace/rfqs` — create RFQ (draft)
- `POST /api/marketplace/rfqs/:id/publish` — publish RFQ and send invitations
- `GET /api/marketplace/rfqs` — list own RFQs
- `GET /api/marketplace/rfqs/:id` — view own RFQ with invitations and proposals
- `POST /api/marketplace/rfqs/:id/proposals/:proposalId/select` — select a proposal
- `POST /api/marketplace/rfqs/:id/close` — close RFQ without awarding

### Provider endpoints:
- `GET /api/marketplace/invitations` — list own invitations
- `GET /api/marketplace/invitations/:id` — view invitation details (includes RFQ)
- `POST /api/marketplace/invitations/:id/accept` — accept invitation
- `POST /api/marketplace/invitations/:id/decline` — decline invitation
- `POST /api/marketplace/proposals` — submit proposal (requires accepted invitation)
- `GET /api/marketplace/proposals` — list own proposals
- `POST /api/marketplace/proposals/:id/withdraw` — withdraw proposal (before deadline)

### Profile endpoints:
- `GET /api/marketplace/profile` — view own marketplace profile
- `PUT /api/marketplace/profile` — update service categories, coverage areas, capacity

### Superadmin endpoints:
- `GET /api/superadmin/marketplace/rfqs` — list all RFQs (paginated)
- `GET /api/superadmin/marketplace/proposals` — list all proposals
- `GET /api/superadmin/marketplace/audit` — audit trail
- `POST /api/superadmin/marketplace/profiles/:id/verify` — verify a provider
- `POST /api/superadmin/marketplace/profiles/:id/reject` — reject a provider
- `POST /api/superadmin/marketplace/profiles/:id/deactivate` — deactivate a profile
- `POST /api/superadmin/marketplace/flag` — flag content for moderation
- `POST /api/superadmin/marketplace/flags/:id/resolve` — resolve moderation flag

---

## 9. Matching Algorithm Design

Matching is explainable eligibility filtering — not a black-box ranking.

### Eligibility filters (all must pass):
1. `MarketplaceProfile.role` includes PROVIDER or BOTH
2. `MarketplaceProfile.verificationStatus = VERIFIED`
3. `MarketplaceProfile.active = true`
4. `MarketplaceProfile.pilotCohort = true`
5. `RFQ.category` is in `MarketplaceProfile.serviceCategories`
6. `RFQ.location` is in `MarketplaceProfile.coverageAreas`
7. `MarketplaceProfile.capacityPerMonth` > current active proposals for the month (if set)

### Ranking signals (after eligibility, for ordering):
- **Proximity:** Exact area match ranked above broader coverage
- **Response history:** Providers who responded to previous invitations rank higher
- **Selection history:** Providers who were previously selected rank higher
- **Verification recency:** More recently verified providers rank higher

### Manual override:
- The buyer (or operator in concierge mode) can always manually select providers instead of using the algorithm.
- The system shows the eligibility reasons for each matched provider (e.g., "Matches: printing, Nairobi, verified 2027-03-01").
- No match is automatic without the buyer's confirmation. The buyer reviews and confirms which providers to invite.

### Fairness checks:
- Track invitation distribution across providers. If one provider receives > 60% of invitations in a month, flag for review.
- Track selection distribution. If one provider is selected > 60% of the time, investigate whether the matching is biased or the provider is genuinely dominant.
