/**
 * iQuote email templates — branded onboarding emails.
 *
 * Design system aligned with DESIGN.md:
 * - Navy dark header (#081120), electric blue accents (#0052FF)
 * - Geometric sans-serif (Poppins/Montserrat with Arial fallback for email clients)
 * - Solid surfaces, no gradients, crisp 1px borders
 * - Platform logo + header banner image
 *
 * Email HTML is inline-styled for maximum client compatibility.
 * No external CSS, no <style> blocks (except a minimal <head> font import).
 */

/** Platform branding from env — overridable per deployment */
const PLATFORM_NAME = process.env.PLATFORM_NAME ?? 'iQuote'
const PLATFORM_URL = process.env.PLATFORM_URL ?? 'http://localhost:5174'
const PLATFORM_LOGO_URL = process.env.PLATFORM_LOGO_URL ?? '' // e.g. https://your-host/uploads/logo-platform.png
const PLATFORM_HEADER_IMAGE = process.env.PLATFORM_HEADER_IMAGE ?? '' // optional banner image URL
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL ?? 'hello@iquote.app'

/**
 * A compact SVG banner rendered as a data URI.
 * Used when PLATFORM_HEADER_IMAGE is not set — no external HTTP dependency.
 * Navy background with the iQuote brand mark and geometric accents.
 */
const DEFAULT_HEADER_BANNER =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="180" viewBox="0 0 600 180">
  <rect width="600" height="180" fill="#081120"/>
  <rect x="0" y="0" width="600" height="6" fill="#0052FF"/>
  <circle cx="540" cy="120" r="50" fill="#0E1A2F" opacity="0.6"/>
  <circle cx="540" cy="120" r="30" fill="#0052FF" opacity="0.15"/>
  <circle cx="80" cy="140" r="35" fill="#0E1A2F" opacity="0.5"/>
  <text x="40" y="90" font-family="Poppins, Montserrat, Arial, sans-serif" font-size="36" font-weight="800" fill="#FFFFFF">iQuote</text>
  <text x="40" y="118" font-family="Poppins, Montserrat, Arial, sans-serif" font-size="15" font-weight="500" fill="#53647A">Quotes that close.</text>
  <rect x="40" y="135" width="120" height="3" fill="#0052FF" rx="1.5"/>
