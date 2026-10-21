'use client';

import { api, qs } from './api-client';

/**
 * Typed client for the prospect endpoints.
 *
 * The page this replaces made nineteen inline `fetch()` calls with no client
 * layer, five of which pointed at CRM endpoints (contacts, deals) that this
 * product does not have. Conversion in particular used to be orchestrated
 * from the browser — create a contact, then patch the prospect — which could
 * leave an orphaned contact if the second call failed. It is one transactional
 * endpoint now.
 */

export type ProspectStatus =
  | 'new' | 'researching' | 'qualified' | 'contacted' | 'converted' | 'disqualified';

export type ProspectSource =
  | 'linkedin' | 'website' | 'referral' | 'event' | 'manual' | 'import';

export interface Prospect {
  prospectId: string;
  orgId: string;
  name: string;
  email?: string;
  phone?: string;
  company?: string;
  title?: string;
  linkedinUrl?: string;
  website?: string;
  avatar?: string;
  source: ProspectSource;
  status: ProspectStatus;
  score: number;
  notes?: string;
  tags?: string[];
  enrichmentSources?: Record<string, string>;
  lastActivityDate?: string;
  contactedAt?: string;
  convertedContactId?: string;
  ownerId: string;
  ownerName: string;
  createdAt: string;
  updatedAt: string;
}

export interface ListParams {
  status?: string[];
  source?: string;
  ownerId?: string;
  search?: string;
  /** Campaign tag — narrows the list to one campaign's prospects. */
  tag?: string;
  limit?: number;
  cursor?: string | null;
  stats?: boolean;
}

export interface Campaign {
  name: string;
  count: number;
}

export interface ListResponse {
  success: true;
  prospects: Prospect[];
  count: number;
  nextCursor: string | null;
  hasMore: boolean;
  stats?: Record<string, number>;
  campaigns?: Campaign[];
}

export interface ImportRow {
  name: string;
  email?: string;
  phone?: string;
  company?: string;
  title?: string;
  linkedinUrl?: string;
  website?: string;
  notes?: string;
  tags?: string[];
  source?: string;
  score?: number;
}

export interface ImportResult {
  batchId: string;
  created: number;
  failed: number;
  skipped: number;
  errors: string[];
  duplicates: string[];
  prospects: Array<{ prospectId: string; name: string }>;
}

export const prospectsApi = {
  list: (params: ListParams = {}) =>
    api.get<ListResponse>(
      `/api/prospects${qs({
        status: params.status,
        source: params.source,
        ownerId: params.ownerId,
        search: params.search,
        tag: params.tag,
        limit: params.limit,
        cursor: params.cursor,
        stats: params.stats,
      })}`,
    ),

  get: (id: string) => api.get<{ prospect: Prospect }>(`/api/prospects/${encodeURIComponent(id)}`),

  create: (input: Partial<Prospect> & { name: string }) =>
    api.post<{ prospect: Prospect }>('/api/prospects', input),

  update: (id: string, updates: Partial<Prospect>) =>
    api.patch<{ prospect: Prospect }>(`/api/prospects/${encodeURIComponent(id)}`, updates),

  remove: (id: string) => api.delete<{ message: string }>(`/api/prospects/${encodeURIComponent(id)}`),

  /** One transactional call — creates the contact and flips the prospect together. */
  convert: (id: string) =>
    api.post<{ contact: { contactId: string; name: string; score: number } }>(
      `/api/prospects/${encodeURIComponent(id)}/convert`,
    ),

  bulkUpdate: (prospectIds: string[], updates: Partial<Prospect>) =>
    api.patch<{ updated: number }>('/api/prospects/bulk', { prospectIds, updates }),

  bulkDelete: (prospectIds: string[]) =>
    api.delete<{ deleted: number }>('/api/prospects/bulk', { prospectIds }),

  checkDuplicates: (target: { name?: string; email?: string; phone?: string; company?: string }) =>
    api.post<{ duplicates: Array<{ prospectId: string; name: string; matchType: string; confidence: number }>; hasDuplicates: boolean }>(
      '/api/prospects/duplicates',
      target,
    ),

  /** Small batches complete inline; large ones return 202 with a batchId. */
  import: (prospects: ImportRow[], filename?: string) =>
    api.post<ImportResult & { batchId: string; status?: string }>('/api/prospects/import', {
      prospects,
      filename,
    }),

  importHistory: () =>
    api.get<{
      history: Array<{
        batchId: string; timestamp: string; filename?: string;
        importedCount: number; failedCount: number; skippedCount: number;
        status: string; undone: boolean; canUndo: boolean;
      }>;
    }>('/api/prospects/import-history'),

  undoImport: (batchId: string) =>
    api.post<{ deleted: number; message: string }>('/api/prospects/import-history', { batchId }),

  enrichmentSources: (id: string) =>
    api.get<{ sources: Record<string, string> }>(
      `/api/prospects/${encodeURIComponent(id)}/enrichment-sources`,
    ),

  enrich: (prospects: Array<{ prospectId: string; name: string } & Partial<Prospect>>) =>
    api.post<{
      results: Array<{
        prospectId: string; enrichedFields: string[];
        data: Record<string, string>; enrichmentSources?: Record<string, string>;
      }>;
      totalEnriched: number;
    }>('/api/prospects/enrich', { prospects }),
};

export interface FindLeadsJob {
  jobId: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  phase: number;
  phaseLabel: string;
  percentComplete: number;
  partialLeads: Array<Record<string, unknown>>;
  searchesRun: string[];
  summary?: string;
  metadata?: Record<string, unknown>;
  errorCode?: string;
  errorMessage?: string;
  estimatedSeconds: number;
}

export const findLeadsApi = {
  start: (request: {
    mode: 'filters' | 'ai';
    prompt?: string;
    jobTitles?: string;
    industries?: string[];
    locations?: string;
    searchDepth?: 'quick' | 'deep';
    sources?: string[];
    excludeNames?: string[];
    excludeUrls?: string[];
    offset?: number;
  }) => api.post<{ jobId: string; status: string; estimatedSeconds: number }>(
    '/api/prospects/find-leads',
    request,
  ),

  poll: (jobId: string) =>
    api.get<{ job: FindLeadsJob }>(`/api/prospects/find-leads/${encodeURIComponent(jobId)}`),

  cancel: (jobId: string) =>
    api.patch<{ cancelled: boolean; alreadyFinal: boolean }>(
      `/api/prospects/find-leads/${encodeURIComponent(jobId)}`,
      { action: 'cancel' },
    ),
};
