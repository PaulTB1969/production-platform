// Row <-> API object mapping. The API speaks the same camelCase shapes the
// artifacts used, so the screens port over with few changes.

const iso = (v) => (v instanceof Date ? v.toISOString() : v ?? null);

export function entryFromRow(r, usage = []) {
  return {
    id: r.id,
    sku: r.sku,
    line: r.line,
    date: r.date,
    plannedCases: r.planned_cases,
    actualCases: r.actual_cases,
    wastageCases: r.wastage_cases,
    status: r.status,
    groupId: r.group_id,
    seq: r.seq,
    runOrder: r.run_order ?? null,
    startTime: r.start_time,
    endTime: r.end_time,
    notes: r.notes,
    exportedAt: iso(r.exported_at),
    unleashedNumber: r.unleashed_number ?? null,
    unleashedGuid: r.unleashed_guid ?? null,
    sendStartedAt: iso(r.send_started_at),
    sendError: r.send_error ?? null,
    trackingError: r.tracking_error ?? null,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    componentUsage: usage.map((u) => ({
      componentSku: u.component_sku,
      batchNumber: u.batch_number,
      qtyUsed: u.qty_used,
      wastage: u.wastage,
    })),
  };
}

export function requisitionFromRow(r, lines = []) {
  return {
    id: r.id,
    date: r.date,
    line: r.line,
    seq: r.seq ?? 1,
    status: r.status,
    transferNumber: r.transfer_number,
    exportedAt: iso(r.exported_at),
    unleashedGuid: r.unleashed_guid ?? null,
    sendStartedAt: iso(r.send_started_at),
    sendError: r.send_error ?? null,
    generatedAt: iso(r.generated_at),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    lines: lines.map((l) => ({
      sku: l.sku,
      description: l.description,
      batchNumber: l.batch_number,
      qtyUsed: l.qty_used,
      needsBatch: l.needs_batch,
      group: l.group_name ?? null,
    })),
  };
}

export function recipeFromRows(r, lines = []) {
  return {
    sku: r.sku,
    description: r.description,
    autoAssignOldestBatch: r.auto_assign_oldest_batch,
    batchTracked: r.is_batch_tracked ?? null,
    expectedDuration: r.expected_duration,
    syncedAt: iso(r.synced_at),
    lines: lines.map((l) => ({
      componentSku: l.component_sku,
      componentDescription: l.component_description,
      qtyPerUnit: l.qty_per_unit,
      wastageQty: l.wastage_qty,
      isBatchTracked: l.is_batch_tracked,
    })),
  };
}

export function groupBy(rows, key) {
  const m = new Map();
  for (const r of rows) {
    const k = r[key];
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
}

// Thrown for anything the user can fix; routes turn it into a 4xx.
export class UserError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