</svg>`)

function headerImage(): string {
  return PLATFORM_HEADER_IMAGE || DEFAULT_HEADER_BANNER
}

function logoHtml(): string {
  if (PLATFORM_LOGO_URL) {
    return `<img src="${PLATFORM_LOGO_URL}" alt="${PLATFORM_NAME}" width="140" style="display:block;border:0;outline:none;text-decoration:none;height:auto;max-width:140px"/>`
  }
  return `<span style="font-family:'Poppins','Montserrat',Arial,sans-serif;font-size:22px;font-weight:800;color:#FFFFFF;letter-spacing:-0.5px">${PLATFORM_NAME}</span>`
}

/**
 * The master email wrapper — header banner, content body, footer.
 * All specific email templates inject their content into this shell.
 */
function emailShell(contentHtml: string, opts?: { previewText: string }): string {
  const preview = opts?.previewText ?? ''
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <meta http-equiv="X-UA-Compatible" content="IE=edge"/>
  <meta name="x-apple-disable-message-reformatting"/>
  <title>${PLATFORM_NAME}</title>
  <!--[if mso]>
  <noscript>
    <xml>
      <o:OfficeDocumentSettings>
        <o:PixelsPerInch>96</o:PixelsPerInch>
      </o:OfficeDocumentSettings>
    </xml>
  </noscript>
  <![endif]-->
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700;800&display=swap');
    body{margin:0;padding:0;width:100% !important;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;background:#F4F8FD}
    table{border-collapse:collapse !important}
    img{border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic}
    a{text-decoration:none}
    .btn:hover{background:#003ECC !important}
    @media (max-width:600px){
      .container{width:100% !important}
      .content-padding{padding:28px 20px !important}
      .hero-img{height:auto !important}
    }
  </style>
</head>
<body style="margin:0;padding:0;background:#F4F8FD;font-family:'Poppins','Montserrat',Arial,Helvetica,sans-serif">

  <!-- Preview text (hidden) -->
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;height:0;width:0">
    ${preview}&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;
  </div>

  <!-- Outer canvas -->
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F8FD">
    <tr>
      <td align="center" style="padding:24px 12px">

        <!-- Container -->
        <table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background:#FFFFFF;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(8,17,32,0.08)">

          <!-- Header banner image -->
          <tr>
            <td style="padding:0;background:#081120">
              <a href="${PLATFORM_URL}" target="_blank" style="display:block">
                <img src="${headerImage()}" alt="${PLATFORM_NAME}" width="600" class="hero-img" style="display:block;width:600px;max-width:600px;height:auto;border:0"/>
              </a>
            </td>
          </tr>

          <!-- Logo bar -->
          <tr>
            <td style="padding:16px 32px;background:#081120;border-bottom:3px solid #0052FF">
              ${logoHtml()}
            </td>
          </tr>

          <!-- Content body -->
          <tr>
            <td class="content-padding" style="padding:40px 32px 32px">
              ${contentHtml}
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:24px 32px;background:#0E1A2F;border-top:1px solid #1a2640">
              <p style="margin:0 0 8px;font-family:'Poppins','Montserrat',Arial,sans-serif;font-size:13px;font-weight:600;color:#FFFFFF">
                ${PLATFORM_NAME}
              </p>
              <p style="margin:0 0 12px;font-family:'Poppins','Montserrat',Arial,sans-serif;font-size:13px;line-height:1.6;color:#53647A">
                Quotes that close. Send polished quotations, share public review links,
                and track customer decisions without extra admin overhead.
              </p>
              <p style="margin:0;font-family:'Poppins','Montserrat',Arial,sans-serif;font-size:12px;color:#3a4a60">
                <a href="${PLATFORM_URL}" style="color:#3a4a60;text-decoration:underline">Visit ${PLATFORM_URL.replace(/^https?:\/\//, '')}</a>
                &nbsp;&middot;&nbsp;
                <a href="mailto:${SUPPORT_EMAIL}" style="color:#3a4a60;text-decoration:underline">${SUPPORT_EMAIL}</a>
              </p>
            </td>
          </tr>

        </table>

        <!-- Below-card caption -->
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px">
          <tr>
            <td style="padding:16px 0;text-align:center">
              <p style="margin:0;font-family:'Poppins','Montserrat',Arial,sans-serif;font-size:11px;color:#53647A;line-height:1.5">
                You received this email because you signed up for ${PLATFORM_NAME}.<br/>
                If you did not create an account, you can safely ignore this email.
              </p>
            </td>
          </tr>
        </table>

      </td>
    </tr>
  </table>
</body>
</html>`
}

/** A styled primary CTA button */
function button(label: string, href: string): string {
  return `<div style="text-align:center;margin:28px 0 8px">
    <a href="${href}" target="_blank" class="btn" style="display:inline-block;padding:14px 36px;background:#0052FF;color:#FFFFFF;font-family:'Poppins','Montserrat',Arial,sans-serif;font-size:15px;font-weight:600;text-decoration:none;border-radius:6px;letter-spacing:0.3px">
      ${label}
    </a>
  </div>`
}

/** A styled secondary text link */
function textLink(label: string, href: string): string {
  return `<a href="${href}" target="_blank" style="color:#0052FF;font-family:'Poppins','Montserrat',Arial,sans-serif;font-size:14px;font-weight:600;text-decoration:underline">${label}</a>`
}

// ---- Verification code email ----

