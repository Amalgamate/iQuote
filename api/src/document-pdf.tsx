import { Document, Image, Page, StyleSheet, Text, View } from '@react-pdf/renderer'
import type { Style } from '@react-pdf/stylesheet'
import type { DocumentDesign } from './document-design.js'
import { TEMPLATE_PRESETS } from './document-design.js'

export type PdfLine = { description: string; quantity: number; unit: string; unitPrice: number; taxRate: number | null; amount: number }
export type PdfBusiness = { name: string; email?: string | null; phone?: string | null; country?: string | null; website?: string | null; address?: string | null; kraPin?: string | null; vatNumber?: string | null; logoData?: string | null }
export type PdfCustomer = { name: string; email?: string | null; phone?: string | null; address?: string | null }
export type PdfQuote = { kind: 'quote'; documentNumber: string; createdAt: string; validUntil?: string | null; currency: string; subtotal: number; taxTotal: number; total: number; notes?: string | null; terms?: string | null; lines: PdfLine[]; customer: PdfCustomer; business: PdfBusiness; publicUrl?: string | null }
export type PdfInvoice = { kind: 'invoice'; documentNumber: string; quoteNumber?: string | null; issueDate: string; dueDate?: string | null; currency: string; subtotal: number; taxTotal: number; total: number; amountPaid: number; balanceDue: number; depositRequired?: number | null; notes?: string | null; lines: PdfLine[]; customer: PdfCustomer; business: PdfBusiness; publicUrl?: string | null }
export type PdfReceipt = { kind: 'receipt'; documentNumber: string; invoiceNumber: string; paymentDate: string; currency: string; amount: number; balanceDue: number; method: string; reference?: string | null; customer: PdfCustomer; business: PdfBusiness }
export type PdfData = PdfQuote | PdfInvoice | PdfReceipt

const ink = '#1c1c1e'
const muted = '#4a5e54'
const hairline = '#e2e8e4'
const fallbackGreen = '#1a5c3f'
const pageX = 44

function luminance(hex: string) {
  const channels = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255).map((value) => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
}
function safeAccent(color: string) {
  if (!/^#[\da-f]{6}$/i.test(color)) return fallbackGreen
  const whiteContrast = 1.05 / (luminance(color) + 0.05)
  return whiteContrast >= 3 ? color : fallbackGreen
}
function onColor(color: string) { return luminance(color) < 0.42 ? '#ffffff' : '#1c1c1e' }
function formatMoney(value: number, currency: string) {
  try { return new Intl.NumberFormat('en-KE', { style: 'currency', currency }).format(value) }
  catch { return `${currency} ${value.toFixed(2)}` }
}
function dateLabel(raw?: string | null) {
  if (!raw) return '—'
  const date = new Date(raw)
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('en-KE', { dateStyle: 'medium' }).format(date)
}
function tint(hex: string, ratio: number) {
  const parts = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16))
  return `#${parts.map((part) => Math.round(255 - (255 - part) * ratio).toString(16).padStart(2, '0')).join('')}`
}
function words(value: number, currency: string) {
  if (!Number.isFinite(value) || value < 0 || value >= 1e12) return ''
  const units = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen']
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety']
  const underThousand = (n: number): string => {
    const parts: string[] = []
    const hundreds = Math.floor(n / 100)
    const rest = n % 100
    if (hundreds) parts.push(`${units[hundreds]} Hundred`)
    if (rest) parts.push(rest < 20 ? units[rest] : `${tens[Math.floor(rest / 10)]}${rest % 10 ? `-${units[rest % 10]}` : ''}`)
    return parts.join(' and ')
  }
  let cents = Math.round(value * 100)
  const minor = cents % 100
  cents = Math.floor(cents / 100)
  if (cents === 0 && minor === 0) return `${currency} Zero Only`
  const scales: [number, string][] = [[1e9, 'Billion'], [1e6, 'Million'], [1e3, 'Thousand']]
  const parts: string[] = []
  for (const [size, label] of scales) { const chunk = Math.floor(cents / size); if (chunk) { parts.push(`${underThousand(chunk)} ${label}`); cents %= size } }
  if (cents) parts.push(underThousand(cents))
  return `${currency} ${parts.join(' ')}${minor ? ` and ${underThousand(minor)} Cents` : ''} Only`
}

