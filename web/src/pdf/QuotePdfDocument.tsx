import {
  Document,
  Image,
  Page,
  pdf,
  StyleSheet,
  Text,
  View,
} from '@react-pdf/renderer'
import { useState } from 'react'
import type { QuoteDocumentData } from '../QuoteDocument'
import type { Style } from '@react-pdf/stylesheet'
import { assetUrl, downloadAuthenticatedFile, downloadPublicFile, downloadBlobFile, formatMoney } from '../api'
import { amountInWords, cleanUrl, dateLabel, readableOn, safeAccent, tint } from './format'
import { resolveTemplate, type TemplateKey, type TemplateTheme } from './themes'

const ink = '#1c1c1e'
const muted = '#4a5e54'
const brandGreen = '#1a5c3f'
const hairline = '#e2e8e4'
const rowRule = '#e8edea'
const headerRule = '#d8e4de'
const surfaceOff = '#fafaf8'
const footerBg = '#f7faf8'
const footerMuted = '#5e6b62'
const dot = '#b8c4be'
const darkBand = '#111827'
const PAGE_X = 48
const PAGE_TOP = 44

function buildStyles(theme: TemplateTheme, accent: string) {
  const compact = theme.density === 'compact'
  const fontSize = compact ? 8.5 : 9
  const rowPad = compact ? 6 : 11
  const onBand = theme.header !== 'plain'
  const bandBg = theme.header === 'band' ? accent : darkBand
  const fg = onBand ? readableOn(bandBg) : ink
  const fgMuted = onBand ? (fg === '#ffffff' ? '#e5e7eb' : '#3f3f46') : muted
  const titleColor = onBand ? fg : accent
  const badgeLetter = onBand ? (theme.header === 'band' ? accent : darkBand) : readableOn(accent)

  const head = {
    lined: { bg: surfaceOff, fg: muted, border: headerRule },
    striped: { bg: accent, fg: readableOn(accent), border: accent },
    boxed: { bg: tint(accent, 0.12), fg: ink, border: accent },
    minimal: { bg: '#ffffff', fg: ink, border: ink },
  }[theme.table]

  const grand = {
    wash: { bg: tint(accent, 0.1), fg: ink, extra: { borderLeftWidth: 3, borderLeftColor: accent } },
    solid: { bg: accent, fg: readableOn(accent), extra: {} },
    rule: { bg: '#ffffff', fg: ink, extra: { borderTopWidth: 1, borderBottomWidth: 1, borderColor: ink } },
  }[theme.totalBox]

  const styles = StyleSheet.create({
    page: { paddingTop: PAGE_TOP, paddingBottom: 80, paddingHorizontal: PAGE_X, color: ink, fontFamily: 'Helvetica', fontSize },
    header: onBand
      ? { marginHorizontal: -PAGE_X, marginTop: -PAGE_TOP, paddingHorizontal: PAGE_X, paddingTop: 26, paddingBottom: 24, backgroundColor: bandBg, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }
      : { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', paddingBottom: compact ? 14 : 24, borderBottomWidth: theme.table === 'minimal' ? 0 : 1, borderBottomColor: headerRule },
    accentBar: { height: 4, backgroundColor: accent, marginHorizontal: -PAGE_X },
    brand: { flexDirection: 'column', alignItems: 'flex-start', flexGrow: 1, flexShrink: 1, paddingRight: 24 },
    logoChip: onBand ? { backgroundColor: '#ffffff', padding: 6, borderRadius: 4, marginBottom: 10 } : { marginBottom: 10 },
    logoSquare: { width: compact ? 52 : 68, height: compact ? 52 : 68, objectFit: 'contain' },
    logoLandscape: { width: compact ? 120 : 150, height: compact ? 44 : 56, objectFit: 'contain' },
    logoFallback: { width: compact ? 40 : 48, height: compact ? 40 : 48, borderRadius: 6, backgroundColor: onBand ? '#ffffff' : accent, alignItems: 'center', justifyContent: 'center', marginBottom: 10 },
    logoLetter: { fontSize: compact ? 18 : 22, fontWeight: 700, color: badgeLetter },
    // No flex on this column: a flexible height inside an auto-height parent made the name and
    // contact lines overlap in the previous template.
    businessDetails: { flexDirection: 'column' },
    businessName: { fontSize: compact ? 12 : 14, fontWeight: 700, color: fg, marginBottom: 4 },
    metaRow: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 2 },
    businessMeta: { fontSize: 8.5, color: fgMuted, lineHeight: 1.4 },
    metaDot: { fontSize: 8.5, color: onBand ? fgMuted : dot, marginHorizontal: 4 },
    titleBlock: { width: 200, alignItems: 'flex-end' },
    title: { fontFamily: theme.titleFont, fontSize: theme.titleSize, letterSpacing: theme.titleSpacing, color: titleColor, marginBottom: 6, textTransform: 'uppercase' },
    documentNumber: { fontSize: 10, fontWeight: 700, color: fg, marginBottom: 3 },
    docMeta: { fontSize: 8.5, color: fgMuted, marginBottom: 2 },
    draftTag: { fontSize: 7.5, letterSpacing: 1, color: fgMuted, marginTop: 3 },
    meta: { fontSize: 8.5, color: muted, marginTop: 2 },
    recipient: { paddingTop: compact ? 16 : 26, paddingBottom: compact ? 12 : 22 },
    eyebrow: { fontSize: 7, fontWeight: 800, letterSpacing: 1.5, color: muted, marginBottom: 5, textTransform: 'uppercase' },
    recipientName: { fontSize: compact ? 11 : 13, fontWeight: 700, color: ink },
    table: theme.table === 'boxed' ? { width: '100%', marginTop: 4, borderWidth: 0.75, borderColor: headerRule } : { width: '100%', marginTop: 4 },
    tableHeader: { flexDirection: 'row', alignItems: 'center', minHeight: 26, borderBottomWidth: 1, borderBottomColor: head.border, backgroundColor: head.bg, color: head.fg, fontSize: 7.5, fontWeight: 700, letterSpacing: 0.8, textTransform: 'uppercase' },
    row: { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: rowPad, borderBottomWidth: theme.table === 'striped' ? 0 : 0.5, borderBottomColor: rowRule },
    descriptionColumn: { width: '41%', paddingLeft: 6, paddingRight: 10 },
    quantityColumn: { width: '12%', paddingLeft: 6, paddingRight: 6 },
    unitPriceColumn: { width: '19%', paddingLeft: 6, paddingRight: 6 },
    taxColumn: { width: '10%', paddingLeft: 6, paddingRight: 6 },
    amountColumn: { width: '18%', paddingLeft: 6, paddingRight: 8, textAlign: 'right' },
    headerCell: { paddingVertical: 6 },
    description: { color: ink, fontSize, lineHeight: 1.4 },
    unit: { color: muted, fontSize: 7.5, marginTop: 2 },
    cell: { color: muted, fontSize, lineHeight: 1.4 },
    amountCell: { color: ink, fontWeight: 600 },
    empty: { color: muted, textAlign: 'center', paddingVertical: 13, fontSize: 8 },
    totals: { width: 230, alignSelf: 'flex-end', marginTop: 18 },
    totalRow: { flexDirection: 'row', justifyContent: 'space-between', color: muted, fontSize, marginBottom: 7 },
    totalValue: { color: ink, fontSize, fontWeight: 600 },
    grandTotal: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 14, marginTop: 4, backgroundColor: grand.bg, color: grand.fg, fontSize: 10, fontWeight: 700, ...grand.extra },
    grandValue: { color: grand.fg, fontSize: 14, fontWeight: 700 },
    amountWords: { alignSelf: 'flex-end', width: 300, marginTop: 8, textAlign: 'right', color: muted, fontSize: 8, fontStyle: 'italic', lineHeight: 1.4 },
    notesBlock: { marginTop: 24 },
    note: { marginBottom: 16 },
    noteHeading: { color: muted, fontSize: 7, fontWeight: 800, letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 5 },
    noteText: { color: muted, fontSize, lineHeight: 1.5 },
    acceptance: { marginTop: 26, paddingTop: 14, borderTopWidth: 0.5, borderTopColor: headerRule },
    signatureRow: { flexDirection: 'row', marginTop: 24 },
    signatureField: { flexGrow: 1, flexBasis: 0, marginRight: 18 },
    signatureLine: { borderBottomWidth: 0.75, borderBottomColor: muted, height: 18 },
    signatureLabel: { color: muted, fontSize: 7, marginTop: 3, textTransform: 'uppercase', letterSpacing: 1 },
    footer: { position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: footerBg, paddingTop: 14, paddingBottom: 16, paddingHorizontal: PAGE_X, borderTopWidth: 1, borderTopColor: hairline, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    footerText: { color: footerMuted, fontSize: 8 },
  })

  return { styles, stripe: tint(accent, 0.07) }
}

