import { LitElement, html, css } from "lit";

/**
 * @typedef {{ id: string, label: string, status: 'pending'|'in-progress'|'done'|'error', duration?: string, model?: string }} TimelineStep
 */

export class DsCaseTimeline extends LitElement {
  static properties = {
    steps: { attribute: false },
  };

  static styles = css`
    :host {
      display: block;
    }
    .timeline {
      display: flex;
      flex-direction: column;
      gap: 0; /* managed by step internals for the connecting line */
    }
    .step {
      display: flex;
      gap: var(--space-16);
      position: relative;
      padding-bottom: var(--space-24);
    }
    .step:last-child {
      padding-bottom: 0;
    }
    /* Vertical connecting line */
    .step:not(:last-child)::before {
      content: '';
      position: absolute;
      left: calc(var(--space-12) - var(--border-width)); /* Center of a 24px icon (12px - 1px) */
      top: var(--space-24);
      bottom: 0;
      width: var(--border-width);
      background: var(--border-subtle);
    }
    .step-indicator {
      width: var(--space-24);
      height: var(--space-24);
      border-radius: var(--radius-full);
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--surface-card);
      border: var(--border-width) solid var(--border-strong);
      z-index: 1; /* float above line */
    }
    .step--done .step-indicator {
      background: var(--status-positive);
      border-color: var(--status-positive);
      color: var(--color-white);
    }
    .step--in-progress .step-indicator {
      border-color: var(--action-primary);
      border-width: var(--focus-ring-width); /* focus-ring stroke token */
    }
    .step--error .step-indicator {
      background: var(--status-danger);
      border-color: var(--status-danger);
    }
    .step-content {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: var(--space-4);
      padding-top: var(--space-2);
    }
    .step-meta {
      display: flex;
      gap: var(--space-12);
    }
  `;

  constructor() {
    super();
    this.steps = [];
  }

  render() {
    return html`
      <link rel="stylesheet" href="/design-system/tokens.css">
      <link rel="stylesheet" href="/design-system/css/text.css">
      <link rel="stylesheet" href="/design-system/css/badge.css">
      <link rel="stylesheet" href="/design-system/css/stack.css">

      <div class="timeline">
        ${this.steps.map(step => html`
          <div class="step step--${step.status}">
            <div class="step-indicator">
              ${step.status === 'done' ? '✓' : ''}
              ${step.status === 'error' ? '!' : ''}
            </div>
            <div class="step-content">
              <div class="ds-text-body-md ${step.status === 'pending' ? 'ds-text-muted' : ''}">
                ${step.label}
              </div>
              <div class="step-meta">
                ${step.duration ? html`<span class="ds-text-caption-sm ds-text-muted">${step.duration}</span>` : ''}
                ${step.model ? html`<span class="ds-badge ds-badge--neutral">${step.model}</span>` : ''}
              </div>
            </div>
          </div>
        `)}
      </div>
    `;
  }
}

customElements.define("ds-case-timeline", DsCaseTimeline);