function makeStyles(design: DocumentDesign) {
  const template = { ...TEMPLATE_PRESETS[design.template], titleSize: design.template === 'bold' ? 22 : design.template === 'classic' ? 19 : 20, titleSpacing: design.template === 'bold' ? 1.1 : 0.7 }
  const accent = safeAccent(design.brandColor)
  const dark = design.header === 'dark'
  const band = design.header !== 'plain'
  const bandColor = dark ? '#111827' : accent
  const headerInk = band ? onColor(bandColor) : ink
  const small = design.spacing === 'compact'
  const headerFill = design.table === 'striped' ? accent : design.table === 'boxed' ? tint(accent, 0.12) : '#f7f8f7'
  const totalFill = design.total === 'solid' ? accent : design.total === 'wash' ? tint(accent, 0.1) : '#ffffff'
  const styles = StyleSheet.create({
    page: { paddingTop: 42, paddingBottom: 62, paddingHorizontal: pageX, color: ink, fontFamily: design.typeface === 'serif' ? 'Times-Roman' : 'Helvetica', fontSize: small ? 8.5 : 9 },
    header: band ? { marginHorizontal: -pageX, marginTop: -42, paddingHorizontal: pageX, paddingTop: 26, paddingBottom: 22, backgroundColor: bandColor, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' } : { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', paddingBottom: 20, borderBottomWidth: 1, borderBottomColor: hairline },
    accentRule: { height: 4, marginHorizontal: -pageX, backgroundColor: accent },
    brand: { flexGrow: 1, flexShrink: 1, paddingRight: 18 },
    logo: { width: Math.min(small ? 105 : 140, (small ? 105 : 140) * design.logo.scale / 100), height: Math.min(54, 54 * design.logo.scale / 100), objectFit: 'contain', marginBottom: 8 },
    fallbackLogo: { width: 40, height: 40, marginBottom: 8, borderRadius: 5, alignItems: 'center', justifyContent: 'center', backgroundColor: band ? '#ffffff' : accent },
    fallbackLetter: { fontSize: 18, fontWeight: 700, color: band ? bandColor : onColor(accent) },
    business: { fontSize: 13, fontWeight: 700, color: headerInk, marginBottom: 4 },
    businessMeta: { fontSize: 8, color: band && headerInk === '#ffffff' ? '#e5e7eb' : muted, lineHeight: 1.4 },
    docTitle: { width: 190, alignItems: 'flex-end' },
    title: { fontSize: template.titleSize, fontWeight: 700, letterSpacing: template.titleSpacing, color: band ? headerInk : accent, textTransform: 'uppercase', marginBottom: 6 },
    docNumber: { fontSize: 10, fontWeight: 700, color: headerInk, marginBottom: 3 },
    docMeta: { fontSize: 8, color: band && headerInk === '#ffffff' ? '#e5e7eb' : muted, marginBottom: 2, textAlign: 'right' },
    recipient: { paddingTop: small ? 18 : 24, paddingBottom: small ? 14 : 20 },
    eyebrow: { fontSize: 7, fontWeight: 700, letterSpacing: 1.3, color: muted, marginBottom: 5, textTransform: 'uppercase' },
    recipientName: { fontSize: 12, fontWeight: 700, color: ink, marginBottom: 3 },
    meta: { fontSize: 8.5, color: muted, marginBottom: 2 },
    table: { width: '100%', marginTop: 4, borderWidth: design.table === 'boxed' ? 0.7 : 0, borderColor: '#cdd8d1' },
    tableHeader: { flexDirection: 'row', minHeight: 25, alignItems: 'center', backgroundColor: headerFill, borderBottomWidth: 0.8, borderColor: accent },
    row: { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: small ? 6 : 9, borderBottomWidth: design.table === 'minimal' ? 0 : 0.45, borderColor: '#e5eae7' },
    description: { width: '42%', paddingLeft: 5, paddingRight: 8 },
    qty: { width: '11%', paddingHorizontal: 4 },
    unitPrice: { width: '18%', paddingHorizontal: 4 },
    tax: { width: design.show.tax ? '11%' : '0%', paddingHorizontal: design.show.tax ? 4 : 0 },
    amount: { width: design.show.tax ? '18%' : '29%', paddingLeft: 4, paddingRight: 5, textAlign: 'right' },
    headText: { fontSize: 7, fontWeight: 700, color: design.table === 'striped' ? onColor(accent) : ink, textTransform: 'uppercase', letterSpacing: 0.5 },
    bodyText: { fontSize: small ? 8 : 8.5, color: ink, lineHeight: 1.35 },
    mutedText: { fontSize: 7.5, color: muted, marginTop: 2 },
    totals: { width: 240, alignSelf: 'flex-end', marginTop: 16 },
    totalRow: { flexDirection: 'row', justifyContent: 'space-between', color: muted, fontSize: 8.5, marginBottom: 6 },
    totalValue: { fontWeight: 600, color: ink },
    grandTotal: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 10, paddingHorizontal: 12, marginTop: 4, backgroundColor: totalFill, borderLeftWidth: design.total === 'wash' ? 3 : 0, borderLeftColor: accent, borderTopWidth: design.total === 'rule' ? 1 : 0, borderBottomWidth: design.total === 'rule' ? 1 : 0, borderColor: accent, color: design.total === 'solid' ? onColor(accent) : ink, fontSize: 10, fontWeight: 700 },
    grandValue: { fontSize: 13, fontWeight: 700, color: design.total === 'solid' ? onColor(accent) : ink },
    words: { alignSelf: 'flex-end', width: 300, marginTop: 8, textAlign: 'right', color: muted, fontSize: 7.5, fontStyle: 'italic' },
    contentBlock: { marginTop: 18 },
    body: { color: muted, fontSize: 8.5, lineHeight: 1.45 },
    paymentBox: { marginTop: 14, padding: 12, borderWidth: 0.7, borderColor: '#dbe5de', backgroundColor: '#f7faf8', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    qr: { width: 72, height: 72, objectFit: 'contain' },
    acceptance: { marginTop: 18, paddingTop: 10, borderTopWidth: 0.5, borderTopColor: hairline },
    signatureRow: { flexDirection: 'row', marginTop: 18 },
    signatureField: { flexGrow: 1, flexBasis: 0, marginRight: 14 },
    signatureLine: { height: 18, borderBottomWidth: 0.7, borderBottomColor: muted },
    footer: { position: 'absolute', bottom: 0, left: 0, right: 0, paddingTop: 10, paddingBottom: 8, paddingHorizontal: pageX, borderTopWidth: 0.8, borderTopColor: hairline, flexDirection: 'row', justifyContent: 'space-between' },
    footerText: { color: muted, fontSize: 7.5 },
  })
  return { styles, accent, band, template }
}