function Dots({ items, textStyle, dotStyle, rowStyle }: {
  items: (string | null | undefined)[]
  textStyle: Style
  dotStyle: Style
  rowStyle: Style
}) {
  const visible = items.filter(Boolean)
  return (
    <View style={rowStyle}>
      {visible.map((item, index) => (
        <View key={index} style={{ flexDirection: 'row', alignItems: 'center' }}>
          <Text style={textStyle}>{item}</Text>
          {index < visible.length - 1 && <Text style={dotStyle}>•</Text>}
        </View>
      ))}
    </View>
  )
}

export function QuotePdfDocument({ quote, template }: { quote: QuoteDocumentData; template?: TemplateKey | string | null }) {
  const org = quote.organisation
  const theme = resolveTemplate(template ?? org.documentTemplate)
  const accent = safeAccent(org.brandColor, brandGreen)
  const { styles, stripe } = buildStyles(theme, accent)

  const lines = quote.lines.length ? quote.lines : null
  const contacts = [org.email, org.phone, org.country, cleanUrl(org.website)]
  const totalInWords = amountInWords(quote.total, quote.currency)
  const taxIds = [org.kraPin && `KRA PIN: ${org.kraPin}`, org.vatNumber && `VAT No: ${org.vatNumber}`].filter(Boolean).join('   ')
  const isDraft = String(quote.status ?? '').toUpperCase() === 'DRAFT'

  const logoAspect = (org.logoWidth && org.logoHeight) ? org.logoWidth / org.logoHeight : 1
  const logoStyle = logoAspect > 1.3 ? styles.logoLandscape : styles.logoSquare

  return (
    <Document title={`Quotation ${quote.documentNumber}`} author={org.name} subject="Business quotation">
      <Page size="A4" style={styles.page} wrap>
        <View style={styles.header}>
          <View style={styles.brand}>
            {org.logoUrl
              ? <View style={styles.logoChip}><Image src={assetUrl(org.logoUrl) ?? undefined} style={logoStyle} /></View>
              : <View style={styles.logoFallback}><Text style={styles.logoLetter}>{org.name.slice(0, 1).toUpperCase()}</Text></View>}
            <View style={styles.businessDetails}>
              <Text style={styles.businessName}>{org.name}</Text>
              <Dots items={contacts} textStyle={styles.businessMeta} dotStyle={styles.metaDot} rowStyle={styles.metaRow} />
              {org.address && <Text style={styles.businessMeta}>{org.address}</Text>}
              {taxIds && <Text style={styles.businessMeta}>{taxIds}</Text>}
            </View>
          </View>
          <View style={styles.titleBlock}>
            <Text style={styles.title}>QUOTATION</Text>
            <Text style={styles.documentNumber}>{quote.documentNumber}</Text>
            <Text style={styles.docMeta}>Prepared {dateLabel(quote.createdAt) || dateLabel(new Date().toISOString())}</Text>
            {quote.validUntil && <Text style={styles.docMeta}>Valid until {dateLabel(quote.validUntil)}</Text>}
            {isDraft && <Text style={styles.draftTag}>DRAFT · NOT YET SENT</Text>}
          </View>
        </View>
        {theme.header === 'dark' && <View style={styles.accentBar} />}

        <View style={styles.recipient}>
          <Text style={styles.eyebrow}>PREPARED FOR</Text>
          <Text style={styles.recipientName}>{quote.customer.name || 'Customer'}</Text>
          {quote.customer.email && <Text style={styles.meta}>{quote.customer.email}</Text>}
          {quote.customer.phone && <Text style={styles.meta}>{quote.customer.phone}</Text>}
        </View>

        <View style={styles.table}>
          <View style={styles.tableHeader} fixed>
            <Text style={[styles.descriptionColumn, styles.headerCell]}>Description</Text>
            <Text style={[styles.quantityColumn, styles.headerCell]}>Qty</Text>
            <Text style={[styles.unitPriceColumn, styles.headerCell]}>Unit price</Text>
            <Text style={[styles.taxColumn, styles.headerCell]}>Tax</Text>
            <Text style={[styles.amountColumn, styles.headerCell]}>Amount</Text>
          </View>
          {lines ? lines.map((line, index) => (
            <View
              style={theme.table === 'striped' && index % 2 === 1 ? [styles.row, { backgroundColor: stripe }] : styles.row}
              key={line.id ?? `${line.description}-${index}`}
              wrap={false}
            >
              <View style={styles.descriptionColumn}>
                <Text style={styles.description}>{line.description}</Text>
              </View>
              <View style={styles.quantityColumn}>
                <Text style={styles.cell}>{line.quantity}</Text>
                {line.unit ? <Text style={styles.unit}>{line.unit}</Text> : null}
              </View>
              <Text style={[styles.unitPriceColumn, styles.cell]}>{formatMoney(line.unitPrice, quote.currency)}</Text>
              <Text style={[styles.taxColumn, styles.cell]}>{line.taxRate == null ? '—' : `${line.taxRate}%`}</Text>
              <Text style={[styles.amountColumn, styles.amountCell]}>{formatMoney(line.quantity * line.unitPrice, quote.currency)}</Text>
            </View>
          )) : <Text style={styles.empty}>Line items will appear here.</Text>}
        </View>

        <View style={styles.totals} wrap={false}>
          <View style={styles.totalRow}><Text>Subtotal</Text><Text style={styles.totalValue}>{formatMoney(quote.subtotal, quote.currency)}</Text></View>
          <View style={styles.totalRow}><Text>Tax</Text><Text style={styles.totalValue}>{formatMoney(quote.taxTotal, quote.currency)}</Text></View>
          <View style={styles.grandTotal}><Text>Total</Text><Text style={styles.grandValue}>{formatMoney(quote.total, quote.currency)}</Text></View>
        </View>

        {totalInWords && <Text style={styles.amountWords}>{totalInWords}</Text>}

        {(quote.notes || quote.terms || org.paymentInstructions) && (
          <View style={styles.notesBlock} wrap={false}>
            {quote.notes && <View style={styles.note}><Text style={styles.noteHeading}>NOTES</Text><Text style={styles.noteText}>{quote.notes}</Text></View>}
            {quote.terms && <View style={styles.note}><Text style={styles.noteHeading}>TERMS</Text><Text style={styles.noteText}>{quote.terms}</Text></View>}
            {org.paymentInstructions && <View style={styles.note}><Text style={styles.noteHeading}>PAYMENT INSTRUCTIONS</Text><Text style={styles.noteText}>{org.paymentInstructions}</Text></View>}
          </View>
        )}

        <View style={styles.acceptance} wrap={false}>
          <Text style={styles.noteHeading}>ACCEPTANCE</Text>
          <Text style={styles.noteText}>To accept this quotation, sign below or approve it online using the link we sent you.</Text>
          <View style={styles.signatureRow}>
            <View style={styles.signatureField}><View style={styles.signatureLine} /><Text style={styles.signatureLabel}>Name</Text></View>
            <View style={styles.signatureField}><View style={styles.signatureLine} /><Text style={styles.signatureLabel}>Signature</Text></View>
            <View style={styles.signatureField}><View style={styles.signatureLine} /><Text style={styles.signatureLabel}>Date</Text></View>
          </View>
        </View>

        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>Thank you for your consideration.</Text>
          <Text style={styles.footerText} render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
        </View>
      </Page>
    </Document>
  )
}

