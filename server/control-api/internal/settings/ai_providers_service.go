package settings

import (
	"context"
	"errors"
	"strings"

	"github.com/ai-interviewer/ai-powered/control-api/internal/audit"
	"github.com/ai-interviewer/ai-powered/control-api/internal/users"
	"github.com/jackc/pgx/v5"
)

func (s *Service) ListAIProviders(ctx context.Context) ([]PublicAIProvider, error) {
	store := NewStore(s.db, s.box)
	records, err := store.ListAIProviders(ctx)
	if err != nil {
		return nil, err
	}
	public := make([]PublicAIProvider, 0, len(records))
	for _, record := range records {
		_, decryptErr := store.DecryptAPIKey(record)
		public = append(public, record.publicProvider(decryptErr))
	}
	return public, nil
}

func (s *Service) GetAIProvider(ctx context.Context, id string) (PublicAIProvider, error) {
	store := NewStore(s.db, s.box)
	record, err := store.GetAIByID(ctx, id)
	if err != nil {
		return PublicAIProvider{}, err
	}
	_, decryptErr := store.DecryptAPIKey(record)
	return record.publicProvider(decryptErr), nil
}

func (s *Service) GetClientAIByProviderID(ctx context.Context, id string) (ClientAI, error) {
	store := NewStore(s.db, s.box)
	record, err := store.GetAIByID(ctx, id)
	if err != nil {
		return ClientAI{}, err
	}
	apiKey, decryptErr := store.DecryptAPIKey(record)
	public := PublicAIFrom(record, decryptErr)
	if decryptErr != nil {
		return ClientAI{PublicAI: public}, decryptErr
	}
	return ClientAI{PublicAI: public, APIKey: apiKey}, nil
}

func (s *Service) CreateAIProvider(ctx context.Context, actor users.User, requestID string, input AIProviderInput) (PublicAIProvider, error) {
	var public PublicAIProvider
	err := pgx.BeginFunc(ctx, s.db, func(tx pgx.Tx) error {
		store := NewStore(tx, s.box)
		record, err := store.CreateAIProvider(ctx, actor, input)
		if err != nil {
			return err
		}
		_, decryptErr := store.DecryptAPIKey(record)
		public = record.publicProvider(decryptErr)
		return audit.NewStore(tx).Append(ctx, audit.Event{
			ActorUserID: actor.ID,
			Action:      audit.ActionAISettingsUpdated,
			TargetType:  "ai_provider_config",
			TargetID:    record.ID,
			Result:      audit.ResultSuccess,
			RequestID:   requestID,
			Metadata:    AuditMetadata(record.ConfigVersion, public.Available),
		})
	})
	return public, err
}

func (s *Service) UpdateAIProvider(ctx context.Context, actor users.User, requestID, id string, input AIProviderInput) (PublicAIProvider, error) {
	if IsTokenPlanPersonalBaseURL(input.BaseURL) && strings.TrimSpace(input.Model) != "" {
		verified, err := NewStore(s.db, s.box).TokenPlanModelVerified(ctx, id, strings.TrimSpace(input.Model))
		if err != nil {
			return PublicAIProvider{}, err
		}
		if !verified {
			return PublicAIProvider{}, ErrModelNotVerified
		}
	}
	var public PublicAIProvider
	err := pgx.BeginFunc(ctx, s.db, func(tx pgx.Tx) error {
		store := NewStore(tx, s.box)
		record, err := store.UpdateAIProvider(ctx, actor, id, input)
		if err != nil {
			return err
		}
		_, decryptErr := store.DecryptAPIKey(record)
		public = record.publicProvider(decryptErr)
		return audit.NewStore(tx).Append(ctx, audit.Event{
			ActorUserID: actor.ID,
			Action:      audit.ActionAISettingsUpdated,
			TargetType:  "ai_provider_config",
			TargetID:    record.ID,
			Result:      audit.ResultSuccess,
			RequestID:   requestID,
			Metadata:    AuditMetadata(record.ConfigVersion, public.Available),
		})
	})
	return public, err
}