function Header({ data, design, styles, title, meta }: { data: PdfData; design: DocumentDesign; styles: Record<string, Style>; title: string; meta: string[] }) {
  const taxLines = [design.show.kraPin && data.business.kraPin ? `KRA PIN: ${data.business.kraPin}` : null, data.business.vatNumber ? `VAT: ${data.business.vatNumber}` : null].filter(Boolean).join(' · ')
  return <View style={styles.header}>
    <View style={styles.brand}>
      {data.business.logoData ? <Image src={data.business.logoData} style={styles.logo} /> : <View style={styles.fallbackLogo}><Text style={styles.fallbackLetter}>{data.business.name.slice(0, 1).toUpperCase() || 'B'}</Text></View>}
      <Text style={styles.business}>{data.business.name || 'Business'}</Text>
      {[data.business.email, data.business.phone, data.business.country, data.business.website, data.business.address, taxLines].filter(Boolean).map((item, index) => <Text key={index} style={styles.businessMeta}>{item}</Text>)}
    </View>
    <View style={styles.docTitle}><Text style={styles.title}>{title}</Text><Text style={styles.docNumber}>{data.documentNumber}</Text>{meta.map((item, index) => <Text key={index} style={styles.docMeta}>{item}</Text>)}</View>
  </View>
}

function Recipient({ data, styles, label }: { data: PdfData; styles: Record<string, Style>; label: string }) {
  return <View style={styles.recipient}>
    <Text style={styles.eyebrow}>{label}</Text><Text style={styles.recipientName}>{data.customer.name || 'Customer'}</Text>
    {data.customer.email && <Text style={styles.meta}>{data.customer.email}</Text>}
    {data.customer.phone && <Text style={styles.meta}>{data.customer.phone}</Text>}
    {data.customer.address && <Text style={styles.meta}>{data.customer.address}</Text>}
  </View>
}

