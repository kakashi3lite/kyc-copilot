import { LitElement, html, css } from "lit";
import './ds-evidence-ledger.js';

/**
 * @typedef {{ id: string, claim: string, hash: string, timestamp: string, source: string, isCited: boolean }} DossierClaim
 */

export class DsDossierViewer extends LitElement {
  static properties = {
    entityName: { type: String },
    signature: { type: String },
    isSignatureValid: { type: Boolean },
    claims: { attribute: false },
  };

  static styles = css`
    :host {
      display: block;
      background: var(--surface-card);
      border: var(--border-width) solid var(--border-subtle);
      border-radius: var(--radius-8);
      overflow: hidden;
    }
    .header {
      display: grid;
      grid-template-columns: 2fr 1fr 1fr;
      gap: var(--space-16);
      align-items: center;
      padding: var(--space-24);
      border-bottom: var(--border-width) solid var(--border-subtle);
      background: var(--surface-page);
    }
    .header-col {
      display: flex;
      flex-direction: column;
      gap: var(--space-4);
    }
    .header-col--right {
      align-items: flex-end;
      text-align: right;
    }
    .signature-wrap {
      display: inline-flex;
      align-items: center;
      gap: var(--space-8);
      padding: var(--space-4) var(--space-8);
      background: var(--surface-sunken);
      border-radius: var(--radius-6);
      border: var(--border-width) solid var(--border-subtle);
    }
    .signature-hash {
      font-family: var(--font-mono);
      font-size: var(--text-12);
      color: var(--text-muted);
    }
    .body {
      padding: var(--space-24);
    }
  `;

  constructor() {
    super();
    this.entityName = "";
    this.signature = "";
    this.isSignatureValid = true;
    this.claims = [];
  }

  render() {
    return html`
      <link rel="stylesheet" href="/design-system/tokens.css">
      <link rel="stylesheet" href="/design-system/css/text.css">
      <link rel="stylesheet" href="/design-system/css/badge.css">

      <div class="header">
        <div class="header-col">
          <span class="ds-text-heading-xl">${this.entityName}</span>
          <span class="ds-text-caption-sm ds-text-muted">Entity Dossier</span>
        </div>
        
        <div class="header-col">
          <!-- Center column for alignment with evidence ledger if desired, or meta -->
        </div>

        <div class="header-col header-col--right">
          <span class="ds-text-caption-sm ds-text-muted">HMAC-SHA256 Signature</span>
          <div class="signature-wrap">
            <span class="signature-hash">${this.signature.substring(0, 16)}...</span>
            <span class="ds-badge ${this.isSignatureValid ? 'ds-badge--success' : this.signature.startsWith('unsigned') ? 'ds-badge--warning' : 'ds-badge--danger'}">
              ${this.isSignatureValid ? 'Valid' : this.signature.startsWith('unsigned') ? 'Unsigned' : 'Invalid'}
            </span>
          </div>
        </div>
      </div>

      <div class="body">
        <ds-evidence-ledger .items="${this.claims}"></ds-evidence-ledger>
      </div>
    `;
  }
}

customElements.define("ds-dossier-viewer", DsDossierViewer);