export function verificationEmailHtml(params: {
  email: string
  code: string
}): string {
  const { code } = params

  const content = `
    <h1 style="margin:0 0 8px;font-family:'Poppins','Montserrat',Arial,sans-serif;font-size:28px;font-weight:800;color:#0A1128;letter-spacing:-0.5px">
      Verify your email
    </h1>
    <p style="margin:0 0 24px;font-family:'Poppins','Montserrat',Arial,sans-serif;font-size:15px;line-height:1.6;color:#53647A">
      Enter this code to continue setting up your quoting workspace.
      It expires in <strong style="color:#0A1128">10 minutes</strong>.
    </p>

    <!-- Code card -->
    <div style="margin:0 0 24px;padding:0">
      <div style="background:#EBF3FF;border:1px solid #D8E4F2;border-radius:8px;padding:28px 24px;text-align:center">
        <p style="margin:0 0 8px;font-family:'Poppins','Montserrat',Arial,sans-serif;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:#53647A">
          Your verification code
        </p>
        <div style="font-family:'Montserrat','Poppins',Arial,sans-serif;font-size:36px;font-weight:800;color:#0052FF;letter-spacing:10px;font-variant-numeric:tabular-nums">
          ${code}
        </div>
      </div>
    </div>

    <p style="margin:0;font-family:'Poppins','Montserrat',Arial,sans-serif;font-size:14px;line-height:1.6;color:#53647A">
      Didn't request this code? You can safely ignore this email — your account
      was not created. Nobody can access your workspace without this code.
    </p>
  `

  return emailShell(content, {
    previewText: `Your ${PLATFORM_NAME} verification code is ${code}`,
  })
}

// ---- Welcome / onboarding email ----

export function welcomeEmailHtml(params: {
  name: string
  businessName: string
  businessType: string | null
  country: string
  plan: string
  trialEndsAt: Date
  phone: string | null
  loginUrl: string
}): string {
  const { name, businessName, businessType, country, plan, trialEndsAt, phone, loginUrl } = params

  const trialEnd = trialEndsAt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })

  const stepCard = (number: string, title: string, desc: string) => `
    <td width="33%" valign="top" style="padding:0 8px">
      <div style="background:#F4F8FD;border:1px solid #D8E4F2;border-radius:6px;padding:20px 16px;text-align:center">
        <div style="width:32px;height:32px;line-height:32px;border-radius:50%;background:#0052FF;color:#FFFFFF;font-family:'Poppins',Arial,sans-serif;font-size:14px;font-weight:700;margin:0 auto 10px">
          ${number}
        </div>
        <p style="margin:0 0 4px;font-family:'Poppins','Montserrat',Arial,sans-serif;font-size:13px;font-weight:700;color:#0A1128">
          ${title}
        </p>
        <p style="margin:0;font-family:'Poppins','Montserrat',Arial,sans-serif;font-size:12px;line-height:1.5;color:#53647A">
          ${desc}
        </p>
      </div>
    </td>`

  const content = `
    <p style="margin:0 0 4px;font-family:'Poppins','Montserrat',Arial,sans-serif;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:#0052FF">
      Welcome aboard
    </p>
    <h1 style="margin:0 0 8px;font-family:'Poppins','Montserrat',Arial,sans-serif;font-size:26px;font-weight:800;color:#0A1128;letter-spacing:-0.5px">
      Your workspace is ready, ${escapeText(name.split(' ')[0])}
    </h1>
    <p style="margin:0 0 24px;font-family:'Poppins','Montserrat',Arial,sans-serif;font-size:15px;line-height:1.6;color:#53647A">
      <strong style="color:#0A1128">${escapeText(businessName)}</strong> is set up and ready to send quotes.
      Your ${escapeText(plan.toLowerCase())} plan trial runs through <strong style="color:#0A1128">${trialEnd}</strong>.
    </p>

    ${button(`Go to your workspace →`, loginUrl)}

    <!-- Trial badge -->
    <div style="margin:24px 0;padding:16px 20px;background:#EBF3FF;border:1px solid #D8E4F2;border-radius:6px;text-align:center">
      <span style="display:inline-block;padding:4px 12px;background:#0052FF;color:#FFFFFF;font-family:'Poppins','Montserrat',Arial,sans-serif;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;border-radius:12px">
        14-Day Trial
      </span>
      <span style="font-family:'Poppins','Montserrat',Arial,sans-serif;font-size:14px;color:#0A1128;margin-left:8px">
        No payment required during trial
      </span>
    </div>

    <!-- Setup summary -->
    <h2 style="margin:28px 0 12px;font-family:'Poppins','Montserrat',Arial,sans-serif;font-size:17px;font-weight:700;color:#0A1128">
      Your setup
    </h2>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 8px">
      <tr>
        <td style="padding:6px 0;font-family:'Poppins','Montserrat',Arial,sans-serif;font-size:14px;color:#53647A;width:130px">Business</td>
        <td style="padding:6px 0;font-family:'Poppins','Montserrat',Arial,sans-serif;font-size:14px;font-weight:600;color:#0A1128">${escapeText(businessName)}</td>
      </tr>
      <tr>
        <td style="padding:6px 0;font-family:'Poppins','Montserrat',Arial,sans-serif;font-size:14px;color:#53647A">Type</td>
        <td style="padding:6px 0;font-family:'Poppins','Montserrat',Arial,sans-serif;font-size:14px;font-weight:600;color:#0A1128">${escapeText(businessType || 'Independent business')}</td>
      </tr>
      <tr>
        <td style="padding:6px 0;font-family:'Poppins','Montserrat',Arial,sans-serif;font-size:14px;color:#53647A">Country</td>
        <td style="padding:6px 0;font-family:'Poppins','Montserrat',Arial,sans-serif;font-size:14px;font-weight:600;color:#0A1128">${escapeText(country)}</td>
      </tr>
      <tr>
        <td style="padding:6px 0;font-family:'Poppins','Montserrat',Arial,sans-serif;font-size:14px;color:#53647A">Phone</td>
        <td style="padding:6px 0;font-family:'Poppins','Montserrat',Arial,sans-serif;font-size:14px;font-weight:600;color:#0A1128">${escapeText(phone || 'Not provided')}</td>
      </tr>
    </table>

    <!-- Steps -->
    <h2 style="margin:28px 0 14px;font-family:'Poppins','Montserrat',Arial,sans-serif;font-size:17px;font-weight:700;color:#0A1128">
      Start in three steps
    </h2>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        ${stepCard('1', 'Add a customer', 'Name and phone or email — that is all you need.')}
        ${stepCard('2', 'Create a quote', 'Line items, tax, terms. Live preview as you type.')}
        ${stepCard('3', 'Share & track', 'Send a public link. See when it is viewed and approved.')}
      </tr>
    </table>

    <!-- Help section -->
    <div style="margin:28px 0 0;padding:20px;background:#F4F8FD;border-radius:6px">
      <p style="margin:0 0 4px;font-family:'Poppins','Montserrat',Arial,sans-serif;font-size:13px;font-weight:700;color:#0A1128">
        Need help getting started?
      </p>
      <p style="margin:0;font-family:'Poppins','Montserrat',Arial,sans-serif;font-size:13px;line-height:1.6;color:#53647A">
        Reply to this email or reach out to ${textLink(SUPPORT_EMAIL, `mailto:${SUPPORT_EMAIL}`)}
        and we'll help you send your first quote today.
      </p>
    </div>
  `

  return emailShell(content, {
    previewText: `Your ${escapeText(businessName)} workspace is ready on ${PLATFORM_NAME}`,
  })
}

