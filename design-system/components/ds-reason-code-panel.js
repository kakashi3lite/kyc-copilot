import { LitElement, html, css } from "lit";

export class DsReasonCodePanel extends LitElement {
  static properties = {
    matchField: { type: String },
    watchlist: { type: String },
    confidence: { type: Number },
    isResolved: { type: Boolean },
    _feedback: { state: true },
  };

  static styles = css`
    :host {
      display: block;
      background: var(--surface-card);
      border: var(--border-width) solid var(--border-subtle);
      border-radius: var(--radius-8);
      padding: var(--space-24);
    }
    .panel-header {
      border-bottom: var(--border-width) solid var(--border-subtle);
      padding-bottom: var(--space-16);
      margin-bottom: var(--space-16);
    }
    .data-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: var(--space-16);
      margin-bottom: var(--space-24);
    }
    .data-item {
      display: flex;
      flex-direction: column;
      gap: var(--space-4);
    }
    .controls-area {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-top: var(--space-16);
      border-top: var(--border-width) solid var(--border-subtle);
    }
    .feedback-group {
      display: flex;
      gap: var(--space-8);
    }
    .confidence-high { color: var(--status-danger); }
    .confidence-med { color: var(--status-warning); }
  `;

  constructor() {
    super();
    this.matchField = "";
    this.watchlist = "";
    this.confidence = 0;
    this.isResolved = false;
    this._feedback = null;
  }

  render() {
    return html`
      <link rel="stylesheet" href="/design-system/tokens.css">
      <link rel="stylesheet" href="/design-system/css/button.css">
      <link rel="stylesheet" href="/design-system/css/text.css">
      <link rel="stylesheet" href="/design-system/css/badge.css">
      <link rel="stylesheet" href="/design-system/css/stack.css">

      <div class="panel-header ds-stack ds-stack--row ds-stack--between">
        <h3 class="ds-text-heading-xl">Match Reason Code</h3>
        <span class="ds-badge ds-badge--danger">High Risk Trigger</span>
      </div>

      <div class="data-grid">
        <div class="data-item">
          <span class="ds-text-caption-sm ds-text-muted">Matched Field</span>
          <span class="ds-text-body-md">${this.matchField}</span>
        </div>
        <div class="data-item">
          <span class="ds-text-caption-sm ds-text-muted">Watchlist / Scenario</span>
          <span class="ds-text-body-md">${this.watchlist}</span>
        </div>
        ${this.confidence > 0 ? html`
        <div class="data-item">
          <span class="ds-text-caption-sm ds-text-muted">Confidence Context</span>
          <span class="ds-text-body-md ${this.confidence > 90 ? 'confidence-high' : 'confidence-med'}">
            ${this.confidence}% Match
          </span>
        </div>` : ''}
      </div>

      <div class="controls-area">
        <div class="feedback-group">
          <span class="ds-text-caption-sm ds-text-muted" style="align-self: center; margin-right: var(--space-8);">Feedback:</span>
          <button 
            class="ds-btn ds-btn--sm ${this._feedback === 'false-positive' ? 'is-selected' : 'ds-btn--ghost'}"
            @click="${() => this._setFeedback('false-positive')}"
          >False Positive</button>
          <button 
            class="ds-btn ds-btn--sm ${this._feedback === 'true-positive' ? 'is-selected' : 'ds-btn--ghost'}"
            @click="${() => this._setFeedback('true-positive')}"
          >True Positive</button>
        </div>

        <div class="feedback-group">
          <button class="ds-btn ds-btn--secondary" ?disabled="${this.isResolved}">Reject</button>
          <button class="ds-btn ds-btn--primary" ?disabled="${this.isResolved}"
            @click="${() => this.dispatchEvent(new CustomEvent('reason-approve', { bubbles: true, composed: true, detail: { feedback: this._feedback } }))}">Approve</button>
        </div>
      </div>
    `;
  }

  _setFeedback(val) {
    this._feedback = val;
  }
}

customElements.define("ds-reason-code-panel", DsReasonCodePanel);
