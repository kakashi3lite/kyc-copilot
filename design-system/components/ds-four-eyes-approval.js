import { LitElement, html, css } from "lit";

export class DsFourEyesApproval extends LitElement {
  static properties = {
    stage: { type: String },
    reviewerName: { type: String },
    reviewerDecision: { type: String },
    reviewerNotes: { type: String },
    evidenceReliedOn: { attribute: false },
  };

  static styles = css`
    :host {
      display: block;
      background: var(--surface-card);
      border: var(--border-width) solid var(--border-subtle);
      border-radius: var(--radius-8);
      padding: var(--space-24);
    }
    .layout-grid {
      display: grid;
      gap: var(--space-24);
    }
    .section {
      display: flex;
      flex-direction: column;
      gap: var(--space-12);
    }
    .section-header {
      border-bottom: var(--border-width) solid var(--border-subtle);
      padding-bottom: var(--space-8);
      margin-bottom: var(--space-8);
    }
    .read-only-panel {
      background: var(--surface-sunken);
      border-radius: var(--radius-6);
      padding: var(--space-16);
      border: var(--border-width) solid var(--border-subtle);
    }
    .actions {
      display: flex;
      justify-content: flex-end;
      gap: var(--space-12);
      margin-top: var(--space-16);
      padding-top: var(--space-16);
      border-top: var(--border-width) solid var(--border-subtle);
    }
    .evidence-list {
      margin: 0;
      padding-left: var(--space-20);
      color: var(--text-muted);
    }
  `;

  constructor() {
    super();
    this.stage = "reviewer";
    this.reviewerName = "Jane Doe";
    this.reviewerDecision = "pending";
    this.reviewerNotes = "";
    this.evidenceReliedOn = [];
  }

  render() {
    return html`
      <link rel="stylesheet" href="/design-system/tokens.css">
      <link rel="stylesheet" href="/design-system/css/button.css">
      <link rel="stylesheet" href="/design-system/css/input.css">
      <link rel="stylesheet" href="/design-system/css/text.css">
      <link rel="stylesheet" href="/design-system/css/badge.css">
      <link rel="stylesheet" href="/design-system/css/stack.css">

      <div class="layout-grid">
        <div class="section-header ds-stack ds-stack--row ds-stack--between">
          <h2 class="ds-text-heading-xl">Four Eyes Approval</h2>
          <span class="ds-badge ds-badge--neutral">Stage: ${this.stage === 'reviewer' ? '1st Review' : '2nd Approval'}</span>
        </div>

        ${this.stage === 'reviewer' ? this._renderReviewerPath() : this._renderApproverPath()}
      </div>
    `;
  }

  _renderReviewerPath() {
    return html`
      <div class="section">
        <span class="ds-text-body-md">Reviewer Assessment</span>
        <textarea class="ds-input" rows="4" placeholder="Enter findings and rationale..."></textarea>
      </div>
      <div class="actions">
        <button class="ds-btn ds-btn--secondary">Reject Case</button>
        <button class="ds-btn ds-btn--primary">Recommend Approval</button>
      </div>
    `;
  }

  _renderApproverPath() {
    return html`
      <div class="section">
        <span class="ds-text-body-md">1st Reviewer Decision</span>
        <div class="read-only-panel ds-stack ds-stack--md">
          <div class="ds-stack ds-stack--row ds-stack--between">
            <span class="ds-text-caption-sm ds-text-muted">Reviewer: ${this.reviewerName}</span>
            <span class="ds-badge ${this.reviewerDecision === 'approve' ? 'ds-badge--success' : this.reviewerDecision === 'flag' ? 'ds-badge--warning' : 'ds-badge--danger'}">
              ${this.reviewerDecision === 'approve' ? 'Recommended Approval' : this.reviewerDecision === 'flag' ? 'Flagged — Routed to Human Review' : 'Recommended Rejection'}
            </span>
          </div>
          <p class="ds-text-body-md">${this.reviewerNotes || html`<span class="ds-text-muted">No notes provided.</span>`}</p>
          
          <div class="ds-stack ds-stack--sm">
            <span class="ds-text-caption-sm ds-text-muted">Evidence Relied On:</span>
            <ul class="evidence-list ds-text-caption-sm">
              ${this.evidenceReliedOn.length > 0 
                ? this.evidenceReliedOn.map(ev => html`<li>${ev}</li>`)
                : html`<li>None specified</li>`
              }
            </ul>
          </div>
        </div>
      </div>

      <div class="section">
        <span class="ds-text-body-md">Final Approver Assessment</span>
        <textarea class="ds-input" rows="4" placeholder="Enter final authorization notes..."></textarea>
      </div>
      <div class="actions">
        <button class="ds-btn ds-btn--secondary">Veto & Reject</button>
        <button class="ds-btn ds-btn--primary"
          @click="${() => this.dispatchEvent(new CustomEvent('approve', { bubbles: true, composed: true }))}">Final Approve</button>
      </div>
    `;
  }
}

customElements.define("ds-four-eyes-approval", DsFourEyesApproval);
