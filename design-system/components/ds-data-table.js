import { LitElement, html, css } from "lit";

export class DsDataTable extends LitElement {
  static properties = {
    columns: { attribute: false },
    data: { attribute: false },
    _filterText: { state: true },
    _sortColumn: { state: true },
    _sortAscending: { state: true },
    _selectedRows: { state: true },
  };

  static styles = css`
    :host {
      display: block;
      /* Component custom styles must use tokens only */
      background: var(--surface-card);
      border-radius: var(--radius-8);
      border: var(--border-width) solid var(--border-subtle);
      overflow: hidden;
    }
    .filter-bar {
      padding: var(--space-16);
      border-bottom: var(--border-width) solid var(--border-subtle);
      background: var(--surface-page);
    }
    .actions {
      padding: var(--space-16);
      background: var(--surface-sunken);
      border-bottom: var(--border-width) solid var(--border-subtle);
    }
    tbody tr { cursor: pointer; }
  `;

  constructor() {
    super();
    this.columns = [];
    this.data = [];
    this._filterText = "";
    this._sortColumn = "";
    this._sortAscending = true;
    this._selectedRows = new Set();
  }

  render() {
    const filteredData = this.data.filter(row =>
      Object.values(row).some(val =>
        String(val).toLowerCase().includes(this._filterText.toLowerCase())
      )
    );

    const sortedData = [...filteredData].sort((a, b) => {
      if (!this._sortColumn) return 0;
      const valA = a[this._sortColumn];
      const valB = b[this._sortColumn];
      const modifier = this._sortAscending ? 1 : -1;
      return valA > valB ? modifier : valA < valB ? -modifier : 0;
    });

    return html`
      <!-- Link external design system CSS so utility classes work in Shadow DOM -->
      <link rel="stylesheet" href="/design-system/tokens.css">
      <link rel="stylesheet" href="/design-system/css/button.css">
      <link rel="stylesheet" href="/design-system/css/input.css">
      <link rel="stylesheet" href="/design-system/css/table.css">
      <link rel="stylesheet" href="/design-system/css/stack.css">
      <link rel="stylesheet" href="/design-system/css/badge.css">
      
      <div class="filter-bar ds-stack ds-stack--row ds-stack--between">
        <input 
          class="ds-input" 
          type="text" 
          placeholder="Filter..." 
          .value="${this._filterText}"
          @input="${(e) => this._filterText = e.target.value}"
        >
      </div>

      ${this._selectedRows.size > 0 ? html`
        <div class="actions ds-stack ds-stack--row ds-stack--md">
          <span class="ds-text-muted">${this._selectedRows.size} selected</span>
          <button class="ds-btn ds-btn--primary ds-btn--sm">Bulk Action</button>
        </div>
      ` : ''}

      <div class="ds-table-shell">
        <table class="ds-table">
          <thead>
            <tr>
              <th>
                <input 
                  type="checkbox" 
                  @change="${this._toggleAll}"
                  .checked="${this._selectedRows.size === this.data.length && this.data.length > 0}"
                >
              </th>
              ${this.columns.map(col => html`
                <th 
                  @click="${() => this._handleSort(col.key)}"
                  class="${col.align === 'right' ? 'ds-table-num' : col.align === 'center' ? 'ds-table-center' : ''}"
                  style="cursor: pointer;"
                >
                  ${col.label} ${this._sortColumn === col.key ? (this._sortAscending ? '↑' : '↓') : ''}
                </th>
              `)}
            </tr>
          </thead>
          <tbody>
            ${sortedData.length === 0 ? html`
              <tr>
                <td colspan="${this.columns.length + 1}" class="ds-table-empty">No records found</td>
              </tr>
            ` : sortedData.map(row => html`
              <tr class="${this._selectedRows.has(row.id) ? 'is-selected' : ''}"
                  @click="${(e) => this._handleRowClick(e, row)}">
                <td>
                  <input 
                    type="checkbox" 
                    .checked="${this._selectedRows.has(row.id)}"
                    @change="${() => this._toggleRow(row.id)}"
                  >
                </td>
                ${this.columns.map(col => html`
                  <td class="${col.align === 'right' ? 'ds-table-num' : col.align === 'center' ? 'ds-table-center' : ''}">
                    ${col.type === 'badge' ? html`<span class="ds-badge ds-badge--${row[col.key].variant}">${row[col.key].label}</span>` : row[col.key]}
                  </td>
                `)}
              </tr>
            `)}
          </tbody>
        </table>
      </div>
    `;
  }

  _handleRowClick(e, row) {
    // Selection controls keep their own behavior; row clicks emit for consumers.
    if (e.target.closest("input, button")) return;
    this.dispatchEvent(new CustomEvent("row-click", { detail: { row }, bubbles: true, composed: true }));
  }

  _handleSort(key) {
    if (this._sortColumn === key) {
      this._sortAscending = !this._sortAscending;
    } else {
      this._sortColumn = key;
      this._sortAscending = true;
    }
  }

  _toggleRow(id) {
    const newSet = new Set(this._selectedRows);
    if (newSet.has(id)) newSet.delete(id);
    else newSet.add(id);
    this._selectedRows = newSet;
  }

  _toggleAll() {
    if (this._selectedRows.size === this.data.length) {
      this._selectedRows.clear();
    } else {
      this._selectedRows = new Set(this.data.map(d => d.id));
    }
    this.requestUpdate();
  }
}

customElements.define("ds-data-table", DsDataTable);