export function QuotePdfDownloadLink({ quote, quoteId, publicToken, useServer = true, className, template }: { quote: QuoteDocumentData; quoteId?: string; publicToken?: string; useServer?: boolean; className?: string; template?: TemplateKey | string | null }) {
  const [downloading, setDownloading] = useState(false)
  const [error, setError] = useState('')
  const filename = `${quote.documentNumber.replace(/[^a-zA-Z0-9_-]/g, '-') || 'quotation'}.pdf`
  async function download() {
    setDownloading(true); setError('')
    try {
      if (useServer && quoteId) {
        try {
          await downloadAuthenticatedFile(`/api/quotes/${encodeURIComponent(quoteId)}/pdf`, filename)
          return
        } catch (cause) {
          if (!(cause instanceof Error) || !cause.message.includes('Server PDF rendering is not available on this deployment.')) throw cause
        }
      } else if (useServer && publicToken) {
        try {
          await downloadPublicFile(`/api/public/quotes/${encodeURIComponent(publicToken)}/pdf`, filename)
          return
        } catch (cause) {
          if (!(cause instanceof Error) || !cause.message.includes('Server PDF rendering is not available on this deployment.')) throw cause
        }
      }
      downloadBlobFile(await pdf(<QuotePdfDocument quote={quote} template={template} />).toBlob(), filename)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not download the quotation.') }
    finally { setDownloading(false) }
  }
  return <span className="pdf-download-control"><button type="button" className={className} onClick={() => void download()} disabled={downloading}>{downloading ? 'Preparing PDF…' : 'Download PDF'}</button>{error && <small role="alert">{error}</small>}</span>
}
