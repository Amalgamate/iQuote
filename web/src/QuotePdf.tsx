import {
  Document,
  Image,
  Page,
  PDFDownloadLink,
  StyleSheet,
  Text,
  View,
} from '@react-pdf/renderer'
import type { QuoteDocumentData } from './QuoteDocument'
import { assetUrl, formatMoney } from './api'

const ink = '#1c1c1e'
const muted = '#4a5e54'
const brandGreen = '#1a5c3f'
const hairline = '#e2e8e4'
const rowRule = '#e8edea'
const headerRule = '#d8e4de'
const surfaceOff = '#fafaf8'
const totalWash = '#f0f7f3'
const footerBg = '#f7faf8'
const footerText = '#4a5e54'
const footerMuted = '#5e6b62'
const dot = '#b8c4be'

const styles = StyleSheet.create({
  page: { paddingTop: 44, paddingBottom: 110, paddingHorizontal: 48, color: ink, fontFamily: 'Helvetica', fontSize: 9 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', paddingBottom: 24, borderBottomWidth: 1, borderBottomColor: headerRule },
  brand: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, flex: 1, paddingRight: 24, minWidth: 0 },
  logo: { width: 60, height: 60, objectFit: 'contain' },
  logoFallback: { width: 60, height: 60, borderWidth: 1, borderColor: hairline, alignItems: 'center', justifyContent: 'center', fontSize: 22, fontWeight: 800, color: ink },
  businessDetails: { flexDirection: 'column', gap: 4, flex: 1, minWidth: 0 },
  businessName: { fontSize: 14, fontWeight: 700, color: ink, marginBottom: 2 },
  businessMetaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 4 },
  businessMeta: { fontSize: 8.5, color: muted },
  businessMetaDot: { fontSize: 8.5, color: dot, marginHorizontal: 4 },
  titleBlock: { width: 210, alignItems: 'flex-end', gap: 5 },
  title: { fontSize: 23, fontWeight: 700, letterSpacing: 2, color: brandGreen, marginBottom: 4, textTransform: 'uppercase' },
  documentNumber: { fontSize: 10, fontWeight: 700, color: ink, marginBottom: 2 },
  meta: { fontSize: 8.5, color: muted },
  recipient: { paddingTop: 26, paddingBottom: 22, gap: 5 },
  eyebrow: { fontSize: 7, fontWeight: 800, letterSpacing: 1.5, color: muted, marginBottom: 4, textTransform: 'uppercase' },
  recipientName: { fontSize: 13, fontWeight: 700, color: ink },
  table: { width: '100%', marginTop: 4 },
  tableHeader: { flexDirection: 'row', alignItems: 'center', minHeight: 26, borderBottomWidth: 1, borderBottomColor: headerRule, backgroundColor: surfaceOff, color: muted, fontSize: 7.5, fontWeight: 700, letterSpacing: 0.8, textTransform: 'uppercase' },
  row: { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 11, borderBottomWidth: 0.5, borderBottomColor: rowRule },
  descriptionColumn: { width: '45%', paddingLeft: 4, paddingRight: 10 },
  quantityColumn: { width: '9%', paddingLeft: 6, paddingRight: 6 },
  unitPriceColumn: { width: '19%', paddingLeft: 6, paddingRight: 6 },
  taxColumn: { width: '10%', paddingLeft: 6, paddingRight: 6 },
  amountColumn: { width: '17%', paddingLeft: 6, paddingRight: 6, textAlign: 'right' },
  headerCell: { paddingVertical: 6 },
  description: { color: ink, fontSize: 9, lineHeight: 1.4 },
  unit: { color: muted, fontSize: 8, marginTop: 3 },
  cell: { color: muted, fontSize: 9, lineHeight: 1.4 },
  amountCell: { color: ink, fontWeight: 600 },
  empty: { color: muted, textAlign: 'center', paddingVertical: 13, fontSize: 8 },
  totals: { width: 220, alignSelf: 'flex-end', marginTop: 18, gap: 7 },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 12, color: muted, fontSize: 9 },
  totalValue: { color: ink, fontSize: 9, fontWeight: 600 },
  grandTotal: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 14, marginTop: 4, backgroundColor: totalWash, color: ink, fontSize: 10, fontWeight: 700 },
  notesBlock: { marginTop: 24, gap: 18 },
  note: { gap: 6 },
  noteHeading: { color: muted, fontSize: 7, fontWeight: 800, letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 2 },
  noteText: { color: muted, fontSize: 9, lineHeight: 1.5 },
  footer: { position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: footerBg, color: footerText, paddingTop: 16, paddingBottom: 18, paddingHorizontal: 48, borderTopWidth: 1, borderTopColor: hairline },
  footerMain: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12, fontSize: 8 },
  footerThanks: { color: footerMuted, fontSize: 8 },
  footerContacts: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, color: footerText },
  footerContact: { fontSize: 8 },
  footerContactDot: { fontSize: 8, color: dot, marginHorizontal: 4 },
  footerPayment: { marginTop: 10, paddingTop: 8, borderTopWidth: 0.5, borderTopColor: rowRule },
  footerPaymentHeading: { color: muted, fontSize: 7, fontWeight: 800, marginBottom: 3, textTransform: 'uppercase', letterSpacing: 1 },
  footerPaymentText: { color: footerText, fontSize: 8, lineHeight: 1.5 },
})

function dateLabel(value?: string | null) {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat('en-KE', { dateStyle: 'medium' }).format(date)
}

function cleanUrl(url?: string | null) {
  if (!url) return ''
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '')
}

