import { LitElement, html, css } from "lit";

/**
 * @typedef {{ id: string, claim: string, hash: string, timestamp: string, source: string, isCited: boolean }} EvidenceItem
 */

export class DsEvidenceLedger extends LitElement {
  static properties = {
    items: { attribute: false },
  };

  static styles = css`
    :host {
      display: block;
    }
    .ledger-grid {
      display: grid;
      grid-template-columns: 2fr 1fr 1fr;
      gap: var(--space-16);
      align-items: start;
    }
    .ledger-row {
      padding: var(--space-12) var(--space-16);
      border-bottom: var(--border-width) solid var(--border-subtle);
    }
    .ledger-row--uncited {
      border-left: var(--space-4) solid var(--status-danger);
      background: var(--surface-sunken);
    }
    .claim--uncited {
      text-decoration: line-through;
      color: var(--text-muted);
    }
    .hash-badge {
      font-family: var(--font-mono);
      font-size: var(--text-11);
      color: var(--text-muted);
      background: var(--surface-hover);
      padding: var(--space-2) var(--space-6);
      border-radius: var(--radius-6);
    }
  `;

  constructor() {
    super();
    this.items = [];
  }

  render() {
    return html`
      <link rel="stylesheet" href="/design-system/tokens.css">
      <link rel="stylesheet" href="/design-system/css/stack.css">
      <link rel="stylesheet" href="/design-system/css/text.css">

      <div class="ledger-container">
        <!-- Header -->
        <div class="ledger-grid ledger-row">
          <span class="ds-text-caption-sm ds-text-muted">Cited Claim</span>
          <span class="ds-text-caption-sm ds-text-muted">Evidence Hash</span>
          <span class="ds-text-caption-sm ds-text-muted">Timestamp + Source</span>
        </div>

        <!-- Body -->
        ${this.items.map(item => html`
          <div class="ledger-grid ledger-row ${!item.isCited ? 'ledger-row--uncited' : ''}">
            <div class="${!item.isCited ? 'claim--uncited' : ''}">
              ${item.claim}
            </div>
            <div>
              ${item.hash ? html`<span class="hash-badge">${item.hash.substring(0, 8)}</span>` : html`<span class="ds-text-muted">—</span>`}
            </div>
            <div class="ds-stack ds-stack--sm">
              <span class="ds-text-caption-sm">${item.timestamp}</span>
              <span class="ds-text-caption-sm ds-text-muted">${item.source}</span>
            </div>
          </div>
        `)}
      </div>
    `;
  }
}

customElements.define("ds-evidence-ledger", DsEvidenceLedger);