function LineTable({ data, design, styles }: { data: PdfQuote | PdfInvoice; design: DocumentDesign; styles: Record<string, Style> }) {
  const columns = [styles.description, styles.qty, styles.unitPrice, ...(design.show.tax ? [styles.tax] : []), styles.amount]
  const headings = ['Description', 'Qty', 'Unit price', ...(design.show.tax ? ['Tax'] : []), 'Amount']
  return <View style={styles.table}>
    <View style={styles.tableHeader} fixed>{headings.map((heading, index) => <Text key={heading} style={[columns[index], styles.headText]}>{heading}</Text>)}</View>
    {data.lines.length ? data.lines.map((line, index) => <View key={`${index}-${line.description}`} style={styles.row}>
      <View style={styles.description}><Text style={styles.bodyText}>{line.description}</Text></View>
      <View style={styles.qty}><Text style={styles.bodyText}>{line.quantity}</Text>{design.show.unit && <Text style={styles.mutedText}>{line.unit}</Text>}</View>
      <Text style={[styles.unitPrice, styles.bodyText]}>{formatMoney(line.unitPrice, data.currency)}</Text>
      {design.show.tax && <Text style={[styles.tax, styles.bodyText]}>{line.taxRate === null ? '—' : `${line.taxRate}%`}</Text>}
      <Text style={[styles.amount, styles.bodyText]}>{formatMoney(line.amount, data.currency)}</Text>
    </View>) : <Text style={styles.body}>No line items.</Text>}
  </View>
}

function Totals({ data, design, styles }: { data: PdfQuote | PdfInvoice; design: DocumentDesign; styles: Record<string, Style> }) {
  const wordsText = design.show.totalInWords ? words(data.total, data.currency) : ''
  return <View>
    <View style={styles.totals} wrap={false}>
      <View style={styles.totalRow}><Text>Subtotal</Text><Text style={styles.totalValue}>{formatMoney(data.subtotal, data.currency)}</Text></View>
      {design.show.tax && <View style={styles.totalRow}><Text>Tax</Text><Text style={styles.totalValue}>{formatMoney(data.taxTotal, data.currency)}</Text></View>}
      {data.kind === 'invoice' && data.amountPaid > 0 && <View style={styles.totalRow}><Text>Amount paid</Text><Text style={styles.totalValue}>{formatMoney(data.amountPaid, data.currency)}</Text></View>}
      <View style={styles.grandTotal}><Text>{data.kind === 'invoice' ? 'Balance due' : 'Total'}</Text><Text style={styles.grandValue}>{formatMoney(data.kind === 'invoice' ? data.balanceDue : data.total, data.currency)}</Text></View>
    </View>
    {wordsText && <Text style={styles.words}>{wordsText}</Text>}
  </View>
}

function Footer({ styles, design }: { styles: Record<string, Style>; design: DocumentDesign }) {
  return <View style={styles.footer} fixed><Text style={styles.footerText}>{design.text.footer || 'Thank you for your business.'}</Text><Text style={styles.footerText} render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} /></View>
}

function QuoteDocument({ data, design, qr }: { data: PdfQuote; design: DocumentDesign; qr?: string }) {
  const { styles, template } = makeStyles(design)
  return <Document title={`${design.text.quoteTitle} ${data.documentNumber}`} author={data.business.name}>
    <Page size="A4" style={styles.page} wrap>
      <Header data={data} design={design} styles={styles} title={design.text.quoteTitle} meta={[`Prepared ${dateLabel(data.createdAt)}`, ...(data.validUntil ? [`Valid until ${dateLabel(data.validUntil)}`] : [])]} />
      {template.header === 'dark' && <View style={styles.accentRule} />}
      <Recipient data={data} styles={styles} label="Prepared for" />
      <LineTable data={data} design={design} styles={styles} />
      <Totals data={data} design={design} styles={styles} />
      {(data.notes || data.terms || (design.show.terms && design.text.terms)) && <View style={styles.contentBlock} wrap>
        {data.notes && <View style={{ marginBottom: 10 }}><Text style={styles.eyebrow}>Notes</Text><Text style={styles.body}>{data.notes}</Text></View>}
        {design.show.terms && (data.terms || design.text.terms) && <View><Text style={styles.eyebrow}>Terms</Text><Text style={styles.body}>{data.terms || design.text.terms}</Text></View>}
      </View>}
      {design.show.paymentBox && (design.payment.paybill || design.payment.till || qr) && <View style={styles.paymentBox} wrap={false}><View><Text style={styles.eyebrow}>Payment details</Text>{design.payment.paybill && <Text style={styles.body}>M-Pesa Paybill: {design.payment.paybill}</Text>}{design.payment.till && <Text style={styles.body}>M-Pesa Till: {design.payment.till}</Text>}</View>{design.show.qr && qr && <Image src={qr} style={styles.qr} />}</View>}
      {design.show.acceptance && <View style={styles.acceptance} wrap={false} minPresenceAhead={90}><Text style={styles.eyebrow}>Acceptance</Text><Text style={styles.body}>To accept this quotation, sign below or approve it online.</Text><View style={styles.signatureRow}>{['Name', 'Signature', 'Date'].map((label) => <View key={label} style={styles.signatureField}><View style={styles.signatureLine} /><Text style={styles.mutedText}>{label}</Text></View>)}</View></View>}
      <Footer styles={styles} design={design} />
    </Page>
  </Document>
}

