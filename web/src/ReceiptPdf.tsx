import { Document, Page, pdf, StyleSheet, Text, View } from '@react-pdf/renderer'
import { useState } from 'react'
import { downloadAuthenticatedFile, downloadBlobFile, formatMoney } from './api'

type ReceiptData = {
  paymentId: string
  receiptNumber: string
  invoiceNumber: string
  customerName: string
  business: { name: string; email?: string | null; phone?: string | null; country?: string | null }
  amount: number
  currency: string
  method: string
  reference?: string | null
  paymentDate: string
}

const styles = StyleSheet.create({
  page: { padding: 48, color: '#172820', fontFamily: 'Helvetica', fontSize: 10 },
  topLine: { height: 7, backgroundColor: '#11785a', marginBottom: 34 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 30 },
  brand: { fontSize: 20, fontWeight: 700, color: '#11785a', marginBottom: 8 },
  muted: { fontSize: 9, color: '#62736b', marginBottom: 4 },
  title: { fontSize: 27, fontWeight: 700, letterSpacing: 0.5, marginBottom: 7 },
  receiptNo: { fontSize: 10, color: '#11785a', fontWeight: 700 },
  status: { backgroundColor: '#e8f4ef', color: '#11785a', paddingVertical: 7, paddingHorizontal: 10, fontWeight: 700 },
  divider: { borderBottomWidth: 1, borderBottomColor: '#dce6e1', marginVertical: 15 },
  section: { marginBottom: 24 },
  label: { fontSize: 8, textTransform: 'uppercase', letterSpacing: 0.7, color: '#62736b', marginBottom: 7 },
  name: { fontSize: 13, fontWeight: 700, marginBottom: 5 },
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#e7eeea' },
  rowLabel: { color: '#62736b' },
  rowValue: { fontWeight: 700, textAlign: 'right' },
  amountCard: { backgroundColor: '#f0f7f4', padding: 18, marginTop: 20 },
  amountLabel: { color: '#62736b', fontSize: 9, marginBottom: 7 },
  amount: { color: '#11785a', fontSize: 24, fontWeight: 700 },
  footer: { position: 'absolute', left: 48, right: 48, bottom: 42, color: '#62736b', fontSize: 8, textAlign: 'center' },
})

function ReceiptDocument({ receipt }: { receipt: ReceiptData }) {
  return (
    <Document title={`Receipt ${receipt.receiptNumber}`} author={receipt.business.name} subject="Payment receipt">
      <Page size="A4" style={styles.page}>
        <View style={styles.topLine} />
        <View style={styles.header}>
          <View>
            <Text style={styles.brand}>{receipt.business.name}</Text>
            {[receipt.business.email, receipt.business.phone, receipt.business.country].filter(Boolean).map((item, index) => <Text style={styles.muted} key={index}>{item}</Text>)}
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <Text style={styles.title}>Receipt</Text>
            <Text style={styles.receiptNo}>{receipt.receiptNumber}</Text>
            <Text style={styles.muted}>{new Intl.DateTimeFormat('en-KE', { dateStyle: 'medium' }).format(new Date(receipt.paymentDate))}</Text>
          </View>
        </View>
        <View style={styles.status}><Text>PAYMENT RECEIVED</Text></View>
        <View style={styles.divider} />
        <View style={styles.section}>
          <Text style={styles.label}>Received from</Text>
          <Text style={styles.name}>{receipt.customerName}</Text>
          <Text style={styles.muted}>For invoice {receipt.invoiceNumber}</Text>
        </View>
        <View style={styles.row}><Text style={styles.rowLabel}>Payment method</Text><Text style={styles.rowValue}>{receipt.method}</Text></View>
        <View style={styles.row}><Text style={styles.rowLabel}>Payment reference</Text><Text style={styles.rowValue}>{receipt.reference || 'Not provided'}</Text></View>
        <View style={styles.amountCard}>
          <Text style={styles.amountLabel}>Amount received</Text>
          <Text style={styles.amount}>{formatMoney(receipt.amount, receipt.currency)}</Text>
        </View>
        <Text style={styles.footer}>This receipt confirms the payment recorded by {receipt.business.name}.</Text>
      </Page>
    </Document>
  )
}

export function ReceiptPdfDownloadLink({ receipt }: { receipt: ReceiptData }) {
  const [downloading, setDownloading] = useState(false)
  const [error, setError] = useState('')
  async function download() {
    setDownloading(true); setError('')
    try {
      try {
        await downloadAuthenticatedFile(`/api/payments/${encodeURIComponent(receipt.paymentId)}/receipt.pdf`, `${receipt.receiptNumber}.pdf`)
      } catch (cause) {
        if (!(cause instanceof Error) || !cause.message.includes('Server PDF rendering is not available on this deployment.')) throw cause
        downloadBlobFile(await pdf(<ReceiptDocument receipt={receipt} />).toBlob(), `${receipt.receiptNumber}.pdf`)
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not download the receipt.') }
    finally { setDownloading(false) }
  }
  return <span className="pdf-download-control"><button type="button" className="dashboard-text-link" onClick={() => void download()} disabled={downloading}>{downloading ? 'Preparing…' : 'Download receipt'}</button>{error && <small role="alert">{error}</small>}</span>
}