func (s *Service) DeleteAIProvider(ctx context.Context, actor users.User, requestID, id string) error {
	return pgx.BeginFunc(ctx, s.db, func(tx pgx.Tx) error {
		store := NewStore(tx, s.box)
		if err := store.DeleteAIProvider(ctx, id); err != nil {
			return err
		}
		return audit.NewStore(tx).Append(ctx, audit.Event{
			ActorUserID: actor.ID,
			Action:      audit.ActionAISettingsUpdated,
			TargetType:  "ai_provider_config",
			TargetID:    id,
			Result:      audit.ResultSuccess,
			RequestID:   requestID,
			Metadata:    map[string]any{"deleted": true},
		})
	})
}

func (s *Service) ActivateAIProvider(ctx context.Context, actor users.User, requestID, id string) (PublicAIProvider, error) {
	preStore := NewStore(s.db, s.box)
	current, currentErr := preStore.GetAIByID(ctx, id)
	if currentErr != nil {
		return PublicAIProvider{}, currentErr
	}
	if IsTokenPlanPersonalBaseURL(current.BaseURL) {
		verified, verifyErr := preStore.TokenPlanModelVerified(ctx, id, current.Model)
		if verifyErr != nil {
			return PublicAIProvider{}, verifyErr
		}
		if !verified {
			return PublicAIProvider{}, ErrModelNotVerified
		}
	}
	var public PublicAIProvider
	err := pgx.BeginFunc(ctx, s.db, func(tx pgx.Tx) error {
		store := NewStore(tx, s.box)
		record, err := store.ActivateAIProvider(ctx, actor, id)
		if err != nil {
			return err
		}
		_, decryptErr := store.DecryptAPIKey(record)
		public = record.publicProvider(decryptErr)
		return audit.NewStore(tx).Append(ctx, audit.Event{
			ActorUserID: actor.ID,
			Action:      audit.ActionAISettingsUpdated,
			TargetType:  "ai_provider_config",
			TargetID:    record.ID,
			Result:      audit.ResultSuccess,
			RequestID:   requestID,
			Metadata:    map[string]any{"activated": true},
		})
	})
	return public, err
}

func (s *Service) TestAIProvider(ctx context.Context, actor users.User, requestID, id string, input *AIProviderInput) (AITestResult, error) {
	store := NewStore(s.db, s.box)
	record, err := store.GetAIByID(ctx, id)
	if err != nil {
		return AITestResult{}, err
	}
	baseURL := record.BaseURL
	model := record.Model
	apiKey := ""
	if input != nil {
		normalized, normErr := normalizeAIProviderInput(*input)
		if normErr != nil {
			return AITestResult{}, normErr
		}
		if normalized.BaseURL != "" {
			baseURL = normalized.BaseURL
		}
		if normalized.Model != "" {
			model = normalized.Model
		}
		if strings.TrimSpace(normalized.APIKey) != "" {
			apiKey = strings.TrimSpace(normalized.APIKey)
		}
	}
	if apiKey == "" {
		decrypted, decryptErr := store.DecryptAPIKey(record)
		if decryptErr != nil {
			return AITestResult{Message: "模型密钥无法解密"}, nil
		}
		apiKey = decrypted
	}
	if model == "" {
		model = "gpt-4o-mini"
	}
	result := ProbeAI(ctx, s.client, baseURL, apiKey, model)
	_ = audit.NewStore(s.db).Append(ctx, audit.Event{
		ActorUserID: actor.ID,
		Action:      audit.ActionAISettingsTested,
		TargetType:  "ai_provider_config",
		TargetID:    id,
		Result:      audit.ResultSuccess,
		RequestID:   requestID,
		Metadata: map[string]any{
			"reachable":  result.Reachable,
			"modelFound": result.ModelFound,
		},
	})
	return result, nil
}

