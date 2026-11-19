# Marketplace Integration Points

**Status:** Design reference for when Stage 13 pilot is approved
**Prerequisite:** Stage 12 GO or NARROW decision
**Scope:** How marketplace proposals connect to existing quote workflow, Stage 14 job connections, data retention if pilot is stopped.

---

## 1. How Marketplace Proposals Connect to the Existing Quote Workflow

### 1.1 The connection point

A marketplace proposal is a provider's response to an RFQ. When the buyer selects it, the proposal converts to an ordinary `Quote` in the buyer's organisation. From that point forward, it is a normal quote — no marketplace-specific fields on the Quote model.

```
RFQ → RFQInvitation → MarketplaceProposal → [BUYER SELECTS] → Quote (DRAFT) → Quote (SENT) → Quote (APPROVED/DECLINED)
```

### 1.2 Conversion mechanism

When the buyer selects a proposal (`POST /api/marketplace/rfqs/:rfqId/proposals/:proposalId/select`):

1. `MarketplaceProposal.status` → `SELECTED`
2. `RFQ.status` → `AWARDED`
3. All other proposals for that RFQ → `DECLINED`
4. A new `Quote` is created in the buyer's `Organisation`:
   - `organisationId` = `rfq.buyerOrganisationId`
   - `customerId` = `rfq.buyerCustomerId` (or creates a new `Customer` if the RFQ didn't link one)
   - `currency` = `proposal.currency`
   - `subtotal`, `taxTotal`, `total` copied from proposal
   - `status` = `DRAFT`
   - `documentNumber` assigned via existing `QuoteSequence` mechanism
5. `QuoteLine` records created from `proposal.lineItems` JSON:
   - Each line item: `description`, `quantity`, `unit`, `unitPrice`, `taxRate`, `position`
6. `MarketplaceProposal.convertedQuoteId` = new `Quote.id`
7. Audit entries written: `PROPOSAL_SELECTED`, `PROPOSAL_DECLINED` (for each non-selected), `PROPOSAL_CONVERTED_TO_QUOTE`

### 1.3 What the buyer does next

The converted quote appears in the buyer's normal Quotes list with status `DRAFT`. The buyer can:
- Edit line items (adjust quantities, add notes, change terms)
- Add or remove items
- Change the currency (rare, but possible)
- Apply organisation-level tax defaults
- Add the organisation's standard terms
- Send the quote to their customer via the existing share/email workflow

The quote is treated as any other quote. The existing quote lifecycle applies:
```
DRAFT → SENT → VIEWED → APPROVED / DECLINED / EXPIRED
```

### 1.4 What the provider sees

The provider sees only:
- Their proposal status changed to `SELECTED`
- A notification that they were selected
- They do NOT see the final quote (that's the buyer's document)
- They do NOT see the buyer's customer details (unless the buyer chooses to share them directly)

### 1.5 What happens if the buyer edits the converted quote

The buyer can edit the draft quote freely. The original proposal is retained as an immutable record — `MarketplaceProposal` is not modified when the quote is edited. The audit trail shows:
- What the provider proposed (in the proposal record)
- What the buyer sent to their customer (in the quote record)

If the buyer makes significant changes (e.g., removes line items, changes the price), those changes are tracked in the quote's own history, not in the marketplace proposal. The proposal is a point-in-time record of what was offered.

### 1.6 Existing infrastructure reused

| Existing component | Reuse in marketplace |
|---|---|
| `Organisation` | Buyer and provider organisations (already exist) |
| `User` | Buyer and provider users (already exist) |
| `Customer` | Optional link from RFQ to a specific customer |
| `Quote` | Created when proposal is selected |
| `QuoteLine` | Created from proposal line items |
| `QuoteSequence` | Provides document numbering for converted quotes |
| Quote PDF generation | Works on converted quotes (no changes needed) |
| Quote share/email | Works on converted quotes (no changes needed) |
| Public quote decision | Works on converted quotes (no changes needed) |
| Superadmin dashboard | Extended with marketplace moderation views |

### 1.7 Existing infrastructure NOT reused

| Component | Why not |
|---|---|
| `ServiceItem` | Proposals have their own line items that may not match catalogue items. Providers define their own line items per proposal. |
| `QuoteTemplate` | Proposals are free-form responses, not template-based. |
| `Subscription` | Pilot does not require paid subscriptions. Marketplace access is free during pilot. |

---

## 2. Where Stage 14 Jobs Connect

Stage 14 connects accepted quotes to delivery tracking (jobs). Marketplace proposals that convert to quotes and are then accepted by the customer follow the same path.

### 2.1 The full lifecycle

```
RFQ (marketplace)
  → MarketplaceProposal (provider responds)
    → Buyer selects proposal
      → Quote DRAFT (buyer's workspace)
        → Buyer sends quote to customer
          → Customer approves
            → Job (Stage 14, delivery tracking)
              → Costs, milestones, payments
```

### 2.2 Quote-to-Job conversion (Stage 14 design)

When a quote (including one converted from a marketplace proposal) is approved by the customer:
- The quote status becomes `APPROVED`
- The buyer can convert it to a `Job` (Stage 14 model, not yet designed)
- The job preserves an immutable snapshot of the approved quote
- Job tracks: status, milestones, due dates, materials, labor, costs
- The `MarketplaceProposal.convertedQuoteId` link remains, so the audit trail can trace: RFQ → proposal → quote → job → costs → payments

### 2.3 Marketplace-specific job considerations

| Consideration | Approach |
|---|---|
| Does the provider see the job? | No. The job is in the buyer's organisation. The provider's involvement ends at proposal selection. The buyer contacts the provider directly to arrange delivery. |
| Is the provider's proposal used for job cost estimation? | Yes, indirectly. The approved quote (derived from the proposal) is the basis for job cost tracking. The buyer can compare actual costs against the quote total. |
| What if the buyer wants to send the job back to the marketplace? | They can create a new RFQ. Each RFQ is independent. There is no automatic "re-quote" mechanism. |
| What if the provider was also an iQuote customer? | The provider's own organisation has its own quotes and jobs. The marketplace proposal is in the buyer's context. There is no cross-organisation data sharing. |

### 2.4 Data flow diagram (marketplace → quote → job)

```
[Provider Org]                    [Buyer Org]                    [Customer]

MarketplaceProfile                RFQ (buyer creates)
       ↑                          ↓
RFQInvitation ←── (private) ── RFQInvitation
       ↓                          ↓
MarketplaceProposal               Proposal comparison
       ↓                          ↓
  (selected) ───────────────→ Quote (DRAFT)
                                  ↓
                            Quote (SENT) ──────────────→ Customer views
                                  ↓                          ↓
                            Quote (APPROVED) ←──────── Customer approves
                                  ↓
                            Job (Stage 14)
                                  ↓
                            Costs / Milestones / Payments
                                  ↓
                            Reports (Stage 14-15)
```

---

## 3. What Happens to Marketplace Data If the Pilot Is STOPPED

### 3.1 STOP scenarios

The pilot may be stopped for several reasons:
- Stage 12 concierge pilot produces a STOP decision (before any software is built)
- Stage 13 software pilot fails to meet continuation thresholds
- Business decision to discontinue marketplace features
- Legal or compliance requirement

### 3.2 Data categories

| Data category | Examples | Action on STOP |
|---|---|---|
| Marketplace profiles | `MarketplaceProfile` records | Deactivated, retained for 90 days, then deleted |
| RFQs | `RFQ` records | Retained for 90 days, then deleted |
| Invitations | `RFQInvitation` records | Retained for 90 days, then deleted |
| Proposals | `MarketplaceProposal` records | Retained for 90 days, then deleted |
| Converted quotes | `Quote` records (with `convertedQuoteId` link on proposal) | **Retained** — these are ordinary quotes in the buyer's workspace. They follow normal quote retention rules. |
| Audit trail | `MarketplaceAudit` records | Retained for 180 days, then deleted |
| User accounts | `User`, `Organisation` records | **Retained** — users and organisations are not marketplace-specific. They continue to use iQuote as a quoting tool. |
| Customers | `Customer` records | **Retained** — customers created through the marketplace are ordinary customers. |
| Attachments | RFQ/proposal attachments | Deleted with their parent records |

### 3.3 Wind-down procedure

If the pilot is stopped:

1. **Announce** to pilot cohort that marketplace features are being discontinued. Give 30 days notice.
2. **Close open RFQs:** All `OPEN` RFQs are set to `CLOSED`. Pending invitations expire. Providers are notified.
3. **Allow in-progress proposals to complete:** Proposals already submitted can be selected by buyers for 30 days after the announcement. No new RFQs can be created.
4. **Preserve converted quotes:** Quotes already created from selected proposals remain in the buyer's workspace. They are ordinary quotes with no marketplace dependency.
5. **Deactivate marketplace profiles:** Set `MarketplaceProfile.active = false` for all profiles. Marketplace UI is hidden. The sidebar "Market" and "Proposals" items are removed or hidden.
6. **Begin retention countdown:** Start the 90-day (data) and 180-day (audit) retention timers.
7. **Delete marketplace data** after retention period:
   - Delete `MarketplaceProposal` records (except those with `convertedQuoteId` — those keep the proposal record but it becomes read-only)
   - Delete `RFQInvitation` records
   - Delete `RFQ` records
   - Delete `MarketplaceProfile` records
   - Delete `MarketplaceAudit` records after 180 days

### 3.4 What remains after wind-down

After the marketplace is fully wound down:
- Organisations and users continue to use iQuote for quoting
- Quotes created from marketplace proposals remain as ordinary quotes
- Customers added through the marketplace remain in the buyer's customer directory
- The audit trail is available for 180 days for dispute resolution or compliance
- No marketplace-specific code runs (routes are disabled, models can be removed in a future migration)

### 3.5 Database migration for wind-down

A wind-down migration would:
1. Set all `MarketplaceProfile.active = false`
2. Set all `OPEN` RFQs to `CLOSED`
3. After the retention period, a cleanup migration drops the marketplace tables:
   - `MarketplaceAudit`
   - `MarketplaceProposal` (preserving `convertedQuoteId` references in a lightweight record if needed)
   - `RFQInvitation`
   - `RFQ`
   - `MarketplaceProfile`

The migration is reviewed and tested per the Stage 9 migration procedure.

---

## 4. Data Retention Rules for Marketplace-Specific Data

### 4.1 Retention periods

| Data type | Retention period | Rationale |
|---|---|---|
| RFQs | 90 days after pilot end or RFQ closure | Allows buyers to reference past RFQs. Not needed long-term. |
| RFQInvitations | 90 days after pilot end or invitation expiry | Short-lived data. No long-term value. |
| MarketplaceProposals (not selected) | 90 days after pilot end or proposal decline | Allows providers to reference past proposals briefly. |
| MarketplaceProposals (selected & converted) | Lifetime of the converted Quote + 90 days | The proposal is the origin record for the quote. Retained as long as the quote exists. |
| MarketplaceAudit | 180 days after pilot end | Dispute resolution and compliance. Longer than transactional data. |
| MarketplaceProfile | 90 days after pilot end | Allows re-activation if pilot resumes. |
| RFQ/proposal attachments | Deleted with parent record | No independent retention value. |
| Converted Quotes | Per existing quote retention policy | These are ordinary quotes. No special marketplace rule. |

### 4.2 Data access during retention

During the retention period:
- Buyers can view their own past RFQs and proposals (read-only)
- Providers can view their own past proposals (read-only)
- Superadmins can view all marketplace data via audit views (read-only)
- No new RFQs, invitations, or proposals can be created

### 4.3 Data deletion

After the retention period:
- Records are deleted via a Prisma migration (not ad-hoc deletes)
- Deletion is verified by checking row counts
- The deletion itself is noted in the application's operational log (not in MarketplaceAudit, since that table is being deleted)
- Any quotes with `convertedQuoteId` references retain the quote; the proposal reference becomes null if the proposal is deleted (the `onDelete: SetNull` relation handles this)

### 4.4 GDPR / data protection considerations

- Marketplace participants can request deletion of their data before the retention period expires
- Deletion requests are reviewed: if there is an active dispute or legal hold, deletion is deferred
- The right to erasure applies to `MarketplaceProfile`, `RFQ`, `RFQInvitation`, and `MarketplaceProposal` data
- The right to erasure does NOT apply to `MarketplaceAudit` (audit records are exempt as they serve a legitimate compliance purpose)
- Converted quotes follow the existing quote data protection policy

### 4.5 Export

Before deletion, participants can request an export of their marketplace data:
- Buyers: their RFQs, invitations sent, proposals received, selections made
- Providers: their invitations, proposals submitted, selection outcomes
- Exports are provided as JSON or CSV
- Exports do not include other participants' private data (e.g., a provider's export does not include other providers' proposals)

---

## 5. Integration Checklist (for Stage 13 implementation)

When Stage 13 is approved and implementation begins, verify these integration points:

### Existing systems that must work unchanged:
- [ ] Quote creation and numbering still works (QuoteSequence)
- [ ] Quote PDF generation works on converted quotes
- [ ] Quote share link and email delivery works on converted quotes
- [ ] Public quote decision workflow works on converted quotes
- [ ] Customer management works (new customers created from RFQ conversion)
- [ ] Tenant isolation is preserved (no cross-organisation marketplace data leakage)
- [ ] Superadmin dashboard still loads with marketplace views added
- [ ] Auth and session management unchanged

### New integration points to build:
- [ ] `MarketplaceProposal → Quote` conversion endpoint
- [ ] `MarketplaceProposal → QuoteLine` mapping
- [ ] Customer creation or linking during conversion
- [ ] Audit entry writing for all state transitions
- [ ] Marketplace moderation views in superadmin dashboard
- [ ] Marketplace sidebar items (Market, Proposals) conditionally shown only for pilot cohort
- [ ] Provider notification on selection
- [ ] Buyer notification on proposal submission

### Privacy verification:
- [ ] Provider cannot query other providers' proposals (negative test)
- [ ] Provider cannot see invitation list for an RFQ (negative test)
- [ ] Buyer cannot see proposals for RFQs they didn't create (negative test)
- [ ] Provider cannot see which other providers were invited (negative test)
- [ ] Superadmin marketplace queries are logged to audit (positive test)

### Stage 14 readiness:
- [ ] Converted quotes have `APPROVED` status that triggers job conversion (Stage 14)
- [ ] `MarketplaceProposal.convertedQuoteId` is queryable for audit trail
- [ ] Job creation from a marketplace-converted quote works identically to job creation from a manual quote
