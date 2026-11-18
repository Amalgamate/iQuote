# iQuote Database Audit

**Audit date:** 18 November 2026  
**Source inspected:** `api/prisma/schema.prisma` (199 lines), Prisma package/config, Compose and deployment scripts.  
**Scope limit:** no live/local database connection was made, and no customer data or credentials were read. The schema in this report is the checked-in Prisma model, not an independently introspected production database.

## Database platform and migration state

- Provider: PostgreSQL (`schema.prisma:6-8`).
- Data access: Prisma Client 5.22.x.
- The production Compose file pins `postgres:16-alpine`; local-development instructions use an installed PostgreSQL service. The user's local PostgreSQL 18 installation is not represented as the production database version.
- No `api/prisma/migrations/` directory or SQL migration files exist in this checkout. Deployment runs `npx prisma db push` (`deploy/deploy.sh` around line 100). Therefore there is no checked-in, ordered migration history, reviewed SQL change, or reliable rollback path.
- The schema uses `DATABASE_URL` from environment. Actual database schema drift cannot be determined without read-only introspection of the target database; no connection was attempted.

## Models and fields

| Model | Main fields | Ownership / purpose |
|---|---|---|
| `User` | `id` CUID, `name`, unique `email`, `passwordHash`, string `role`, `emailVerifiedAt`, `organisationId?`, timestamps | Account; can belong to one organisation through `organisationId` and own at most one organisation through `ownerId`. |
| `Organisation` | CUID, unique nullable `subdomain`, business name/contact/country/type, currency default KES, default tax, quote prefix, logo URL, payment instructions, terms, unique `ownerId`, timestamps | Tenant/workspace root. Related users, customers, services, templates, quotes, sequences, one subscription and one email config. |
| `TenantEmailSettings` | unique `organisationId`, provider string, encrypted Resend key ciphertext, sender name/email, custom domain, domain status/records JSON, verified time, timestamps | One per organisation; cascades when organisation is deleted. |
| `SignupVerification` | email primary key, code HMAC hash, expiry, verification timestamp, attempts, last sent, update time | Short-lived registration verification, not a tenant-owned model. The source deletes it after successful signup. |
| `Subscription` | unique `organisationId`, plan/status/interval strings, trial start/end, `simulated` flag, timestamps | One per tenant. Currently a simulated 14-day trial; no provider customer/subscription IDs or payment events. |
| `ServiceItem` | organisation FK, name/category/kind, description, unit, Decimal price and tax, active/starter flags, timestamps | Tenant catalogue for products/services. |
| `QuoteTemplate` | organisation FK, name/description/workflow, JSON line items, default notes/terms, starter flag, timestamps | Tenant quote-content starter/custom templates. Not visual PDF design templates. |
| `Session` | user FK, unique raw JWT `token`, expiry, created time | Active/revocable login session. Token is stored as a bearer credential rather than a hash. |
| `Customer` | nullable organisation FK, required owner FK, name/phone/email, timestamps | Tenant customer. The optional tenant FK permits unowned/legacy rows at DB level. |
| `Quote` | organisation and owner FKs, customer FK, document number, optional unique public token, enum status, currency, validity, notes/terms, Decimal totals, view/decision timestamps/comment, created/updated | Persisted quotation. One tenant/year sequence determines its number. |
| `QuoteLine` | quote FK, description, Decimal quantity/unit price/optional tax, unit, position | Quote line item. Cascades on quote deletion. |
| `QuoteSequence` | composite primary key (`organisationId`, `year`), `nextNumber` | Per-tenant/per-year number allocator. |

All identifiers are Prisma CUID strings except `QuoteSequence`, which has a composite key. Money and quantity fields use PostgreSQL Decimal types. `Quote.status` is a PostgreSQL enum: `DRAFT`, `SENT`, `VIEWED`, `APPROVED`, `DECLINED`, `EXPIRED`. Other domain fields such as user role, plan, subscription status, provider, and service kind are free-form strings.

## Relationships and ER diagram

