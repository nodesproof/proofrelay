# ProofRelay Frontend Design Direction

## Three initial approaches

### Theme Name: Evidence Ledger
Very Brief Intro: A warm, editorial operations dashboard that makes verification feel like careful research rather than cold infrastructure. Cream paper, ink navy, citrus verification marks, and visible provenance cues create a confident, human-readable interface.

Probability: 0.07

### Theme Name: Signal Room
Very Brief Intro: A dark, high-contrast mission-control interface for watching AI verification move through a live network. Sharp cobalt, acid green, and restrained data-glow make every verdict feel operational and immediate.

Probability: 0.04

### Theme Name: Quiet Protocol
Very Brief Intro: A pale, architectural interface that treats evidence like a civic utility: calm surfaces, modular blocks, and precise redaction-like details. It prioritizes legibility, trust, and low cognitive load.

Probability: 0.09

## Selected approach: Evidence Ledger

### Design Movement
Contemporary editorial systems design with the discipline of Swiss information design and the tactility of a research notebook. ProofRelay should feel like a high-trust instrument for people who need to inspect how an answer was made.

### Core Principles
1. **Proof is visible.** Provenance, evidence state, verifier disagreement, and settlement should be first-class visual objects rather than hidden behind tabs.
2. **Warm precision.** Use a paper-like canvas and ink-dark type with sharp citrus accents for verified states; avoid sterile SaaS blue and generic purple gradients.
3. **Asymmetric editorial rhythm.** Use a persistent left rail, an offset content column, a strong main task card, and stacked evidence modules instead of a centered grid everywhere.
4. **Calm urgency.** The interface can call attention to disputes and pending work, but never use alarmist color everywhere.

### Color Philosophy
The signature color is **Proof Citrus** (#C7F36B): a vivid verification mark that feels like a highlighter on a research page. It only appears where the system is asserting a state—verified, live, or selected. The base is **Ledger Ink** (#0D1721), providing authority and contrast. **Paper Fog** (#F4F1E8) carries the workspace, while **Signal Coral** (#FF765D) is reserved for conflict or challenge. **Storage Sky** (#A9D8FF) represents artifacts and 0G infrastructure without making the product feel like a generic blue SaaS dashboard.

### Layout Paradigm
A persistent dark left rail anchors navigation and product identity. The main canvas uses an asymmetric 12-column composition: a wide editorial task overview on the left, a narrow status rail on the right, then a full-width evidence trail below. Important actions sit at the top edge of their context rather than in a universal centered hero.

### Signature Elements
1. A **proof spine**: a thin vertical rail that connects task → source snapshot → verifier runs → settlement.
2. **Evidence chips**: small hash, model, source, and timestamp labels that make technical provenance readable.
3. **Citrus marker**: a neon-lime slash or dot used sparingly to mark verified or selected states.

### Interaction Philosophy
Every interaction should answer “what changed?” Tabs switch the evidence lens without losing task context. Hovering a source reveals its snapshot metadata. Clicking a verifier expands its reasoning summary and artifact pointers. Dispute actions are explicit and require a reason, never hidden behind ambiguous icons.

### Animation
Use short, decisive transitions under 240ms. Cards lift 2px on hover, proof spine nodes pulse only when a verification stage is active, and tab changes use opacity plus a small translateY. Avoid looping motion except for the live status dot. Respect reduced-motion preferences.

### Typography System
Use **Space Grotesk** for headlines, navigation, task IDs, and numeric emphasis; use **DM Sans** for body copy, labels, and form fields. Headlines are compact and slightly tracked; body copy is generous and readable. Monospace is reserved for hashes, addresses, and schema snippets.

### Brand Essence
ProofRelay is the evidence settlement layer for AI outputs—built for teams who need to know not only what an agent said, but why it should be trusted.

Personality adjectives: **forensic, composed, accountable**.

### Brand Voice
Headlines are direct, specific, and slightly editorial. CTAs are verbs that describe a real action. Microcopy explains system state without overpromising truth.

Example lines:

- “Make the claim earn its confidence.”
- “Two verifiers agree. The evidence is still yours to inspect.”

### Wordmark & Logo
Use a compact wordmark with the “P” formed from a vertical ledger spine and a citrus proof mark cutting through the bowl. The symbol is a small stacked bracket / relay glyph that can stand alone in the rail and favicon.

### Signature Brand Color
**Proof Citrus — #C7F36B**. It is ownable because it behaves like an evidence highlighter rather than a generic success green.

## Implementation note

Keep this design philosophy at the top of every CSS/component/page file edited for ProofRelay. When uncertain, ask: “Does this make evidence easier to inspect, or does it merely decorate the dashboard?”
