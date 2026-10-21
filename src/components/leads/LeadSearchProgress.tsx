'use client';

// ============================================
// LeadSearchProgress
// Engaging progress view for the AI Lead Finder async pipeline.
// Renders:
//   - The 8-phase step indicator (current phase highlighted, prior steps
//     checked).
//   - A progress bar tied to `percentComplete`.
//   - A live ETA countdown derived from `estimatedSeconds` + createdAt.
//   - A rotating "Looking for …" ticker driven by `searchesRun`.
//   - Lead cards sliding in from below as `partialLeads` grows.
// User-facing copy only — never surfaces SerpAPI/Bedrock/BrightData names.
// ============================================

import { motion, AnimatePresence } from 'framer-motion';
import { Sparkle, CheckCircle, Buildings, EnvelopeSimple, LinkedinLogo } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';

const PHASE_LABELS = [
  'Understanding your request',
  'Searching across the web',
  'Reading the most relevant pages',
  'Identifying promising leads',
  'Checking Crunchbase, GitHub and Apollo',
  'Enriching profiles and avatars',
  'Finding verified email addresses',
  'Finalising your list',
];

interface PartialLeadLike {
  name: string;
  title?: string;
  company?: string;
  avatar?: string;
  email?: string;
  linkedinUrl?: string;
  score?: number;
}

interface LeadSearchProgressProps {
  isDark: boolean;
  phase: number;
  phaseLabel: string;
  percentComplete: number;
  estimatedSeconds: number;
  elapsedSeconds: number;
  searchesRun: string[];
  partialLeads: PartialLeadLike[];
  stalled?: boolean;
  onCancel?: () => void;
}

function formatRemaining(estSec: number, elapsedSec: number): string {
  const remaining = Math.max(0, estSec - elapsedSec);
  if (remaining === 0) return 'Almost done…';
  if (remaining < 60) return `about ${remaining}s left`;
  const mins = Math.ceil(remaining / 60);
  return `about ${mins} min left`;
}