func (s *Service) DiscoverProviderModels(ctx context.Context, id string, draft *AIProviderInput) ([]DiscoveredModel, error) {
	store := NewStore(s.db, s.box)
	record, err := store.GetAIByID(ctx, id)
	if err != nil {
		return nil, err
	}
	baseURL := record.BaseURL
	apiKey := ""
	if draft != nil {
		if strings.TrimSpace(draft.BaseURL) != "" {
			baseURL = strings.TrimSpace(draft.BaseURL)
		}
		if strings.TrimSpace(draft.APIKey) != "" {
			apiKey = strings.TrimSpace(draft.APIKey)
		}
	}
	if apiKey == "" {
		decrypted, decryptErr := store.DecryptAPIKey(record)
		if decryptErr != nil {
			return nil, decryptErr
		}
		apiKey = decrypted
	}
	if _, err := s.DiscoverModelsForProvider(ctx, id, baseURL, apiKey); err != nil {
		return nil, err
	}
	if IsTokenPlanPersonalBaseURL(baseURL) {
		return store.ListTokenPlanProviderModels(ctx, id, baseURL)
	}
	return store.ListDiscoveredModels(ctx, baseURL)
}

func (s *Service) AddProviderModel(ctx context.Context, providerID, modelID, ownedBy string) (DiscoveredModel, error) {
	store := NewStore(s.db, s.box)
	record, err := store.GetAIByID(ctx, providerID)
	if err != nil {
		return DiscoveredModel{}, err
	}
	return store.AddDiscoveredModel(ctx, record.BaseURL, modelID, ownedBy)
}

func (s *Service) DeleteProviderModel(ctx context.Context, providerID, modelID string) error {
	store := NewStore(s.db, s.box)
	record, err := store.GetAIByID(ctx, providerID)
	if err != nil {
		return err
	}
	return store.DeleteDiscoveredModel(ctx, record.BaseURL, modelID)
}

func (s *Service) ActivateProviderModel(ctx context.Context, actor users.User, requestID, providerID, modelID string) (PublicAIProvider, error) {
	store := NewStore(s.db, s.box)
	record, err := store.GetAIByID(ctx, providerID)
	if err != nil {
		return PublicAIProvider{}, err
	}
	if IsTokenPlanPersonalBaseURL(record.BaseURL) {
		verified, verifyErr := store.TokenPlanModelVerified(ctx, providerID, strings.TrimSpace(modelID))
		if verifyErr != nil {
			return PublicAIProvider{}, verifyErr
		}
		if !verified {
			return PublicAIProvider{}, ErrModelNotVerified
		}
	}
	enabled := true
	input := AIProviderInput{
		Name:              record.Name,
		Provider:          record.Provider,
		BaseURL:           record.BaseURL,
		Model:             strings.TrimSpace(modelID),
		QuestionTimeoutMs: record.QuestionTimeoutMs,
		ReportTimeoutMs:   record.ReportTimeoutMs,
		Enabled:           &enabled,
	}
	return s.UpdateAIProvider(ctx, actor, requestID, providerID, input)
}

func (s *Service) ListProviderModels(ctx context.Context, providerID string) ([]DiscoveredModel, error) {
	store := NewStore(s.db, s.box)
	record, err := store.GetAIByID(ctx, providerID)
	if err != nil {
		return nil, err
	}
	if IsTokenPlanPersonalBaseURL(record.BaseURL) {
		return store.ListTokenPlanProviderModels(ctx, providerID, record.BaseURL)
	}
	return store.ListDiscoveredModels(ctx, record.BaseURL)
}

func (s *Service) SetProviderModelEnabled(ctx context.Context, providerID, modelID string, enabled bool) error {
	store := NewStore(s.db, s.box)
	record, err := store.GetAIByID(ctx, providerID)
	if err != nil {
		return err
	}
	return store.SetModelEnabled(ctx, record.BaseURL, modelID, enabled)
}

func ProviderInputFromLegacy(input AIInput, name string) AIProviderInput {
	return AIProviderInput{
		Name:              name,
		Provider:          input.Provider,
		BaseURL:           input.BaseURL,
		Model:             input.Model,
		QuestionTimeoutMs: input.QuestionTimeoutMs,
		ReportTimeoutMs:   input.ReportTimeoutMs,
		Enabled:           input.Enabled,
		APIKey:            input.APIKey,
		ClearAPIKey:       input.ClearAPIKey,
	}
}

func (s *Service) providerConfiguredErr(err error) bool {
	return err != nil && !errors.Is(err, ErrNotConfigured)
}
