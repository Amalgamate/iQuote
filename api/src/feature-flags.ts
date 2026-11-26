// Feature flags for the document design and automatic PDF attachment work
// (docs/DOCUMENT_DESIGN_PLAN.md). Every flag is OFF unless its environment variable is
// explicitly set to 1, true, yes or on. Pure functions, no framework dependency.

export const DOCUMENT_FLAG_NAMES = [
  'DOCUMENT_DESIGN_ENABLED',
  'SERVER_PDF_ENABLED',
  'EMAIL_PDF_ATTACH_ENABLED',
] as const
export type DocumentFlagName = (typeof DOCUMENT_FLAG_NAMES)[number]

const ON_VALUES = new Set(['1', 'true', 'yes', 'on'])

type Env = Record<string, string | undefined>

/** True only when the variable is set to an "on" value. Missing, empty or unknown values mean off. */
export function flagEnabled(name: DocumentFlagName, env: Env = process.env): boolean {
  const raw = env[name]
  return typeof raw === 'string' && ON_VALUES.has(raw.trim().toLowerCase())
}

export type DocumentFlags = {
  /** Settings screen and document design API. */
  documentDesign: boolean
  /** Server-side PDF rendering (downloads, previews). */
  serverPdf: boolean
  /** Attach the PDF to customer emails. Needs server rendering, so it is off whenever serverPdf is off. */
  emailPdfAttach: boolean
}

export function documentFlags(env: Env = process.env): DocumentFlags {
  const serverPdf = flagEnabled('SERVER_PDF_ENABLED', env)
  return {
    documentDesign: flagEnabled('DOCUMENT_DESIGN_ENABLED', env),
    serverPdf,
    emailPdfAttach: serverPdf && flagEnabled('EMAIL_PDF_ATTACH_ENABLED', env),
  }
}