export function LeadSearchProgress({
  isDark,
  phase,
  phaseLabel,
  percentComplete,
  estimatedSeconds,
  elapsedSeconds,
  searchesRun,
  partialLeads,
  stalled,
  onCancel,
}: LeadSearchProgressProps) {
  // Rotate through the queries every 2.5s — purely cosmetic, driven off
  // elapsedSeconds so no extra setInterval needed in the child.
  const tickerIndex = searchesRun.length > 0
    ? Math.floor(elapsedSeconds / 2.5) % searchesRun.length
    : -1;
  const tickerText = tickerIndex >= 0 ? searchesRun[tickerIndex] : null;

  return (
    <div className={cn('flex flex-col gap-6 p-6 rounded-xl', isDark ? 'bg-black/20' : 'bg-gray-50/50')}>
      {/* Header with sparkle + phase label + ETA */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <motion.div
            animate={{ rotate: [0, 10, -10, 0], scale: [1, 1.1, 1] }}
            transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
            className="flex-shrink-0 mt-0.5"
          >
            <Sparkle size={28} weight="fill" className="text-primary" />
          </motion.div>
          <div className="flex-1">
            <div className="text-lg font-semibold">
              {stalled ? 'Still working…' : phaseLabel || 'Getting ready…'}
            </div>
            <div className={cn('text-sm mt-0.5', isDark ? 'text-white/60' : 'text-muted-foreground')}>
              {formatRemaining(estimatedSeconds, elapsedSeconds)}
              {partialLeads.length > 0 && ` · ${partialLeads.length} lead${partialLeads.length === 1 ? '' : 's'} found so far`}
            </div>
          </div>
        </div>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className={cn(
              'text-xs font-medium px-3 py-1.5 rounded-lg transition-colors',
              isDark
                ? 'text-white/60 hover:text-white hover:bg-white/10'
                : 'text-muted-foreground hover:text-foreground hover:bg-gray-100',
            )}
          >
            Cancel
          </button>
        )}
      </div>

      {/* Progress bar */}
      <div className={cn('h-2 rounded-full overflow-hidden', isDark ? 'bg-white/10' : 'bg-gray-200')}>
        <motion.div
          className="h-full bg-gradient-to-r from-primary to-orange-400"
          initial={{ width: 0 }}
          animate={{ width: `${Math.max(2, percentComplete)}%` }}
          transition={{ duration: 0.8, ease: 'easeOut' }}
        />
      </div>

      {/* Step indicator (8 phases) */}
      <div className="grid grid-cols-4 gap-2 md:grid-cols-8">
        {PHASE_LABELS.map((label, idx) => {
          const stepNum = idx + 1;
          const isDone = stepNum < phase;
          const isActive = stepNum === phase;
          return (
            <div
              key={stepNum}
              className={cn(
                'flex flex-col items-center gap-1.5 text-center',
                !isDone && !isActive && 'opacity-40',
              )}
              title={label}
            >
              <div
                className={cn(
                  'w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-semibold transition-all',
                  isDone && 'bg-primary text-white',
                  isActive && 'bg-primary/20 text-primary ring-2 ring-primary',
                  !isDone && !isActive && (isDark ? 'bg-white/10 text-white/60' : 'bg-gray-200 text-gray-500'),
                )}
              >
                {isDone ? <CheckCircle size={14} weight="fill" /> : stepNum}
              </div>
              <div
                className={cn(
                  'text-[10px] leading-tight line-clamp-2',
                  isActive && 'font-medium',
                  isDark ? 'text-white/70' : 'text-muted-foreground',
                )}
              >
                {label}
              </div>
            </div>
          );
        })}
      </div>

      {/* Rotating ticker — "Looking for ..." */}
      {tickerText && (
        <div
          className={cn(
            'text-sm px-4 py-2 rounded-lg border',
            isDark ? 'bg-white/5 border-white/10 text-white/70' : 'bg-white border-border text-muted-foreground',
          )}
        >
          <AnimatePresence mode="wait">
            <motion.div
              key={tickerIndex}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.25 }}
              className="flex items-center gap-2"
            >
              <span className="text-primary">→</span>
              <span className="truncate">Looking for &quot;{tickerText}&quot;</span>
            </motion.div>
          </AnimatePresence>
        </div>
      )}

      {/* Streaming leads preview */}
      {partialLeads.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className={cn('text-xs font-medium uppercase tracking-wide', isDark ? 'text-white/50' : 'text-muted-foreground')}>
            Found so far
          </div>
          <div className="flex flex-col gap-1.5 max-h-[240px] overflow-y-auto pr-1">
            <AnimatePresence initial={false}>
              {partialLeads.slice(0, 12).map((lead, idx) => (
                <motion.div
                  key={`${lead.name}-${idx}`}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.3, delay: Math.min(idx * 0.03, 0.3) }}
                  className={cn(
                    'flex items-center gap-3 px-3 py-2 rounded-lg border',
                    isDark ? 'bg-white/5 border-white/10' : 'bg-white border-border',
                  )}
                >
                  <div
                    className={cn(
                      'w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold flex-shrink-0',
                      isDark ? 'bg-white/10 text-white/80' : 'bg-primary/10 text-primary',
                    )}
                  >
                    {lead.avatar ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={lead.avatar} alt="" className="w-full h-full rounded-full object-cover" />
                    ) : (
                      lead.name?.slice(0, 2).toUpperCase() || '??'
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{lead.name}</div>
                    <div className={cn('text-xs truncate', isDark ? 'text-white/50' : 'text-muted-foreground')}>
                      {lead.title}
                      {lead.company && (
                        <>
                          {' · '}
                          <span className="inline-flex items-center gap-1">
                            <Buildings size={10} />
                            {lead.company}
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    {lead.email && (
                      <span title="Email found"><EnvelopeSimple size={14} className="text-green-500" /></span>
                    )}
                    {lead.linkedinUrl && (
                      <span title="LinkedIn"><LinkedinLogo size={14} className="text-blue-500" /></span>
                    )}
                  </div>
                </motion.div>
              ))}
            </AnimatePresence>
            {partialLeads.length > 12 && (
              <div className={cn('text-xs text-center py-1', isDark ? 'text-white/40' : 'text-muted-foreground')}>
                +{partialLeads.length - 12} more
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
