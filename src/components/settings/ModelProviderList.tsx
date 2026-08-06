import { CircleCheck, LoaderCircle } from "lucide-react";

import type { ModelProviderRecord } from "../../types/contracts";

interface ModelProviderListProps {
  providers: ModelProviderRecord[];
  selectedProviderId?: string;
  query: string;
  loading: boolean;
  onSelect: (providerId: string) => void;
}

export function ModelProviderList({ providers, selectedProviderId, query, loading, onSelect }: ModelProviderListProps) {
  const normalized = query.trim().toLowerCase();
  const filtered = normalized
    ? providers.filter((provider) => `${provider.name} ${provider.id}`.toLowerCase().includes(normalized))
    : providers;
  return (
    <aside className="model-provider-pane">
      <div className="model-provider-list">
        {loading ? (
          <div className="model-settings-loading">
            <LoaderCircle className="spin" size={15} /> Loading providers
          </div>
        ) : filtered.length === 0 ? (
          <div className="model-settings-empty">No providers found</div>
        ) : (
          filtered.map((provider) => (
            <button
              className="model-provider-row"
              data-active={provider.id === selectedProviderId}
              key={provider.id}
              onClick={() => onSelect(provider.id)}
              type="button"
            >
              <span>{provider.name}</span>
              {provider.configured ? <CircleCheck size={14} aria-label="Configured" /> : null}
              <small>{provider.models.length} models</small>
            </button>
          ))
        )}
      </div>
    </aside>
  );
}
