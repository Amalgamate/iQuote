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

const ink = '#18212d'
const muted = '#5e6874'
const rule = '#c8cdd3'

const styles = StyleSheet.create({
  page: { paddingTop: 42, paddingBottom: 55, paddingHorizontal: 46, color: ink, fontFamily: 'Helvetica', fontSize: 9 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', paddingBottom: 20, borderBottomWidth: 1, borderBottomColor: '#8993a0' },
  business: { flexDirection: 'row', alignItems: 'flex-start', gap: 11, flex: 1, paddingRight: 20 },
  logo: { width: 42, height: 42, objectFit: 'contain' },
  logoFallback: { width: 42, height: 42, borderWidth: 1, borderColor: rule, alignItems: 'center', justifyContent: 'center', fontSize: 16, fontWeight: 700, color: '#26364a' },
  businessDetails: { flexDirection: 'column', gap: 4, flex: 1 },
  businessName: { fontSize: 13, fontWeight: 700, color: ink, marginBottom: 1 },
  businessMeta: { fontSize: 8, color: muted },
  titleBlock: { width: 185, alignItems: 'flex-end', gap: 5 },
  title: { fontSize: 18, fontWeight: 700, letterSpacing: 0.5, color: ink, marginBottom: 2 },
  documentNumber: { fontSize: 9, fontWeight: 700, color: ink },
  meta: { fontSize: 8, color: muted },
  recipient: { paddingTop: 22, paddingBottom: 18, gap: 5 },
  eyebrow: { fontSize: 7, fontWeight: 700, letterSpacing: 0.8, color: muted, marginBottom: 3 },
  recipientName: { fontSize: 11, fontWeight: 700, color: ink },
  table: { width: '100%', marginTop: 2 },
  tableHeader: { flexDirection: 'row', alignItems: 'center', minHeight: 25, borderTopWidth: 1, borderTopColor: '#8993a0', borderBottomWidth: 1, borderBottomColor: '#8993a0', color: '#384454', fontSize: 7, fontWeight: 700 },
  row: { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 9, borderBottomWidth: 0.5, borderBottomColor: '#e0e3e6' },
  descriptionColumn: { width: '45%', paddingRight: 8 },
  quantityColumn: { width: '9%', paddingRight: 4 },
  unitPriceColumn: { width: '19%', paddingRight: 4 },
  taxColumn: { width: '10%', paddingRight: 4 },
  amountColumn: { width: '17%', textAlign: 'right' },
  headerCell: { paddingHorizontal: 4 },
  description: { color: ink, fontSize: 8.5, lineHeight: 1.35 },
  unit: { color: muted, fontSize: 7.5, marginTop: 3 },
  cell: { color: '#384454', fontSize: 8.5, lineHeight: 1.35 },
  empty: { color: muted, textAlign: 'center', paddingVertical: 13, fontSize: 8 },
  totals: { width: 220, alignSelf: 'flex-end', marginTop: 14, gap: 7 },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 12, color: muted, fontSize: 8.5 },
  totalValue: { color: ink, fontSize: 8.5 },
  grandTotal: { flexDirection: 'row', justifyContent: 'space-between', paddingTop: 9, marginTop: 2, borderTopWidth: 1, borderTopColor: '#8993a0', color: ink, fontSize: 10, fontWeight: 700 },
  note: { marginTop: 19, gap: 5 },
  noteHeading: { color: '#384454', fontSize: 7.5, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase' },
  noteText: { color: muted, fontSize: 8.5, lineHeight: 1.45 },
  footer: { position: 'absolute', bottom: 26, left: 46, right: 46, paddingTop: 8, borderTopWidth: 0.5, borderTopColor: rule, flexDirection: 'row', justifyContent: 'space-between', color: muted, fontSize: 7 },
})

function dateLabel(value?: string | null) {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat('en-KE', { dateStyle: 'medium' }).format(date)
}

function QuotePdfDocument({ quote }: { quote: QuoteDocumentData }) {
  const lines = quote.lines.length ? quote.lines : null

  return (
    <Document title={`Quotation ${quote.documentNumber}`} author={quote.organisation.name} subject="Business quotation">
      <Page size="A4" style={styles.page} wrap>
        <View style={styles.header}>
          <View style={styles.business}>
            {quote.organisation.logoUrl
              ? <Image src={assetUrl(quote.organisation.logoUrl) ?? undefined} style={styles.logo} />
              : <View style={styles.logoFallback}><Text>{quote.organisation.name.slice(0, 1).toUpperCase()}</Text></View>}
            <View style={styles.businessDetails}>
              <Text style={styles.businessName}>{quote.organisation.name}</Text>
              {quote.organisation.email && <Text style={styles.businessMeta}>{quote.organisation.email}</Text>}
              {quote.organisation.phone && <Text style={styles.businessMeta}>{quote.organisation.phone}</Text>}
              {quote.organisation.country && <Text style={styles.businessMeta}>{quote.organisation.country}</Text>}
            </View>
          </View>
          <View style={styles.titleBlock}>
            <Text style={styles.title}>Quotation</Text>
            <Text style={styles.documentNumber}>{quote.documentNumber}</Text>
            <Text style={styles.meta}>Prepared {dateLabel(quote.createdAt) || dateLabel(new Date().toISOString())}</Text>
            {quote.validUntil && <Text style={styles.meta}>Valid until {dateLabel(quote.validUntil)}</Text>}
          </View>
        </View>

        <View style={styles.recipient}>
          <Text style={styles.eyebrow}>Prepared for</Text>
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
              <Text style={[styles.amountColumn, styles.cell]}>{formatMoney(line.quantity * line.unitPrice, quote.currency)}</Text>
            </View>
          )) : <Text style={styles.empty}>Line items will appear here.</Text>}
        </View>

        <View style={styles.totals} wrap={false}>
          <View style={styles.totalRow}><Text>Subtotal</Text><Text style={styles.totalValue}>{formatMoney(quote.subtotal, quote.currency)}</Text></View>
          <View style={styles.totalRow}><Text>Tax</Text><Text style={styles.totalValue}>{formatMoney(quote.taxTotal, quote.currency)}</Text></View>
          <View style={styles.grandTotal}><Text>Total</Text><Text>{formatMoney(quote.total, quote.currency)}</Text></View>
        </View>

        {quote.notes && <View style={styles.note}>
          <Text style={styles.noteHeading}>Notes</Text>
          <Text style={styles.noteText}>{quote.notes}</Text>
        </View>}
        {quote.terms && <View style={styles.note}>
          <Text style={styles.noteHeading}>Terms</Text>
          <Text style={styles.noteText}>{quote.terms}</Text>
        </View>}
        {quote.organisation.paymentInstructions && <View style={styles.note}>
          <Text style={styles.noteHeading}>Payment instructions</Text>
          <Text style={styles.noteText}>{quote.organisation.paymentInstructions}</Text>
        </View>}

        <View style={styles.footer} fixed>
          <Text>{quote.organisation.name}</Text>
          <Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
        </View>
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