// ---- Quote decision notification email (bonus: sent to the business owner) ----

export function quoteDecisionEmailHtml(params: {
  ownerName: string
  documentNumber: string
  customerName: string
  total: number
  currency: string
  decision: 'APPROVED' | 'DECLINED'
  comment: string | null
  quoteUrl: string
}): string {
  const { ownerName, documentNumber, customerName, total, currency, decision, comment, quoteUrl } = params
  const approved = decision === 'APPROVED'

  const statusBadge = approved
    ? `<span style="display:inline-block;padding:6px 16px;background:#059669;color:#FFFFFF;font-family:'Poppins','Montserrat',Arial,sans-serif;font-size:13px;font-weight:700;border-radius:12px">✓ Approved</span>`
    : `<span style="display:inline-block;padding:6px 16px;background:#DC2626;color:#FFFFFF;font-family:'Poppins','Montserrat',Arial,sans-serif;font-size:13px;font-weight:700;border-radius:12px">✕ Declined</span>`

  const content = `
    <h1 style="margin:0 0 8px;font-family:'Poppins','Montserrat',Arial,sans-serif;font-size:26px;font-weight:800;color:#0A1128;letter-spacing:-0.5px">
      ${approved ? 'Quote approved!' : 'Quote declined'}
    </h1>
    <p style="margin:0 0 20px;font-family:'Poppins','Montserrat',Arial,sans-serif;font-size:15px;line-height:1.6;color:#53647A">
      Hi ${escapeText(ownerName.split(' ')[0])}, your customer has made a decision.
    </p>

    <!-- Decision card -->
    <div style="margin:0 0 20px;padding:24px;background:#F4F8FD;border:1px solid #D8E4F2;border-radius:8px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td style="padding:4px 0;font-family:'Poppins','Montserrat',Arial,sans-serif;font-size:14px;color:#53647A">Quote</td>
          <td style="padding:4px 0;font-family:'Poppins','Montserrat',Arial,sans-serif;font-size:14px;font-weight:700;color:#0A1128;text-align:right">${escapeText(documentNumber)}</td>
        </tr>
        <tr>
          <td style="padding:4px 0;font-family:'Poppins','Montserrat',Arial,sans-serif;font-size:14px;color:#53647A">Customer</td>
          <td style="padding:4px 0;font-family:'Poppins','Montserrat',Arial,sans-serif;font-size:14px;font-weight:600;color:#0A1128;text-align:right">${escapeText(customerName)}</td>
        </tr>
        <tr>
          <td style="padding:4px 0;font-family:'Poppins','Montserrat',Arial,sans-serif;font-size:14px;color:#53647A">Amount</td>
          <td style="padding:4px 0;font-family:'Montserrat','Poppins',Arial,sans-serif;font-size:16px;font-weight:800;color:#0A1128;text-align:right;font-variant-numeric:tabular-nums">${formatCurrency(total, currency)}</td>
        </tr>
        <tr>
          <td style="padding:12px 0 4px;font-family:'Poppins','Montserrat',Arial,sans-serif;font-size:14px;color:#53647A">Decision</td>
          <td style="padding:12px 0 4px;text-align:right">${statusBadge}</td>
        </tr>
      </table>
    </div>

    ${comment ? `
      <div style="margin:0 0 20px;padding:16px 20px;background:#EBF3FF;border-left:3px solid #0052FF;border-radius:0 6px 6px 0">
        <p style="margin:0 0 4px;font-family:'Poppins','Montserrat',Arial,sans-serif;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#53647A">Customer comment</p>
        <p style="margin:0;font-family:'Poppins','Montserrat',Arial,sans-serif;font-size:14px;line-height:1.6;color:#0A1128;font-style:italic">"${escapeText(comment)}"</p>
      </div>
    ` : ''}

    ${button(`View quote →`, quoteUrl)}
  `

  return emailShell(content, {
    previewText: `${escapeText(documentNumber)} ${approved ? 'approved' : 'declined'} by ${escapeText(customerName)}`,
  })
}