```mermaid
erDiagram
  USER ||--o| ORGANISATION : owns
  ORGANISATION ||--o{ USER : members
  USER ||--o{ SESSION : has
  USER ||--o{ CUSTOMER : created_by
  ORGANISATION o|--o{ CUSTOMER : scopes
  USER ||--o{ QUOTE : owns
  ORGANISATION ||--o{ QUOTE : scopes
  CUSTOMER ||--o{ QUOTE : receives
  QUOTE ||--|{ QUOTE_LINE : contains
  ORGANISATION ||--o{ SERVICE_ITEM : catalogues
  ORGANISATION ||--o{ QUOTE_TEMPLATE : configures
  ORGANISATION ||--o| SUBSCRIPTION : subscribes
  ORGANISATION ||--o| TENANT_EMAIL_SETTINGS : configures
  ORGANISATION ||--o{ QUOTE_SEQUENCE : numbers

  USER {
    string id PK
    string email UK
    string role
    string organisationId FK
    string passwordHash
  }
  ORGANISATION {
    string id PK
    string subdomain UK
    string ownerId FK_UK
    string currency
    string businessType
  }
  SESSION {
    string id PK
    string userId FK
    string token UK
    datetime expiresAt
  }
  CUSTOMER {
    string id PK
    string organisationId FK_nullable
    string ownerId FK
    string name
  }
  QUOTE {
    string id PK
    string organisationId FK
    string ownerId FK
    string customerId FK
    string documentNumber
    string publicToken UK_nullable
    enum status
    decimal subtotal
    decimal taxTotal
    decimal total
  }
  QUOTE_LINE {
    string id PK
    string quoteId FK
    decimal quantity
    decimal unitPrice
    decimal taxRate
  }
  SERVICE_ITEM {
    string id PK
    string organisationId FK
    string category
    string name
    decimal defaultPrice
  }
  QUOTE_TEMPLATE {
    string id PK
    string organisationId FK
    string name
    json lineItems
  }
  SUBSCRIPTION {
    string id PK
    string organisationId FK_UK
    string plan
    string status
    boolean simulated
  }
  TENANT_EMAIL_SETTINGS {
    string id PK
    string organisationId FK_UK
    string resendApiKeyCiphertext
    string domainStatus
  }
  QUOTE_SEQUENCE {
    string organisationId PK_FK
    int year PK
    int nextNumber
  }
  SIGNUP_VERIFICATION {
    string email PK
    string codeHash
    datetime expiresAt
  }
```

`SignupVerification` is intentionally outside tenant ownership. The ER diagram simplifies named Prisma relations and uses `o|` to denote the nullable organisation relation on `Customer`.

## Keys, constraints, indexes and deletes

- Unique: user email; organisation subdomain; organisation owner; one email-settings row and one subscription per organisation; service `(organisationId, category, name)`; template `(organisationId, name)`; quote public token; quote `(organisationId, documentNumber)`; session token.
- Composite primary key: quote sequence `(organisationId, year)`.
- Indexes: service `(organisationId, active, category)`; template `(organisationId, workflow)`; customer `(organisationId, updatedAt)` and `(ownerId, updatedAt)`; quote `(ownerId, updatedAt)` and `(organisationId, status, updatedAt)`; quote line `(quoteId, position)`.
- Cascades: tenant deletion cascades to email settings, subscription, services, templates, quotes and quote sequences; user deletion cascades to sessions/customers/quotes; quote deletion cascades to lines. Quote's customer relation is `onDelete: Restrict`.
- No soft-delete field exists. Service items have an `active` flag and are archived via update, but customers and quotes are hard-deleted under their route rules.
- User roles and subscription/provider status values are not database enums or check constraints.

## Multi-tenant integrity assessment

Every tenant-owned operational model except `SignupVerification` has an organisation ID or relates through a quote. `Quote`, `ServiceItem`, `QuoteTemplate`, `Subscription`, and `TenantEmailSettings` require an organisation. `Customer.organisationId` is nullable, though current customer creation requires an authenticated user's workspace and writes it.

The API mostly scopes queries by the authenticated user's resolved organisation. However, the schema does **not** enforce that:

1. `Quote.customerId` points to a customer with the same `organisationId` as that quote.
2. `Quote.ownerId` is a member of the quote's organisation.
3. `Customer.ownerId` belongs to its customer organisation.
4. `User.organisationId` is consistent with the organisation where that user is a member/owner.

Current API quote writes check that the customer matches the workspace, and authenticated endpoints generally derive the workspace from session identity. These are application-level protections, not database constraints. A future route, support script, import, or direct SQL operation could create cross-tenant references that appear valid at the FK level.

There is no PostgreSQL row-level security. The shared-database/shared-schema approach is reasonable for this stage but requires automated cross-tenant tests and consistent query scoping. A future stronger model would use composite tenant keys/foreign keys (e.g. `(organisationId, customerId)`) and optionally PostgreSQL RLS.

## Missing schema for the stated product direction

No models exist for invoices, payments, payment allocations, receipts, refunds, expenses, suppliers, jobs, production stages, attachments/documents beyond a logo URL, inventory, audit events, email delivery events, subscription provider events, or billing customers. There is also no quote revision model, discount model, or immutable financial transaction ledger. The current `Subscription` model is enough to show a plan/trial in the UI, not to bill or reconcile subscribers.

## Database priorities

1. Introduce Prisma migration history and stop relying on unreviewed schema push in production.
2. Add schema/application invariants for quote/customer/owner tenant consistency.
3. Add tests for deletion rules, unique quote numbering under concurrent requests, and tenant isolation.
4. Add indexes after measuring real query plans; retain organisation-first indexes as data grows.
5. Define audit/event tables before adding money movement, admin suspension, email-delivery history, or job-stage transitions.
6. Add an explicit backup/restore runbook and test it before handling financial records.

**Production caveat:** no actual production schema status, row count, index health, or backup state is asserted by this report.
