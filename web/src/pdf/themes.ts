// Each quotation template is a theme: plain data read by ONE renderer.
// Adding a template means adding an entry here, not writing a new document component.

export type TemplateKey = 'classic' | 'modern' | 'minimal' | 'bold' | 'compact'

export type TemplateTheme = {
  key: TemplateKey
  label: string
  description: string
  bestFor: string
  /** plain = ink on white; band = accent-coloured header band; dark = near-black band with accent bar */
  header: 'plain' | 'band' | 'dark'
  /** lined = soft grey header; striped = accent header with zebra rows; boxed = outlined, tinted header; minimal = ink rule only */
  table: 'lined' | 'striped' | 'boxed' | 'minimal'
  /** wash = tinted box with accent bar; solid = accent fill; rule = ink lines above and below */
  totalBox: 'wash' | 'solid' | 'rule'
  /** Built-in PDF fonts only, so nothing has to be downloaded or bundled. */
  titleFont: 'Helvetica-Bold' | 'Times-Bold'
  titleSize: number
  titleSpacing: number
  density: 'comfortable' | 'compact'
}

export const DEFAULT_TEMPLATE: TemplateKey = 'modern'

export const TEMPLATES: Record<TemplateKey, TemplateTheme> = {
  classic: {
    key: 'classic',
    label: 'Classic',
    description: 'Serif title, thin rules, white page. Quiet and formal.',
    bestFor: 'Consultants, legal, professional services',
    header: 'plain',
    table: 'boxed',
    totalBox: 'rule',
    titleFont: 'Times-Bold',
    titleSize: 24,
    titleSpacing: 1.5,
    density: 'comfortable',
  },
  modern: {
    key: 'modern',
    label: 'Modern',
    description: 'Full-width colour band, zebra rows, solid total.',
    bestFor: 'General use, agencies, most businesses',
    header: 'band',
    table: 'striped',
    totalBox: 'solid',
    titleFont: 'Helvetica-Bold',
    titleSize: 22,
    titleSpacing: 2,
    density: 'comfortable',
  },
  minimal: {
    key: 'minimal',
    label: 'Minimal',
    description: 'Lots of white space, one ink rule, no fills.',
    bestFor: 'Designers, architects, premium small firms',
    header: 'plain',
    table: 'minimal',
    totalBox: 'rule',
    titleFont: 'Helvetica-Bold',
    titleSize: 16,
    titleSpacing: 5,
    density: 'comfortable',
  },
  bold: {
    key: 'bold',
    label: 'Bold',
    description: 'Dark header, accent bar, high-contrast total.',
    bestFor: 'Signage, printing, fabrication, branding',
    header: 'dark',
    table: 'striped',
    totalBox: 'solid',
    titleFont: 'Helvetica-Bold',
    titleSize: 26,
    titleSpacing: 3,
    density: 'comfortable',
  },
  compact: {
    key: 'compact',
    label: 'Compact',
    description: 'Tighter rows and smaller header so long lists fit.',
    bestFor: 'Retail, wholesale, many line items',
    header: 'plain',
    table: 'lined',
    totalBox: 'wash',
    titleFont: 'Helvetica-Bold',
    titleSize: 17,
    titleSpacing: 2,
    density: 'compact',
  },
}

export const TEMPLATE_LIST: TemplateTheme[] = Object.values(TEMPLATES)

export function resolveTemplate(key?: string | null): TemplateTheme {
  return (key && key in TEMPLATES ? TEMPLATES[key as TemplateKey] : TEMPLATES[DEFAULT_TEMPLATE])
}
