package settings

import (
	"context"
	"errors"
	"strings"
	"time"

	"unicode/utf8"

	"github.com/ai-interviewer/ai-powered/control-api/internal/users"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

var (
	ErrAIProviderNotFound = errors.New("ai provider not found")
	ErrLastAIProvider     = errors.New("cannot delete the last ai provider")
)

type AIProviderInput struct {
	Name              string
	Provider          string
	BaseURL           string
	Model             string
	QuestionTimeoutMs int
	ReportTimeoutMs   int
	Enabled           *bool
	APIKey            string
	ClearAPIKey       bool
	IsDefault         *bool
}

type PublicAIProvider struct {
	ID                string     `json:"id"`
	Name              string     `json:"name"`
	IsDefault         bool       `json:"isDefault"`
	Configured        bool       `json:"configured"`
	Available         bool       `json:"available"`
	Provider          string     `json:"provider"`
	BaseURL           string     `json:"baseUrl"`
	Model             string     `json:"model"`
	QuestionTimeoutMs int        `json:"questionTimeoutMs"`
	ReportTimeoutMs   int        `json:"reportTimeoutMs"`
	Enabled           bool       `json:"enabled"`
	APIKeyConfigured  bool       `json:"apiKeyConfigured"`
	LocalEndpoint     bool       `json:"localEndpoint"`
	ConfigVersion     int        `json:"configVersion"`
	UpdatedAt         *time.Time `json:"updatedAt,omitempty"`
	UpdatedByUsername string     `json:"updatedByUsername,omitempty"`
}

func (record AIRecord) publicProvider(decryptErr error) PublicAIProvider {
	public := PublicAIFrom(record, decryptErr)
	return PublicAIProvider{
		ID:                record.ID,
		Name:              record.Name,
		IsDefault:         record.IsDefault,
		Configured:        public.Configured,
		Available:         public.Available,
		Provider:          public.Provider,
		BaseURL:           public.BaseURL,
		Model:             public.Model,
		QuestionTimeoutMs: public.QuestionTimeoutMs,
		ReportTimeoutMs:   public.ReportTimeoutMs,
		Enabled:           public.Enabled,
		APIKeyConfigured:  public.APIKeyConfigured,
		LocalEndpoint:     public.LocalEndpoint,
		ConfigVersion:     public.ConfigVersion,
		UpdatedAt:         public.UpdatedAt,
		UpdatedByUsername: public.UpdatedByUsername,
	}
}

func (s *Store) scanAIRecord(row pgx.Row) (AIRecord, error) {
	record := AIRecord{}
	var encrypted []byte
	err := row.Scan(
		&record.ID,
		&record.Name,
		&record.IsDefault,
		&record.Provider,
		&record.BaseURL,
		&record.Model,
		&record.QuestionTimeoutMs,
		&record.ReportTimeoutMs,
		&record.Enabled,
		&encrypted,
		&record.KeyVersion,
		&record.ConfigVersion,
		&record.UpdatedByUserID,
		&record.UpdatedByUsername,
		&record.CreatedAt,
		&record.UpdatedAt,
	)
	if err != nil {
		return AIRecord{}, err
	}
	record.EncryptedAPIKey = encrypted
	return record, nil
}

const aiProviderSelect = `
	select
		c.id, coalesce(c.name, 'OpenAI 兼容'), c.is_default,
		c.provider, c.base_url, c.model, c.question_timeout_ms, c.report_timeout_ms,
		c.enabled, c.encrypted_api_key, c.key_version, c.config_version,
		coalesce(c.updated_by_user_id, ''), coalesce(u.username, ''),
		c.created_at, c.updated_at
	from ai_provider_configs as c
	left join users as u on u.id = c.updated_by_user_id
`

func (s *Store) GetAI(ctx context.Context) (AIRecord, error) {
	record, err := s.GetDefaultAI(ctx)
	if err == nil {
		return record, nil
	}
	if !errors.Is(err, ErrNotConfigured) {
		return AIRecord{}, err
	}
	return s.GetAIByID(ctx, singletonID)
}

func (s *Store) GetDefaultAI(ctx context.Context) (AIRecord, error) {
	record, err := s.scanAIRecord(s.db.QueryRow(ctx, aiProviderSelect+`
		where c.is_default = true
		order by c.updated_at desc
		limit 1
	`))
	if errors.Is(err, pgx.ErrNoRows) {
		return AIRecord{}, ErrNotConfigured
	}
	if err != nil {
		return AIRecord{}, ErrStore
	}
	return record, nil
}

func (s *Store) GetAIByID(ctx context.Context, id string) (AIRecord, error) {
	record, err := s.scanAIRecord(s.db.QueryRow(ctx, aiProviderSelect+`
		where c.id = $1
	`, strings.TrimSpace(id)))
	if errors.Is(err, pgx.ErrNoRows) {
		return AIRecord{}, ErrAIProviderNotFound
	}
	if err != nil {
		return AIRecord{}, ErrStore
	}
	return record, nil
}

func (s *Store) ListAIProviders(ctx context.Context) ([]AIRecord, error) {
	rows, err := s.db.Query(ctx, aiProviderSelect+`
		order by c.is_default desc, c.updated_at desc
	`)
	if err != nil {
		return nil, ErrStore
	}
	defer rows.Close()
	records := make([]AIRecord, 0, 4)
	for rows.Next() {
		record := AIRecord{}
		var encrypted []byte
		if err := rows.Scan(
			&record.ID,
			&record.Name,
			&record.IsDefault,
			&record.Provider,
			&record.BaseURL,
			&record.Model,
			&record.QuestionTimeoutMs,
			&record.ReportTimeoutMs,
			&record.Enabled,
			&encrypted,
			&record.KeyVersion,
			&record.ConfigVersion,
			&record.UpdatedByUserID,
			&record.UpdatedByUsername,
			&record.CreatedAt,
			&record.UpdatedAt,
		); err != nil {
			return nil, ErrStore
		}
		record.EncryptedAPIKey = encrypted
		records = append(records, record)
	}
	if err := rows.Err(); err != nil {
		return nil, ErrStore
	}
	if records == nil {
		records = []AIRecord{}
	}
	return records, nil
}

func (s *Store) countAIProviders(ctx context.Context) (int, error) {
	var count int
	if err := s.db.QueryRow(ctx, `select count(*) from ai_provider_configs`).Scan(&count); err != nil {
		return 0, ErrStore
	}
	return count, nil
}

func (s *Store) upsertAIProvider(ctx context.Context, actor users.User, id string, input AIProviderInput, current AIRecord, hasCurrent bool) (AIRecord, error) {
	normalized, err := normalizeAIProviderInput(input)
	if err != nil {
		return AIRecord{}, err
	}
	encrypted := current.EncryptedAPIKey
	keyVersion := current.KeyVersion
	if keyVersion == 0 {
		keyVersion = 1
	}
	if normalized.ClearAPIKey {
		encrypted = nil
	} else if strings.TrimSpace(normalized.APIKey) != "" {
		if s.box == nil {
			return AIRecord{}, ErrMasterKeyMissing
		}
		sealed, sealErr := s.box.Seal([]byte(strings.TrimSpace(normalized.APIKey)))
		if sealErr != nil {
			return AIRecord{}, sealErr
		}
		encrypted = sealed
		keyVersion = s.box.KeyVersion()
	}
	enabled := true
	if normalized.Enabled != nil {
		enabled = *normalized.Enabled
	} else if hasCurrent {
		enabled = current.Enabled
	}
	isDefault := current.IsDefault
	if normalized.IsDefault != nil {
		isDefault = *normalized.IsDefault
	} else if !hasCurrent {
		count, countErr := s.countAIProviders(ctx)
		if countErr != nil {
			return AIRecord{}, countErr
		}
		isDefault = count == 0
	}
	name := normalized.Name
	if name == "" && hasCurrent {
		name = current.Name
	}
	if name == "" {
		name = "OpenAI 兼容"
	}
	now := time.Now().UTC().Truncate(time.Microsecond)
	configVersion := 1
	if hasCurrent {
		configVersion = current.ConfigVersion + 1
	}
	if isDefault {
		if _, err := s.db.Exec(ctx, `update ai_provider_configs set is_default = false where id <> $1`, id); err != nil {
			return AIRecord{}, ErrStore
		}
	}
	_, err = s.db.Exec(ctx, `
		insert into ai_provider_configs (
			id, name, is_default, provider, base_url, model, question_timeout_ms, report_timeout_ms,
			enabled, encrypted_api_key, key_version, config_version, updated_by_user_id,
			created_at, updated_at
		) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14)
		on conflict (id) do update set
			name = excluded.name,
			is_default = excluded.is_default,
			provider = excluded.provider,
			base_url = excluded.base_url,
			model = excluded.model,
			question_timeout_ms = excluded.question_timeout_ms,
			report_timeout_ms = excluded.report_timeout_ms,
			enabled = excluded.enabled,
			encrypted_api_key = excluded.encrypted_api_key,
			key_version = excluded.key_version,
			config_version = excluded.config_version,
			updated_by_user_id = excluded.updated_by_user_id,
			updated_at = excluded.updated_at
	`, id, name, isDefault, normalized.Provider, normalized.BaseURL, normalized.Model,
		normalized.QuestionTimeoutMs, normalized.ReportTimeoutMs, enabled,
		encrypted, keyVersion, configVersion, actor.ID, now)
	if err != nil {
		return AIRecord{}, ErrStore
	}
	return s.GetAIByID(ctx, id)
}

func (s *Store) PutAI(ctx context.Context, actor users.User, input AIInput) (AIRecord, error) {
	defaultRecord, defaultErr := s.GetDefaultAI(ctx)
	if defaultErr != nil && !errors.Is(defaultErr, ErrNotConfigured) {
		return AIRecord{}, defaultErr
	}
	id := singletonID
	current := AIRecord{}
	hasCurrent := false
	if defaultErr == nil {
		id = defaultRecord.ID
		current = defaultRecord
		hasCurrent = true
	} else {
		legacy, legacyErr := s.GetAIByID(ctx, singletonID)
		if legacyErr == nil {
			id = legacy.ID
			current = legacy
			hasCurrent = true
		}
	}
	return s.upsertAIProvider(ctx, actor, id, aiProviderInputFromLegacy(input), current, hasCurrent)
}

func (s *Store) CreateAIProvider(ctx context.Context, actor users.User, input AIProviderInput) (AIRecord, error) {
	id := uuid.NewString()
	current := AIRecord{}
	return s.upsertAIProvider(ctx, actor, id, input, current, false)
}

func (s *Store) UpdateAIProvider(ctx context.Context, actor users.User, id string, input AIProviderInput) (AIRecord, error) {
	current, err := s.GetAIByID(ctx, id)
	if err != nil {
		return AIRecord{}, err
	}
	return s.upsertAIProvider(ctx, actor, id, input, current, true)
}

func (s *Store) DeleteAIProvider(ctx context.Context, id string) error {
	current, err := s.GetAIByID(ctx, id)
	if err != nil {
		return err
	}
	count, err := s.countAIProviders(ctx)
	if err != nil {
		return err
	}
	if count <= 1 {
		return ErrLastAIProvider
	}
	tag, err := s.db.Exec(ctx, `delete from ai_provider_configs where id = $1`, id)
	if err != nil {
		return ErrStore
	}
	if tag.RowsAffected() == 0 {
		return ErrAIProviderNotFound
	}
	if current.IsDefault {
		var nextID string
		if err := s.db.QueryRow(ctx, `
			select id from ai_provider_configs order by updated_at desc limit 1
		`).Scan(&nextID); err == nil && strings.TrimSpace(nextID) != "" {
			_, _ = s.db.Exec(ctx, `update ai_provider_configs set is_default = true where id = $1`, nextID)
		}
	}
	return nil
}

func (s *Store) ActivateAIProvider(ctx context.Context, actor users.User, id string) (AIRecord, error) {
	current, err := s.GetAIByID(ctx, id)
	if err != nil {
		return AIRecord{}, err
	}
	input := AIProviderInput{
		Name:              current.Name,
		Provider:          current.Provider,
		BaseURL:           current.BaseURL,
		Model:             current.Model,
		QuestionTimeoutMs: current.QuestionTimeoutMs,
		ReportTimeoutMs:   current.ReportTimeoutMs,
	}
	enabled := current.Enabled
	input.Enabled = &enabled
	isDefault := true
	input.IsDefault = &isDefault
	return s.upsertAIProvider(ctx, actor, id, input, current, true)
}

func (s *Store) AddDiscoveredModel(ctx context.Context, baseURL, modelID, ownedBy string) (DiscoveredModel, error) {
	modelID = strings.TrimSpace(modelID)
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if modelID == "" || baseURL == "" {
		return DiscoveredModel{}, ErrInvalidInput
	}
	models := []DiscoveredModel{{
		ModelID:    modelID,
		BaseURL:    baseURL,
		OwnedBy:    strings.TrimSpace(ownedBy),
		Capability: ClassifyModelID(modelID),
	}}
	if err := s.UpsertDiscoveredModels(ctx, baseURL, models); err != nil {
		return DiscoveredModel{}, err
	}
	listed, err := s.ListDiscoveredModels(ctx, baseURL)
	if err != nil {
		return DiscoveredModel{}, err
	}
	for _, model := range listed {
		if model.ModelID == modelID {
			return model, nil
		}
	}
	return DiscoveredModel{}, ErrStore
}

func (s *Store) DeleteDiscoveredModel(ctx context.Context, baseURL, modelID string) error {
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	modelID = strings.TrimSpace(modelID)
	tag, err := s.db.Exec(ctx, `
		delete from discovered_models where base_url = $1 and model_id = $2
	`, baseURL, modelID)
	if err != nil {
		return ErrStore
	}
	if tag.RowsAffected() == 0 {
		return ErrNotConfigured
	}
	return nil
}

func aiProviderInputFromLegacy(input AIInput) AIProviderInput {
	return AIProviderInput{
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

func normalizeAIProviderInput(input AIProviderInput) (AIProviderInput, error) {
	model := strings.TrimSpace(input.Model)
	if model == "" {
		input.Model = ""
		legacy, err := normalizeAIInput(AIInput{
			Provider:          input.Provider,
			BaseURL:           input.BaseURL,
			Model:             "pending",
			QuestionTimeoutMs: input.QuestionTimeoutMs,
			ReportTimeoutMs:   input.ReportTimeoutMs,
			Enabled:           input.Enabled,
			APIKey:            input.APIKey,
			ClearAPIKey:       input.ClearAPIKey,
		})
		if err != nil {
			return AIProviderInput{}, err
		}
		legacy.Model = ""
		name := strings.TrimSpace(input.Name)
		if utf8.RuneCountInString(name) > 120 {
			return AIProviderInput{}, ErrInvalidInput
		}
		return AIProviderInput{
			Name:              name,
			Provider:          legacy.Provider,
			BaseURL:           legacy.BaseURL,
			Model:             "",
			QuestionTimeoutMs: legacy.QuestionTimeoutMs,
			ReportTimeoutMs:   legacy.ReportTimeoutMs,
			Enabled:           legacy.Enabled,
			APIKey:            legacy.APIKey,
			ClearAPIKey:       legacy.ClearAPIKey,
			IsDefault:         input.IsDefault,
		}, nil
	}
	legacy, err := normalizeAIInput(AIInput{
		Provider:          input.Provider,
		BaseURL:           input.BaseURL,
		Model:             input.Model,
		QuestionTimeoutMs: input.QuestionTimeoutMs,
		ReportTimeoutMs:   input.ReportTimeoutMs,
		Enabled:           input.Enabled,
		APIKey:            input.APIKey,
		ClearAPIKey:       input.ClearAPIKey,
	})
	if err != nil {
		return AIProviderInput{}, err
	}
	name := strings.TrimSpace(input.Name)
	if utf8.RuneCountInString(name) > 120 {
		return AIProviderInput{}, ErrInvalidInput
	}
	return AIProviderInput{
		Name:              name,
		Provider:          legacy.Provider,
		BaseURL:           legacy.BaseURL,
		Model:             legacy.Model,
		QuestionTimeoutMs: legacy.QuestionTimeoutMs,
		ReportTimeoutMs:   legacy.ReportTimeoutMs,
		Enabled:           legacy.Enabled,
		APIKey:            legacy.APIKey,
		ClearAPIKey:       legacy.ClearAPIKey,
		IsDefault:         input.IsDefault,
	}, nil
}