function ContactDots({ items }: { items: (string | null | undefined)[] }) {
  const visible = items.filter(Boolean)
  return (
    <View style={styles.businessMetaRow}>
      {visible.map((item, index) => (
        <View key={index} style={{ flexDirection: 'row', alignItems: 'center' }}>
          <Text style={styles.businessMeta}>{item}</Text>
          {index < visible.length - 1 && <Text style={styles.businessMetaDot}>•</Text>}
        </View>
      ))}
    </View>
  )
}

function FooterContacts({ items }: { items: (string | null | undefined)[] }) {
  const visible = items.filter(Boolean)
  return (
    <View style={styles.footerContacts}>
      {visible.map((item, index) => (
        <View key={index} style={{ flexDirection: 'row', alignItems: 'center' }}>
          <Text style={styles.footerContact}>{item}</Text>
          {index < visible.length - 1 && <Text style={styles.footerContactDot}>•</Text>}
        </View>
      ))}
    </View>
  )
}

function QuotePdfDocument({ quote }: { quote: QuoteDocumentData }) {
  const lines = quote.lines.length ? quote.lines : null
  const org = quote.organisation
  const contacts = [org.email, org.phone, org.country, cleanUrl(org.website)]
  const hasFooterDetails = contacts.some(Boolean) || org.paymentInstructions

  return (
    <Document title={`Quotation ${quote.documentNumber}`} author={org.name} subject="Business quotation">
      <Page size="A4" style={styles.page} wrap>
        <View style={styles.header}>
          <View style={styles.brand}>
            {org.logoUrl
              ? <Image src={assetUrl(org.logoUrl) ?? undefined} style={styles.logo} />
              : <View style={styles.logoFallback}><Text>{org.name.slice(0, 1).toUpperCase()}</Text></View>}
            <View style={styles.businessDetails}>
              <Text style={styles.businessName}>{org.name}</Text>
              <ContactDots items={contacts} />
            </View>
          </View>
          <View style={styles.titleBlock}>
            <Text style={styles.title}>QUOTATION</Text>
            <Text style={styles.documentNumber}>{quote.documentNumber}</Text>
            <Text style={styles.meta}>Prepared {dateLabel(quote.createdAt) || dateLabel(new Date().toISOString())}</Text>
            {quote.validUntil && <Text style={styles.meta}>Valid until {dateLabel(quote.validUntil)}</Text>}
          </View>
        </View>

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
            <View style={styles.row} key={line.id ?? `${line.description}-${index}`} wrap={false}>
              <View style={styles.descriptionColumn}>
                <Text style={styles.description}>{line.description}</Text>
                {line.unit && <Text style={styles.unit}>{line.unit}</Text>}
              </View>
              <Text style={[styles.quantityColumn, styles.cell]}>{line.quantity}</Text>
              <Text style={[styles.unitPriceColumn, styles.cell]}>{formatMoney(line.unitPrice, quote.currency)}</Text>
              <Text style={[styles.taxColumn, styles.cell]}>{line.taxRate == null ? '—' : `${line.taxRate}%`}</Text>
              <Text style={[styles.amountColumn, styles.amountCell]}>{formatMoney(line.quantity * line.unitPrice, quote.currency)}</Text>
            </View>
          )) : <Text style={styles.empty}>Line items will appear here.</Text>}
        </View>

        <View style={styles.totals} wrap={false}>
          <View style={styles.totalRow}><Text>Subtotal</Text><Text style={styles.totalValue}>{formatMoney(quote.subtotal, quote.currency)}</Text></View>
          <View style={styles.totalRow}><Text>Tax</Text><Text style={styles.totalValue}>{formatMoney(quote.taxTotal, quote.currency)}</Text></View>
          <View style={styles.grandTotal}><Text>Total</Text><Text style={{ color: brandGreen, fontSize: 14, fontWeight: 700 }}>{formatMoney(quote.total, quote.currency)}</Text></View>
        </View>

        {(quote.notes || quote.terms || org.paymentInstructions) && (
          <View style={styles.notesBlock} wrap={false}>
            {quote.notes && <View style={styles.note}>
              <Text style={styles.noteHeading}>NOTES</Text>
              <Text style={styles.noteText}>{quote.notes}</Text>
            </View>}
            {quote.terms && <View style={styles.note}>
              <Text style={styles.noteHeading}>TERMS</Text>
              <Text style={styles.noteText}>{quote.terms}</Text>
            </View>}
            {org.paymentInstructions && <View style={styles.note}>
              <Text style={styles.noteHeading}>PAYMENT INSTRUCTIONS</Text>
              <Text style={styles.noteText}>{org.paymentInstructions}</Text>
            </View>}
          </View>
        )}

        {hasFooterDetails && (
          <View style={styles.footer} fixed>
            <View style={styles.footerMain}>
              <Text style={styles.footerThanks}>Thank you for your consideration.</Text>
              <FooterContacts items={contacts} />
            </View>
            {org.paymentInstructions && (
              <View style={styles.footerPayment}>
                <Text style={styles.footerPaymentHeading}>PAYMENT DETAILS</Text>
                <Text style={styles.footerPaymentText}>{org.paymentInstructions}</Text>
              </View>
            )}
          </View>
        )}
      </Page>
    </Document>
  )
}

export function QuotePdfDownloadLink({ quote, className }: { quote: QuoteDocumentData; className?: string }) {
  const filename = `${quote.documentNumber.replace(/[^a-zA-Z0-9_-]/g, '-') || 'quotation'}.pdf`
  return (
    <PDFDownloadLink
      className={className}
      document={<QuotePdfDocument quote={quote} />}
      fileName={filename}
    >
      {({ loading, error }) => loading ? 'Preparing PDF…' : error ? 'PDF unavailable' : 'Download PDF'}
    </PDFDownloadLink>
  )
}
