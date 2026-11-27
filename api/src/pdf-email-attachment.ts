import { loadPdfLogo, pdfFilename, withLogo } from './pdf-service.js'
import type { PdfRenderClient } from './pdf-worker-client.js'
import type { DocumentDesign } from './document-design.js'
import type { PdfData } from './document-pdf.js'

export const MAX_EMAIL_PDF_BYTES = 8 * 1024 * 1024

export type PdfEmailAttachment = { filename: string; content: string }
export type PdfEmailAttachmentOutcome = {
  attachedPdf: boolean
  pdfBytes: number | null
  attachmentError: string | null
  attachments: PdfEmailAttachment[]
}

function skipped(attachmentError: string | null = null): PdfEmailAttachmentOutcome {
  return { attachedPdf: false, pdfBytes: null, attachmentError, attachments: [] }
}

export async function preparePdfEmailAttachment(
  requested: boolean,
  enabled: boolean,
  data: PdfData,
  design: DocumentDesign,
  logoUrl: string | null | undefined,
  uploadsDir: string,
  render: PdfRenderClient,
): Promise<PdfEmailAttachmentOutcome> {
  if (!requested) return skipped()
  if (!enabled) return skipped('PDF attachments are not enabled on this deployment. The email was sent without an attachment.')
  try {
    const logoData = await loadPdfLogo(logoUrl, uploadsDir)
    const result = await render.render(withLogo(data, logoData), design)
    if (result.buffer.byteLength > MAX_EMAIL_PDF_BYTES) {
      console.warn(JSON.stringify({ event: 'document_pdf_email_attachment_skipped', kind: data.kind, reason: 'size_limit', bytes: result.buffer.byteLength, maximumBytes: MAX_EMAIL_PDF_BYTES }))
      return skipped(`The generated PDF is larger than the ${MAX_EMAIL_PDF_BYTES / 1024 / 1024} MB email attachment limit. The email was sent without an attachment.`)
    }
    const kind = data.kind === 'quote' ? 'quotation' : data.kind
    console.info(JSON.stringify({ event: 'document_pdf_email_attachment_ready', kind: data.kind, bytes: result.buffer.byteLength }))
    return {
      attachedPdf: true,
      pdfBytes: result.buffer.byteLength,
      attachmentError: null,
      attachments: [{ filename: pdfFilename(data.documentNumber, kind), content: result.buffer.toString('base64') }],
    }
  } catch (error) {
    console.warn(JSON.stringify({ event: 'document_pdf_email_attachment_skipped', kind: data.kind, reason: 'render_failed', message: error instanceof Error ? error.message : 'Unknown PDF attachment error.' }))
    return skipped('The PDF could not be generated. The email was sent without the attachment; download a copy from iQuote.')
  }
}
