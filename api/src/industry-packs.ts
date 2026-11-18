export type StarterServiceItem = {
  name: string
  category: string
  kind: 'SERVICE' | 'PRODUCT'
  description: string
  unit: string
}

export type StarterQuoteTemplate = {
  name: string
  description: string
  workflow: string
  lineItems: Array<{ description: string; unit: string }>
  defaultNotes: string
  defaultTerms: string
}

export type IndustryPack = { services: StarterServiceItem[]; templates: StarterQuoteTemplate[] }

const commonTerms = 'Pricing covers only the work listed. Any additional work will be quoted for approval before it begins.'

const packs: Record<string, IndustryPack> = {
  handyman: {
    services: [
      { name: 'Call-out and assessment', category: 'Visit & diagnosis', kind: 'SERVICE', description: 'Travel to site and assess the requested work.', unit: 'visit' },
      { name: 'Repair labour', category: 'Labour', kind: 'SERVICE', description: 'Handyman labour on site.', unit: 'hour' },
      { name: 'Installation labour', category: 'Labour', kind: 'SERVICE', description: 'Installation work at the customer site.', unit: 'hour' },
      { name: 'Materials and fittings', category: 'Materials', kind: 'PRODUCT', description: 'Materials required for the approved work.', unit: 'item' },
      { name: 'Removal and disposal', category: 'Finishing & disposal', kind: 'SERVICE', description: 'Removal and disposal of agreed waste.', unit: 'job' },
    ],
    templates: [
      { name: 'Repair visit', description: 'Assess the issue, then price the agreed repair.', workflow: 'VISIT_AND_REPAIR', lineItems: [{ description: 'Call-out and assessment', unit: 'visit' }, { description: 'Repair labour', unit: 'hour' }, { description: 'Materials and fittings', unit: 'item' }], defaultNotes: 'Final materials and work are confirmed after the site assessment.', defaultTerms: commonTerms },
      { name: 'Installation project', description: 'Price installation work, materials, and finishing.', workflow: 'LABOUR_AND_MATERIALS', lineItems: [{ description: 'Installation labour', unit: 'hour' }, { description: 'Materials and fittings', unit: 'item' }, { description: 'Removal and disposal', unit: 'job' }], defaultNotes: 'Confirm measurements and access before work starts.', defaultTerms: commonTerms },
    ],
  },
  plumbing: {
    services: [
      { name: 'Plumbing call-out', category: 'Visit & diagnosis', kind: 'SERVICE', description: 'Attend site and inspect the plumbing issue.', unit: 'visit' },
      { name: 'Leak or blockage repair', category: 'Repairs', kind: 'SERVICE', description: 'Labour to repair a leak or clear a blockage.', unit: 'hour' },
      { name: 'Pipework installation', category: 'Installation', kind: 'SERVICE', description: 'Install or replace pipework.', unit: 'hour' },
      { name: 'Plumbing parts', category: 'Materials', kind: 'PRODUCT', description: 'Pipes, fittings, valves, and other parts.', unit: 'item' },
      { name: 'Water system check', category: 'Inspection', kind: 'SERVICE', description: 'Check the completed work for leaks and operation.', unit: 'job' },
    ],
    templates: [
      { name: 'Plumbing repair visit', description: 'Diagnose and quote a repair with parts.', workflow: 'VISIT_AND_REPAIR', lineItems: [{ description: 'Plumbing call-out', unit: 'visit' }, { description: 'Leak or blockage repair', unit: 'hour' }, { description: 'Plumbing parts', unit: 'item' }], defaultNotes: 'Parts are confirmed after inspection.', defaultTerms: commonTerms },
      { name: 'Pipework installation', description: 'Price labour, pipework, and system checks.', workflow: 'LABOUR_AND_MATERIALS', lineItems: [{ description: 'Pipework installation', unit: 'hour' }, { description: 'Plumbing parts', unit: 'item' }, { description: 'Water system check', unit: 'job' }], defaultNotes: 'Customer access to the work area is required.', defaultTerms: commonTerms },
    ],
  },
  electrical: {
    services: [
      { name: 'Electrical call-out', category: 'Visit & diagnosis', kind: 'SERVICE', description: 'Attend site and assess the electrical request.', unit: 'visit' },
      { name: 'Electrical fault finding', category: 'Inspection', kind: 'SERVICE', description: 'Trace and diagnose an electrical fault.', unit: 'hour' },
      { name: 'Electrical installation labour', category: 'Labour', kind: 'SERVICE', description: 'Installation or repair labour.', unit: 'hour' },
      { name: 'Electrical parts and fittings', category: 'Materials', kind: 'PRODUCT', description: 'Cables, fittings, switches, and parts.', unit: 'item' },
      { name: 'Testing and handover', category: 'Inspection', kind: 'SERVICE', description: 'Test the completed work and hand it over.', unit: 'job' },
    ],
    templates: [
      { name: 'Electrical service visit', description: 'Assess a fault, then price labour and parts.', workflow: 'VISIT_AND_REPAIR', lineItems: [{ description: 'Electrical call-out', unit: 'visit' }, { description: 'Electrical fault finding', unit: 'hour' }, { description: 'Electrical parts and fittings', unit: 'item' }], defaultNotes: 'The scope is confirmed after testing the reported issue.', defaultTerms: commonTerms },
      { name: 'Electrical installation', description: 'Price installation labour, fittings, and testing.', workflow: 'LABOUR_AND_MATERIALS', lineItems: [{ description: 'Electrical installation labour', unit: 'hour' }, { description: 'Electrical parts and fittings', unit: 'item' }, { description: 'Testing and handover', unit: 'job' }], defaultNotes: 'Customer access to the work area is required.', defaultTerms: commonTerms },
    ],
  },
  cleaning: {
    services: [
      { name: 'Standard cleaning', category: 'Cleaning services', kind: 'SERVICE', description: 'Routine cleaning for the agreed rooms or area.', unit: 'visit' },
      { name: 'Deep cleaning', category: 'Cleaning services', kind: 'SERVICE', description: 'Detailed cleaning for the agreed rooms or area.', unit: 'visit' },
      { name: 'Move-in or move-out cleaning', category: 'Cleaning services', kind: 'SERVICE', description: 'Turnover clean for an empty or vacated property.', unit: 'job' },
      { name: 'Window cleaning', category: 'Add-ons', kind: 'SERVICE', description: 'Clean accessible interior or exterior windows.', unit: 'window' },
      { name: 'Cleaning supplies', category: 'Materials', kind: 'PRODUCT', description: 'Consumable supplies for the service.', unit: 'visit' },
    ],
    templates: [
      { name: 'One-time clean', description: 'Set out the service, add-ons, and supplies.', workflow: 'CLEANING_VISIT', lineItems: [{ description: 'Standard cleaning', unit: 'visit' }, { description: 'Window cleaning', unit: 'window' }, { description: 'Cleaning supplies', unit: 'visit' }], defaultNotes: 'Please confirm room count, access, and requested add-ons.', defaultTerms: commonTerms },
      { name: 'Deep clean', description: 'Quote a detailed one-off cleaning visit.', workflow: 'CLEANING_VISIT', lineItems: [{ description: 'Deep cleaning', unit: 'visit' }, { description: 'Cleaning supplies', unit: 'visit' }], defaultNotes: 'The quote assumes the rooms and condition described by the customer.', defaultTerms: commonTerms },
    ],
  },
  construction: {
    services: [
      { name: 'Site visit and measurement', category: 'Planning & visits', kind: 'SERVICE', description: 'Attend site, take measurements, and discuss scope.', unit: 'visit' },
      { name: 'Skilled labour', category: 'Labour', kind: 'SERVICE', description: 'Skilled work for the agreed project scope.', unit: 'day' },
      { name: 'General labour', category: 'Labour', kind: 'SERVICE', description: 'General project labour.', unit: 'day' },
      { name: 'Building materials', category: 'Materials', kind: 'PRODUCT', description: 'Materials specified for the project.', unit: 'item' },
      { name: 'Finishing work', category: 'Finishing', kind: 'SERVICE', description: 'Finishing tasks included in the scope.', unit: 'job' },
    ],
    templates: [
      { name: 'Site assessment', description: 'Start with a visit and a scoped project estimate.', workflow: 'SITE_VISIT', lineItems: [{ description: 'Site visit and measurement', unit: 'visit' }, { description: 'Project estimate preparation', unit: 'job' }], defaultNotes: 'This assessment precedes the detailed project quotation.', defaultTerms: commonTerms },
      { name: 'Labour and materials', description: 'Separate labour, materials, and finishing.', workflow: 'PROJECT_SCOPE', lineItems: [{ description: 'Skilled labour', unit: 'day' }, { description: 'General labour', unit: 'day' }, { description: 'Building materials', unit: 'item' }, { description: 'Finishing work', unit: 'job' }], defaultNotes: 'Project stages and material selections are confirmed before work begins.', defaultTerms: commonTerms },
    ],
  },
  retail: {
    services: [
      { name: 'Product', category: 'Products', kind: 'PRODUCT', description: 'Add your product name, size, or model.', unit: 'item' },
      { name: 'Bulk product order', category: 'Products', kind: 'PRODUCT', description: 'Products supplied in bulk quantities.', unit: 'box' },
      { name: 'Delivery', category: 'Delivery & installation', kind: 'SERVICE', description: 'Deliver products to the customer location.', unit: 'trip' },
      { name: 'Installation', category: 'Delivery & installation', kind: 'SERVICE', description: 'Install the supplied products.', unit: 'hour' },
    ],
    templates: [
      { name: 'Product and delivery', description: 'Quote products, delivery, and installation.', workflow: 'PRODUCT_DELIVERY', lineItems: [{ description: 'Product', unit: 'item' }, { description: 'Delivery', unit: 'trip' }, { description: 'Installation', unit: 'hour' }], defaultNotes: 'Confirm product selection, quantity, and delivery address.', defaultTerms: commonTerms },
    ],
  },
}