function InvoiceDocument({ data, design, qr }: { data: PdfInvoice; design: DocumentDesign; qr?: string }) {
  const { styles, template } = makeStyles(design)
  return <Document title={`${design.text.invoiceTitle} ${data.documentNumber}`} author={data.business.name}>
    <Page size="A4" style={styles.page} wrap>
      <Header data={data} design={design} styles={styles} title={design.text.invoiceTitle} meta={[`Issued ${dateLabel(data.issueDate)}`, ...(data.dueDate ? [`Due ${dateLabel(data.dueDate)}`] : []), ...(data.quoteNumber ? [`Quote ${data.quoteNumber}`] : [])]} />
      {template.header === 'dark' && <View style={styles.accentRule} />}
      <Recipient data={data} styles={styles} label="Bill to" />
      <LineTable data={data} design={design} styles={styles} />
      <Totals data={data} design={design} styles={styles} />
      {data.depositRequired !== null && data.depositRequired !== undefined && <View style={[styles.totalRow, { alignSelf: 'flex-end', width: 240, marginTop: 7 }]}><Text>Deposit required</Text><Text style={styles.totalValue}>{formatMoney(data.depositRequired, data.currency)}</Text></View>}
      {data.notes && <View style={styles.contentBlock} wrap><Text style={styles.eyebrow}>Notes and terms</Text><Text style={styles.body}>{data.notes}</Text></View>}
      {design.show.paymentBox && (design.payment.paybill || design.payment.till || qr) && <View style={styles.paymentBox} wrap={false}><View><Text style={styles.eyebrow}>How to pay</Text>{design.payment.paybill && <Text style={styles.body}>M-Pesa Paybill: {design.payment.paybill}</Text>}{design.payment.till && <Text style={styles.body}>M-Pesa Till: {design.payment.till}</Text>}{data.balanceDue > 0 && <Text style={styles.body}>Please pay {formatMoney(data.balanceDue, data.currency)} by {dateLabel(data.dueDate)}.</Text>}</View>{design.show.qr && qr && <Image src={qr} style={styles.qr} />}</View>}
      <Footer styles={styles} design={design} />
    </Page>
  </Document>
}

function ReceiptDocument({ data, design }: { data: PdfReceipt; design: DocumentDesign }) {
  const { styles, template } = makeStyles(design)
  return <Document title={`${design.text.receiptTitle} ${data.documentNumber}`} author={data.business.name}>
    <Page size="A4" style={styles.page} wrap>
      <Header data={data} design={design} styles={styles} title={design.text.receiptTitle} meta={[`Payment date ${dateLabel(data.paymentDate)}`]} />
      {template.header === 'dark' && <View style={styles.accentRule} />}
      <Recipient data={data} styles={styles} label="Received from" />
      <View style={styles.contentBlock}>
        <Text style={styles.eyebrow}>Payment received</Text>
        <View style={styles.grandTotal}><Text>Amount received</Text><Text style={styles.grandValue}>{formatMoney(data.amount, data.currency)}</Text></View>
        <View style={[styles.totalRow, { marginTop: 14 }]}><Text>Receipt number</Text><Text style={styles.totalValue}>{data.documentNumber}</Text></View>
        <View style={styles.totalRow}><Text>Invoice</Text><Text style={styles.totalValue}>{data.invoiceNumber}</Text></View>
        <View style={styles.totalRow}><Text>Payment method</Text><Text style={styles.totalValue}>{data.method.replaceAll('_', ' ')}</Text></View>
        {data.reference && <View style={styles.totalRow}><Text>Reference</Text><Text style={styles.totalValue}>{data.reference}</Text></View>}
        <View style={styles.totalRow}><Text>Remaining invoice balance</Text><Text style={styles.totalValue}>{formatMoney(data.balanceDue, data.currency)}</Text></View>
      </View>
      <Footer styles={styles} design={design} />
    </Page>
  </Document>
}

export function createPdfElement(data: PdfData, design: DocumentDesign, qr?: string) {
  if (data.kind === 'quote') return <QuoteDocument data={data} design={design} qr={qr} />
  if (data.kind === 'invoice') return <InvoiceDocument data={data} design={design} qr={qr} />
  return <ReceiptDocument data={data} design={design} />
}
