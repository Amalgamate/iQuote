# iQuote Design System

Clean, bold, document-first quoting for independent businesses.

## Personality

Confident, clear, and energetic. Premium tool feel inspired by modern geometric design.

## Typography System

Geometric Sans-Serif across the entire interface (no serif / Georgia):

| Role | Font Family | Weights | Usage |
| --- | --- | --- | --- |
| **Display & Headings** | `Poppins`, `Montserrat`, sans-serif | 700, 800 | H1 hero, section H2 titles, brand wordmark, stats |
| **Card & Subheadings** | `Poppins`, `Montserrat`, sans-serif | 600, 700 | H3 feature titles, plan titles, badge titles |
| **Kickers & Tags** | `Montserrat`, `Poppins`, sans-serif | 700 | Uppercase kickers, badge pills, feature tags (letter-spaced) |
| **Body & Explanations** | `Poppins`, `Montserrat`, sans-serif | 400 | Lede, paragraphs, testimonials, copy |
| **UI & Controls** | `Montserrat`, `Poppins`, sans-serif | 500, 600 | Buttons, tabs, nav links, inputs |
| **Numbers & Currency** | `Montserrat`, `Poppins`, sans-serif | 700, 800 | Totals, quotes, amounts (tabular nums) |

Web-safe fallback stack:
`'Poppins', 'Montserrat', 'Raleway', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif`

---

## Colour System (Solid Blue Themes — NO GRADIENTS)

Strictly solid surfaces, crisp contrast, no gradients or soft blur overlays:

| Token | Hex | Role |
| --- | --- | --- |
| `navy-dark` | `#081120` | Midnight navy — solid header/footer, final CTA banner, brand mark |
| `navy-surface` | `#0E1A2F` | Dark panels, onboarding aside |
| `ink` | `#0A1128` | Primary text and dark emphasis |
| `muted` | `#53647A` | Secondary text, descriptions |
| `line` | `#D8E4F2` | Crisp slate-blue borders (1px) |
| `canvas` | `#F4F8FD` | Light ice-blue page canvas (solid, no radial gradient) |
| `canvas-alt` | `#EBF3FC` | Alternate section tint (testimonials, plans) |
| `surface` | `#FFFFFF` | Card & panel backgrounds |
| `blue-primary` | `#0052FF` | Electric Royal Blue — primary CTAs, active states, key brand accents |
| `blue-hover` | `#003ECC` | Deep royal blue hover state |
| `blue-accent` | `#0284C7` | Bright cyan/azure for radar pings & live indicators |
| `blue-pill` | `#EBF3FF` | Light blue background for badges, chips, and tags |
| `danger` | `#DC2626` | Errors, declined |
| `warning` | `#F59E0B` | Expiring, review stars |
| `success` | `#059669` | Approved state |

---

## Motion & Interactivity

- Floating badges oscillate with `@keyframes floatSoftA` / `floatSoftB` (3.8s to 5s loops).
- Radar pulses with concentric expanding ring on live indicators.
- Feature and testimonial cards lift `-5px` to `-6px` on hover with crisp box shadows.
- `@media(prefers-reduced-motion: reduce)` disables all animations and transitions.
