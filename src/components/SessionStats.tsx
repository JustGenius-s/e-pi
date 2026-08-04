import type { ContextUsageState, SessionUsageState } from "../types/contracts";
import { formatTokens } from "../lib/format";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "./ui/hover-card";

interface SessionStatsProps {
  context?: ContextUsageState;
  usage: SessionUsageState;
  cacheHitRate?: number;
}

/**
 * Context usage ring with a hover details card (tokens, cache, cost).
 * Rendered left of the Send button in the composer toolbar.
 */
export function SessionStats({ context, usage, cacheHitRate }: SessionStatsProps) {
  const totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  const hasCache = usage.cacheRead > 0 || usage.cacheWrite > 0;
  const percent = context?.percent ?? null;
  const filled = percent != null ? Math.min(100, Math.max(0, percent)) : 0;
  const tone =
    percent != null && percent > 90
      ? "danger"
      : percent != null && percent > 75
        ? "warn"
        : undefined;
  const ringRadius = 9;
  const ringCircumference = 2 * Math.PI * ringRadius;
  return (
    <HoverCard openDelay={150} closeDelay={100}>
      <HoverCardTrigger asChild>
        <div className="context-indicator" tabIndex={0} aria-label="Context usage">
          <svg
            className="context-ring"
            data-tone={tone}
            data-unknown={percent == null ? "true" : undefined}
            viewBox="0 0 22 22"
            width={20}
            height={20}
            aria-hidden="true"
          >
            <circle className="context-ring-track" cx="11" cy="11" r={ringRadius} />
            <circle
              className="context-ring-fill"
              cx="11"
              cy="11"
              r={ringRadius}
              strokeDasharray={`${(filled / 100) * ringCircumference} ${ringCircumference}`}
              transform="rotate(-90 11 11)"
            />
          </svg>
        </div>
      </HoverCardTrigger>
      <HoverCardContent className="context-card" align="end" sideOffset={10}>
        <div className="context-card-head">
          <span>Context</span>
          <strong data-tone={tone}>{percent != null ? `${percent.toFixed(1)}%` : "Unknown"}</strong>
        </div>
        <div className="context-card-bar">
          <div className="context-card-bar-fill" data-tone={tone} style={{ width: `${filled}%` }} />
        </div>
        <div className="context-card-meta">
          {context
            ? `${formatTokens(context.tokens ?? 0)} / ${formatTokens(context.contextWindow)} tokens`
            : "Waiting for the first response…"}
        </div>
        <div className="context-card-divider" />
        <dl className="context-card-rows">
          <div>
            <dt>Tokens</dt>
            <dd>{formatTokens(totalTokens)}</dd>
          </div>
          <div>
            <dt>Input</dt>
            <dd>{formatTokens(usage.input)}</dd>
          </div>
          <div>
            <dt>Output</dt>
            <dd>{formatTokens(usage.output)}</dd>
          </div>
          <div>
            <dt>Cache read</dt>
            <dd>{formatTokens(usage.cacheRead)}</dd>
          </div>
          <div>
            <dt>Cache write</dt>
            <dd>{formatTokens(usage.cacheWrite)}</dd>
          </div>
          <div>
            <dt>Cache hit</dt>
            <dd>{cacheHitRate != null && hasCache ? `${cacheHitRate.toFixed(1)}%` : "—"}</dd>
          </div>
          <div>
            <dt>Cost</dt>
            <dd>${usage.cost.toFixed(3)}</dd>
          </div>
        </dl>
      </HoverCardContent>
    </HoverCard>
  );
}