// ---- Quote delivery email (sent to the customer) ----

export function quoteDeliveryEmailHtml(params: {
  recipientName: string
  businessName: string
  documentNumber: string
  total: number
  currency: string
  validUntil: string | null
  lineItems: Array<{ description: string; quantity: number; unitPrice: number; total: number }>
  customMessage: string | null
  quoteUrl: string
}): string {
  const { recipientName, businessName, documentNumber, total, currency, validUntil, lineItems, customMessage, quoteUrl } = params

  const rowsHtml = lineItems.slice(0, 8).map((item) => `
    <tr>
      <td style="padding:8px 0;font-family:'Poppins','Montserrat',Arial,sans-serif;font-size:13px;color:#0A1128;border-bottom:1px solid #E8EEF4">${escapeText(item.description)}</td>
      <td style="padding:8px 0;font-family:'Montserrat',Arial,sans-serif;font-size:13px;color:#53647A;text-align:right;white-space:nowrap;border-bottom:1px solid #E8EEF4">${item.quantity}</td>
      <td style="padding:8px 0;font-family:'Montserrat',Arial,sans-serif;font-size:13px;color:#0A1128;font-weight:600;text-align:right;white-space:nowrap;border-bottom:1px solid #E8EEF4">${formatCurrency(item.total, currency)}</td>
    </tr>
  `).join('')

  const moreCount = lineItems.length > 8 ? lineItems.length - 8 : 0

  const content = `
    <h1 style="margin:0 0 8px;font-family:'Poppins','Montserrat',Arial,sans-serif;font-size:26px;font-weight:800;color:#0A1128;letter-spacing:-0.5px">
      ${escapeText(businessName)} sent you a quote
    </h1>
    <p style="margin:0 0 24px;font-family:'Poppins','Montserrat',Arial,sans-serif;font-size:15px;line-height:1.6;color:#53647A">
      Hi ${escapeText(recipientName.split(' ')[0] || 'there')}, you have a new quotation to review.
    </p>

    ${customMessage ? `
      <div style="margin:0 0 24px;padding:16px 20px;background:#EBF3FF;border-left:3px solid #0052FF;border-radius:0 6px 6px 0">
        <p style="margin:0;font-family:'Poppins','Montserrat',Arial,sans-serif;font-size:14px;line-height:1.6;color:#0A1128">${escapeText(customMessage)}</p>
      </div>
    ` : ''}

    <!-- Quote summary card -->
    <div style="margin:0 0 20px;padding:24px;background:#F4F8FD;border:1px solid #D8E4F2;border-radius:8px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td style="padding:4px 0;font-family:'Poppins','Montserrat',Arial,sans-serif;font-size:14px;color:#53647A;width:120px">Quote #</td>
          <td style="padding:4px 0;font-family:'Poppins','Montserrat',Arial,sans-serif;font-size:14px;font-weight:700;color:#0A1128">${escapeText(documentNumber)}</td>
        </tr>
        ${validUntil ? `<tr>
          <td style="padding:4px 0;font-family:'Poppins','Montserrat',Arial,sans-serif;font-size:14px;color:#53647A">Valid until</td>
          <td style="padding:4px 0;font-family:'Poppins','Montserrat',Arial,sans-serif;font-size:14px;font-weight:600;color:#0A1128">${escapeText(validUntil)}</td>
        </tr>` : ''}
      </table>

      <!-- Line items -->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px">
        <tr>
          <td style="padding:4px 0;font-family:'Poppins','Montserrat',Arial,sans-serif;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#53647A">Description</td>
          <td style="padding:4px 0;font-family:'Poppins','Montserrat',Arial,sans-serif;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#53647A;text-align:right">Qty</td>
          <td style="padding:4px 0;font-family:'Poppins','Montserrat',Arial,sans-serif;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#53647A;text-align:right">Amount</td>
        </tr>
        ${rowsHtml}
      </table>

      ${moreCount > 0 ? `<p style="margin:8px 0 0;font-family:'Poppins','Montserrat',Arial,sans-serif;font-size:12px;color:#53647A;font-style:italic">+ ${moreCount} more item${moreCount === 1 ? '' : 's'} — see full quote</p>` : ''}

      <!-- Total -->
      <div style="margin-top:16px;padding-top:12px;border-top:2px solid #0052FF">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="font-family:'Poppins','Montserrat',Arial,sans-serif;font-size:16px;font-weight:700;color:#0A1128">Total</td>
            <td style="font-family:'Montserrat','Poppins',Arial,sans-serif;font-size:20px;font-weight:800;color:#0052FF;text-align:right;font-variant-numeric:tabular-nums">${formatCurrency(total, currency)}</td>
          </tr>
        </table>
      </div>
    </div>

    ${button(`Review your quote →`, quoteUrl)}

    <p style="margin:16px 0 0;font-family:'Poppins','Montserrat',Arial,sans-serif;font-size:13px;line-height:1.6;color:#53647A">
      Click the button above to view the full quotation. You can approve or decline it directly from the link.
    </p>
  `

  return emailShell(content, {
    previewText: `${escapeText(businessName)} sent you ${escapeText(documentNumber)} — ${formatCurrency(total, currency)}`,
  })
}

// ---- Helpers ----

function escapeText(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)
}

function formatCurrency(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-KE', { style: 'currency', currency }).format(value)
  } catch {
    return `${currency} ${value.toFixed(2)}`
  }
}

// ---- Subjects ----

export const emailSubjects = {
  verification: `Your ${PLATFORM_NAME} verification code`,
  welcome: (businessName: string) => `Your ${businessName.slice(0, 60)} workspace is ready`,
  quoteApproved: (docNumber: string) => `✓ ${docNumber} approved`,
  quoteDeclined: (docNumber: string) => `${docNumber} declined`,
  quoteDelivery: (businessName: string, docNumber: string) => `${businessName.slice(0, 40)} sent you ${docNumber}`,
}