const generalPack: IndustryPack = {
  services: [
    { name: 'Discovery or assessment', category: 'Planning', kind: 'SERVICE', description: 'Initial meeting or assessment.', unit: 'session' },
    { name: 'Professional service', category: 'Services', kind: 'SERVICE', description: 'Describe the service and deliverable.', unit: 'hour' },
    { name: 'Project deliverable', category: 'Deliverables', kind: 'SERVICE', description: 'A defined project output.', unit: 'item' },
    { name: 'Materials or expenses', category: 'Materials & expenses', kind: 'PRODUCT', description: 'Materials or agreed project expenses.', unit: 'item' },
  ],
  templates: [
    { name: 'Service engagement', description: 'Quote a professional service with clear deliverables.', workflow: 'SERVICE_ENGAGEMENT', lineItems: [{ description: 'Discovery or assessment', unit: 'session' }, { description: 'Professional service', unit: 'hour' }, { description: 'Project deliverable', unit: 'item' }], defaultNotes: 'Deliverables and timing follow the scope listed in this quote.', defaultTerms: commonTerms },
    { name: 'Fixed-scope project', description: 'Break a project into scoped deliverables.', workflow: 'PROJECT_SCOPE', lineItems: [{ description: 'Project deliverable', unit: 'item' }, { description: 'Professional service', unit: 'hour' }, { description: 'Materials or expenses', unit: 'item' }], defaultNotes: 'Work outside this scope will be quoted separately for approval.', defaultTerms: commonTerms },
  ],
}

export function getIndustryPack(businessType: string | null | undefined): IndustryPack {
  const value = (businessType ?? '').toLowerCase()
  if (value.includes('handyman') || value.includes('home repair')) return packs.handyman
  if (value.includes('plumb')) return packs.plumbing
  if (value.includes('electric')) return packs.electrical
  if (value.includes('clean')) return packs.cleaning
  if (value.includes('construction') || value.includes('contract')) return packs.construction
  if (value.includes('retail') || value.includes('product')) return packs.retail
  return generalPack
}
