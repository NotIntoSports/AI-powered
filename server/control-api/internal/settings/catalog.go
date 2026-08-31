package settings

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"
	"unicode"

	"github.com/jackc/pgx/v5"
)

type CatalogEntry struct {
	ID              string     `json:"id"`
	ProviderID      string     `json:"providerId"`
	ProviderName    string     `json:"providerName"`
	ModelID         string     `json:"modelId"`
	BaseURL         string     `json:"baseUrl"`
	Capability      string     `json:"capability"`
	Enabled         bool       `json:"enabled"`
	Label           string     `json:"label"`
	DisplayName     string     `json:"displayName,omitempty"`
	RuntimeVerified bool       `json:"runtimeVerified"`
	ClassifiedBy    string     `json:"classifiedBy,omitempty"`
	ClassifiedAt    *time.Time `json:"classifiedAt,omitempty"`
}

func catalogRuntimeVerified(baseURL string, official bool, verificationStatus string) bool {
	if !IsTokenPlanPersonalBaseURL(baseURL) {
		return true
	}
	return official && verificationStatus == "success"
}

type CatalogSyncResult struct {
	Providers  int `json:"providers"`
	Models     int `json:"models"`
	Classified int `json:"classified"`
}

type CatalogPatchInput struct {
	Capability  *string `json:"capability"`
	Enabled     *bool   `json:"enabled"`
	DisplayName *string `json:"displayName"`
}

type ClientPipeline struct {
	Mode         string                  `json:"mode"`
	ASR          *ClientPipelineEndpoint `json:"asr,omitempty"`
	LLM          *ClientPipelineEndpoint `json:"llm,omitempty"`
	TTS          *ClientPipelineEndpoint `json:"tts,omitempty"`
	E2E          *ClientPipelineEndpoint `json:"e2e,omitempty"`
	Voice        string                  `json:"voice,omitempty"`
	E2EAvailable bool                    `json:"e2eAvailable"`
	Message      string                  `json:"message,omitempty"`
}

type ClientPipelineEndpoint struct {
	ProviderID   string `json:"providerId"`
	ProviderName string `json:"providerName"`
	ModelID      string `json:"modelId"`
	BaseURL      string `json:"baseUrl,omitempty"`
	APIKey       string `json:"apiKey,omitempty"`
	Source       string `json:"source,omitempty"`
}

func ClassifyModelID(modelID string) string {
	id := strings.ToLower(strings.TrimSpace(modelID))
	if id == "" {
		return CapabilityUnknown
	}
	compact := strings.Map(func(r rune) rune {
		if unicode.IsLetter(r) || unicode.IsDigit(r) || r == '-' || r == '_' || r == '.' {
			return r
		}
		return -1
	}, id)

	e2eHints := []string{"realtime", "omni", "speech-to-speech", "speechtospeech", "s2s", "gpt-4o-realtime", "qwen3-omni", "qwen-omni"}
	for _, h := range e2eHints {
		if strings.Contains(compact, h) || strings.Contains(id, h) {
			return CapabilityE2E
		}
	}
	asrHints := []string{"whisper", "paraformer", "asr", "transcri", "speech-to-text", "stt", "fun-asr", "funasr"}
	for _, h := range asrHints {
		if strings.Contains(compact, h) || strings.Contains(id, h) {
			return CapabilityASR
		}
	}
	ttsHints := []string{"tts", "cosyvoice", "speech-synthesis", "text-to-speech", "sambert", "long"}
	// "long" alone is too broad — only cosyvoice-style long* voices as tts when prefixed
	for _, h := range ttsHints {
		if h == "long" {
			continue
		}
		if strings.Contains(compact, h) || strings.Contains(id, h) {
			return CapabilityTTS
		}
	}
	if strings.HasPrefix(compact, "cosyvoice") || strings.HasPrefix(id, "cosyvoice") {
		return CapabilityTTS
	}
	llmHints := []string{"qwen", "deepseek", "gpt", "glm", "claude", "gemini", "llama", "mistral", "yi-", "moonshot", "kimi", "chat", "instruct"}
	for _, h := range llmHints {
		if strings.Contains(compact, h) || strings.Contains(id, h) {
			return CapabilityLLM
		}
	}
	return CapabilityUnknown
}

func scanDiscoveredModels(rows pgx.Rows) ([]DiscoveredModel, error) {
	var models []DiscoveredModel
	for rows.Next() {
		var m DiscoveredModel
		var classifiedAt *time.Time
		if err := rows.Scan(
			&m.ID, &m.ProviderID, &m.ModelID, &m.BaseURL, &m.Enabled, &m.OwnedBy,
			&m.Capability, &m.DisplayName, &m.ClassifiedBy, &classifiedAt, &m.DiscoveredAt, &m.UpdatedAt,
		); err != nil {
			return nil, ErrStore
		}
		m.ClassifiedAt = classifiedAt
		models = append(models, m)
	}
	if err := rows.Err(); err != nil {
		return nil, ErrStore
	}
	if models == nil {
		models = []DiscoveredModel{}
	}
	return models, nil
}

func (s *Store) ListCatalog(ctx context.Context, capability, query string) ([]CatalogEntry, error) {
	capability = strings.TrimSpace(capability)
	query = strings.TrimSpace(query)
	rows, err := s.db.Query(ctx, `
		select
			dm.id, coalesce(dm.provider_id, ''), coalesce(p.name, dm.provider_id, ''),
			dm.model_id, dm.base_url, coalesce(dm.capability, 'unknown'), dm.enabled,
			coalesce(dm.display_name, ''), coalesce(dm.classified_by, ''), dm.classified_at,
			(tpo.model_id is not null), coalesce(tps.verification_status, 'untested')
		from discovered_models as dm
		left join ai_provider_configs as p on p.id = dm.provider_id
		left join token_plan_official_models as tpo on tpo.model_id = dm.model_id
		left join token_plan_model_status as tps on tps.provider_id = dm.provider_id and tps.model_id = dm.model_id
		where ($1 = '' or dm.capability = $1)
		  and (
			$2 = '' or
			dm.model_id ilike '%' || $2 || '%' or
			coalesce(p.name, '') ilike '%' || $2 || '%' or
			coalesce(dm.display_name, '') ilike '%' || $2 || '%' or
			dm.provider_id ilike '%' || $2 || '%'
		  )
		order by coalesce(p.name, dm.provider_id), dm.model_id
	`, capability, query)
	if err != nil {
		return nil, ErrStore
	}
	defer rows.Close()
	var entries []CatalogEntry
	for rows.Next() {
		var e CatalogEntry
		var classifiedAt *time.Time
		var official bool
		var verificationStatus string
		if err := rows.Scan(
			&e.ID, &e.ProviderID, &e.ProviderName, &e.ModelID, &e.BaseURL,
			&e.Capability, &e.Enabled, &e.DisplayName, &e.ClassifiedBy, &classifiedAt,
			&official, &verificationStatus,
		); err != nil {
			return nil, ErrStore
		}
		e.ClassifiedAt = classifiedAt
		e.RuntimeVerified = catalogRuntimeVerified(e.BaseURL, official, verificationStatus)
		if e.ProviderName == "" {
			e.ProviderName = e.ProviderID
		}
		e.Label = e.ProviderName + " · " + e.ModelID
		entries = append(entries, e)
	}
	if err := rows.Err(); err != nil {
		return nil, ErrStore
	}
	if entries == nil {
		entries = []CatalogEntry{}
	}
	return entries, nil
}

func (s *Store) PatchCatalogModel(ctx context.Context, providerID, modelID string, input CatalogPatchInput) (DiscoveredModel, error) {
	providerID = strings.TrimSpace(providerID)
	modelID = strings.TrimSpace(modelID)
	if providerID == "" || modelID == "" {
		return DiscoveredModel{}, ErrInvalidInput
	}
	current, err := s.GetCatalogModel(ctx, providerID, modelID)
	if err != nil {
		return DiscoveredModel{}, err
	}
	capability := current.Capability
	if input.Capability != nil {
		cap := strings.TrimSpace(*input.Capability)
		switch cap {
		case CapabilityLLM, CapabilityASR, CapabilityTTS, CapabilityE2E, CapabilityUnknown:
			capability = cap
		default:
			return DiscoveredModel{}, ErrInvalidInput
		}
	}
	enabled := current.Enabled
	if input.Enabled != nil {
		enabled = *input.Enabled
	}
	displayName := current.DisplayName
	if input.DisplayName != nil {
		displayName = strings.TrimSpace(*input.DisplayName)
	}
	classifiedBy := current.ClassifiedBy
	if input.Capability != nil {
		classifiedBy = "manual"
	}
	_, err = s.db.Exec(ctx, `
		update discovered_models
		set capability = $1, enabled = $2, display_name = $3,
		    classified_by = $4, classified_at = now(), updated_at = now()
		where provider_id = $5 and model_id = $6
	`, capability, enabled, displayName, classifiedBy, providerID, modelID)
	if err != nil {
		return DiscoveredModel{}, ErrStore
	}
	return s.GetCatalogModel(ctx, providerID, modelID)
}

func (s *Store) GetCatalogModel(ctx context.Context, providerID, modelID string) (DiscoveredModel, error) {
	var m DiscoveredModel
	var classifiedAt *time.Time
	err := s.db.QueryRow(ctx, `
		select id, coalesce(provider_id, ''), model_id, base_url, enabled, coalesce(owned_by, ''),
		       coalesce(capability, 'unknown'), coalesce(display_name, ''), coalesce(classified_by, ''),
		       classified_at, discovered_at, updated_at
		from discovered_models
		where provider_id = $1 and model_id = $2
	`, providerID, modelID).Scan(
		&m.ID, &m.ProviderID, &m.ModelID, &m.BaseURL, &m.Enabled, &m.OwnedBy,
		&m.Capability, &m.DisplayName, &m.ClassifiedBy, &classifiedAt, &m.DiscoveredAt, &m.UpdatedAt,
	)
	if err == pgx.ErrNoRows {
		return DiscoveredModel{}, ErrNotConfigured
	}
	if err != nil {
		return DiscoveredModel{}, ErrStore
	}
	m.ClassifiedAt = classifiedAt
	return m, nil
}

func (s *Store) ListUnclassifiedModels(ctx context.Context) ([]DiscoveredModel, error) {
	rows, err := s.db.Query(ctx, `
		select id, coalesce(provider_id, ''), model_id, base_url, enabled, coalesce(owned_by, ''),
		       coalesce(capability, 'unknown'), coalesce(display_name, ''), coalesce(classified_by, ''),
		       classified_at, discovered_at, updated_at
		from discovered_models
		where capability = 'unknown' or capability is null or capability = ''
		order by provider_id, model_id
		limit 200
	`)
	if err != nil {
		return nil, ErrStore
	}
	defer rows.Close()
	return scanDiscoveredModels(rows)
}

func (s *Store) SetModelCapability(ctx context.Context, providerID, modelID, capability, classifiedBy string) error {
	capability = strings.TrimSpace(capability)
	switch capability {
	case CapabilityLLM, CapabilityASR, CapabilityTTS, CapabilityE2E, CapabilityUnknown:
	default:
		return ErrInvalidInput
	}
	tag, err := s.db.Exec(ctx, `
		update discovered_models
		set capability = $1, classified_by = $2, classified_at = now(), updated_at = now()
		where provider_id = $3 and model_id = $4
		  and coalesce(classified_by, '') <> 'manual'
	`, capability, classifiedBy, providerID, modelID)
	if err != nil {
		return ErrStore
	}
	if tag.RowsAffected() == 0 {
		// manual rows or missing — try without manual guard only if missing classified_by manual
		_, err = s.db.Exec(ctx, `
			update discovered_models
			set capability = $1, classified_by = $2, classified_at = now(), updated_at = now()
			where provider_id = $3 and model_id = $4 and coalesce(classified_by, '') <> 'manual'
		`, capability, classifiedBy, providerID, modelID)
		if err != nil {
			return ErrStore
		}
	}
	return nil
}

func (s *Store) UpsertSpeechCatalogModel(ctx context.Context, providerID, baseURL, modelID, displayName, capability string) error {
	if capability == "" {
		capability = CapabilityTTS
	}
	_, err := s.db.Exec(ctx, `
		insert into discovered_models (
			model_id, base_url, provider_id, owned_by, capability, display_name,
			classified_by, classified_at, enabled, discovered_at, updated_at
		) values ($1, $2, $3, 'speech', $4, $5, 'rules', now(), true, now(), now())
		on conflict (provider_id, model_id) do update set
			base_url = excluded.base_url,
			display_name = excluded.display_name,
			capability = excluded.capability,
			classified_by = case when discovered_models.classified_by = 'manual' then discovered_models.classified_by else 'rules' end,
			classified_at = case when discovered_models.classified_by = 'manual' then discovered_models.classified_at else now() end,
			updated_at = now()
	`, modelID, baseURL, providerID, capability, displayName)
	if err != nil {
		return ErrStore
	}
	return nil
}

func (s *Service) ListCatalog(ctx context.Context, capability, query string) ([]CatalogEntry, error) {
	return NewStore(s.db, s.box).ListCatalog(ctx, capability, query)
}

func (s *Service) PatchCatalogModel(ctx context.Context, providerID, modelID string, input CatalogPatchInput) (DiscoveredModel, error) {
	return NewStore(s.db, s.box).PatchCatalogModel(ctx, providerID, modelID, input)
}

func (s *Service) SyncCatalog(ctx context.Context) (CatalogSyncResult, error) {
	store := NewStore(s.db, s.box)
	providers, err := store.ListAIProviders(ctx)
	if err != nil {
		return CatalogSyncResult{}, err
	}
	result := CatalogSyncResult{}
	for _, provider := range providers {
		if !provider.Enabled {
			continue
		}
		result.Providers++
		apiKey, decryptErr := store.DecryptAPIKey(provider)
		if decryptErr != nil || apiKey == "" {
			continue
		}
		models, discoverErr := s.DiscoverModelsForProvider(ctx, provider.ID, provider.BaseURL, apiKey)
		if discoverErr != nil {
			continue
		}
		result.Models += len(models)
	}
	if err := s.SyncSpeechCatalog(ctx); err != nil {
		return CatalogSyncResult{}, err
	}
	classified, err := s.ReclassifyCatalog(ctx)
	if err != nil {
		return CatalogSyncResult{}, err
	}
	result.Classified = classified
	return result, nil
}

func (s *Service) DiscoverModelsForProvider(ctx context.Context, providerID, baseURL, apiKey string) ([]DiscoveredModel, error) {
	baseURL = strings.TrimRight(baseURL, "/")
	if baseURL == "" {
		return nil, ErrNotConfigured
	}
	client := s.client
	if client == nil {
		client = &http.Client{Timeout: 5 * time.Second}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/models", nil)
	if err != nil {
		return nil, ErrStore
	}
	if apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+apiKey)
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, ErrStore
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, ErrStore
	}
	var parsed struct {
		Data []struct {
			ID      string `json:"id"`
			OwnedBy string `json:"owned_by"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, ErrStore
	}
	seen := map[string]struct{}{}
	models := make([]DiscoveredModel, 0, len(parsed.Data))
	for _, item := range parsed.Data {
		id := strings.TrimSpace(item.ID)
		if id == "" {
			continue
		}
		if _, exists := seen[id]; exists {
			continue
		}
		seen[id] = struct{}{}
		cap := ClassifyModelID(id)
		classifiedBy := "rules"
		if cap == CapabilityUnknown {
			classifiedBy = ""
		}
		models = append(models, DiscoveredModel{
			ProviderID:   providerID,
			ModelID:      id,
			BaseURL:      baseURL,
			Enabled:      true,
			OwnedBy:      item.OwnedBy,
			Capability:   cap,
			ClassifiedBy: classifiedBy,
		})
		if len(models) >= 200 {
			break
		}
	}
	store := NewStore(s.db, s.box)
	if err := store.UpsertDiscoveredModels(ctx, baseURL, models); err != nil {
		return nil, err
	}
	if IsTokenPlanPersonalBaseURL(baseURL) {
		ids := make([]string, 0, len(models))
		for _, model := range models {
			ids = append(ids, model.ModelID)
		}
		if err := store.MarkTokenPlanKeyDiscovery(ctx, providerID, ids); err != nil {
			return nil, err
		}
	}
	return store.ListDiscoveredModels(ctx, baseURL)
}

func (s *Service) ReclassifyCatalog(ctx context.Context) (int, error) {
	store := NewStore(s.db, s.box)
	unknown, err := store.ListUnclassifiedModels(ctx)
	if err != nil {
		return 0, err
	}
	classified := 0
	remaining := make([]DiscoveredModel, 0)
	for _, model := range unknown {
		cap := ClassifyModelID(model.ModelID)
		if cap == CapabilityUnknown {
			remaining = append(remaining, model)
			continue
		}
		if err := store.SetModelCapability(ctx, model.ProviderID, model.ModelID, cap, "rules"); err != nil {
			continue
		}
		classified++
	}
	if len(remaining) == 0 {
		return classified, nil
	}
	llmClassified, err := s.classifyModelsWithLLM(ctx, remaining)
	if err != nil {
		return classified, nil
	}
	for providerID, items := range llmClassified {
		for modelID, cap := range items {
			if err := store.SetModelCapability(ctx, providerID, modelID, cap, "llm"); err != nil {
				continue
			}
			classified++
		}
	}
	return classified, nil
}

func (s *Service) classifyModelsWithLLM(ctx context.Context, models []DiscoveredModel) (map[string]map[string]string, error) {
	store := NewStore(s.db, s.box)
	ai, err := store.GetAI(ctx)
	if err != nil {
		return nil, err
	}
	apiKey, err := store.DecryptAPIKey(ai)
	if err != nil || apiKey == "" {
		return nil, ErrNotConfigured
	}
	ids := make([]string, 0, len(models))
	index := map[string]DiscoveredModel{}
	for _, m := range models {
		ids = append(ids, m.ModelID)
		index[m.ProviderID+"|"+m.ModelID] = m
	}
	payload := map[string]any{
		"model":           ai.Model,
		"temperature":     0,
		"response_format": map[string]string{"type": "json_object"},
		"messages": []map[string]string{
			{
				"role": "system",
				"content": "Classify each model id into one capability: llm, asr, tts, e2e, or unknown. " +
					"e2e means realtime/omni speech-to-speech. Return JSON {\"items\":[{\"id\":\"...\",\"capability\":\"...\"}]}.",
			},
			{
				"role":    "user",
				"content": strings.Join(ids, "\n"),
			},
		},
	}
	raw, _ := json.Marshal(payload)
	client := s.client
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(ai.BaseURL, "/")+"/chat/completions", bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, ErrStore
	}
	var parsed struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil || len(parsed.Choices) == 0 {
		return nil, ErrStore
	}
	var result struct {
		Items []struct {
			ID         string `json:"id"`
			Capability string `json:"capability"`
		} `json:"items"`
	}
	content := strings.TrimSpace(parsed.Choices[0].Message.Content)
	if err := json.Unmarshal([]byte(content), &result); err != nil {
		return nil, ErrStore
	}
	out := map[string]map[string]string{}
	for _, item := range result.Items {
		cap := strings.TrimSpace(strings.ToLower(item.Capability))
		switch cap {
		case CapabilityLLM, CapabilityASR, CapabilityTTS, CapabilityE2E, CapabilityUnknown:
		default:
			continue
		}
		modelID := strings.TrimSpace(item.ID)
		for _, m := range models {
			if m.ModelID != modelID {
				continue
			}
			if out[m.ProviderID] == nil {
				out[m.ProviderID] = map[string]string{}
			}
			out[m.ProviderID][m.ModelID] = cap
		}
	}
	_ = index
	return out, nil
}

func (s *Service) SyncSpeechCatalog(ctx context.Context) error {
	store := NewStore(s.db, s.box)
	record, err := store.GetSpeech(ctx)
	if err != nil {
		if err == ErrNotConfigured {
			return nil
		}
		return err
	}
	if record.AliyunEnabled || record.AliyunAppKey != "" {
		gateway := strings.TrimSpace(record.AliyunGateway)
		if gateway == "" {
			gateway = "https://nls-gateway-cn-shanghai.aliyuncs.com"
		}
		_ = store.UpsertSpeechCatalogModel(ctx, CatalogSpeechAliyun, gateway, "xiaoyun", "NLS 晓云", CapabilityTTS)
		for _, model := range []string{"cosyvoice-v3-flash", "cosyvoice-v3-plus", "cosyvoice-v2", "cosyvoice-v1"} {
			_ = store.UpsertSpeechCatalogModel(ctx, CatalogSpeechAliyun, gateway, model, "CosyVoice "+model, CapabilityTTS)
		}
		voice := strings.TrimSpace(record.AliyunVoice)
		if voice != "" && voice != "xiaoyun" {
			_ = store.UpsertSpeechCatalogModel(ctx, CatalogSpeechAliyun, gateway, voice, "当前音色 "+voice, CapabilityTTS)
		}
	}
	if record.Enabled || record.AppID != "" {
		base := "volcengine://speech"
		speaker := strings.TrimSpace(record.SpeakerID)
		if speaker == "" {
			speaker = "volcengine-default"
		}
		_ = store.UpsertSpeechCatalogModel(ctx, CatalogSpeechVolcengine, base, speaker, "豆包音色", CapabilityTTS)
		if rid := strings.TrimSpace(record.TTSResourceID); rid != "" {
			_ = store.UpsertSpeechCatalogModel(ctx, CatalogSpeechVolcengine, base, rid, "豆包 TTS 资源", CapabilityTTS)
		}
	}
	return nil
}

func (s *Service) GetClientPipeline(ctx context.Context) (ClientPipeline, error) {
	store := NewStore(s.db, s.box)
	rtc, err := store.GetRTC(ctx)
	mode := PipelineModeCascaded
	if err == nil && strings.TrimSpace(rtc.PipelineMode) != "" {
		mode = rtc.PipelineMode
	}
	out := ClientPipeline{Mode: mode, E2EAvailable: false}
	if mode == PipelineModeE2E {
		out.Message = "E2E_NOT_IMPLEMENTED"
		if err == nil && rtc.E2EProviderID != "" && rtc.E2EModelID != "" {
			ep, resolveErr := s.resolvePipelineEndpoint(ctx, rtc.E2EProviderID, rtc.E2EModelID)
			if resolveErr == nil {
				out.E2E = ep
			}
		}
		return out, nil
	}
	if err != nil {
		// fallback to defaults
		if ai, aiErr := s.GetClientAI(ctx); aiErr == nil && ai.Available {
			out.LLM = &ClientPipelineEndpoint{
				ProviderID: "default", ProviderName: "默认 AI", ModelID: ai.Model,
				BaseURL: ai.BaseURL, APIKey: ai.APIKey, Source: "ai",
			}
		}
		if speech, speechErr := s.GetClientSpeech(ctx, ""); speechErr == nil && speech.TTSAvailable {
			out.TTS = &ClientPipelineEndpoint{
				ProviderID: CatalogSpeechAliyun, ProviderName: "语音配置", ModelID: speech.AliyunVoice,
				Source: "speech",
			}
			out.Voice = speech.AliyunVoice
		}
		return out, nil
	}
	if rtc.ASRProviderID != "" && rtc.ASRModelID != "" {
		if ep, e := s.resolvePipelineEndpoint(ctx, rtc.ASRProviderID, rtc.ASRModelID); e == nil {
			out.ASR = ep
		}
	}
	if rtc.LLMProviderID != "" && rtc.LLMModelID != "" {
		if ep, e := s.resolvePipelineEndpoint(ctx, rtc.LLMProviderID, rtc.LLMModelID); e == nil {
			out.LLM = ep
		}
	}
	if rtc.TTSProviderID != "" && rtc.TTSModelID != "" {
		if ep, e := s.resolvePipelineEndpoint(ctx, rtc.TTSProviderID, rtc.TTSModelID); e == nil {
			out.TTS = ep
		}
	}
	out.Voice = strings.TrimSpace(rtc.TTSVoiceID)
	if out.LLM == nil {
		if ai, aiErr := s.GetClientAI(ctx); aiErr == nil && ai.Available {
			out.LLM = &ClientPipelineEndpoint{
				ProviderID: "default", ProviderName: "默认 AI", ModelID: ai.Model,
				BaseURL: ai.BaseURL, APIKey: ai.APIKey, Source: "ai",
			}
		}
	}
	return out, nil
}

func (s *Service) resolvePipelineEndpoint(ctx context.Context, providerID, modelID string) (*ClientPipelineEndpoint, error) {
	store := NewStore(s.db, s.box)
	providerID = strings.TrimSpace(providerID)
	modelID = strings.TrimSpace(modelID)
	if strings.HasPrefix(providerID, "speech:") {
		name := "语音"
		if providerID == CatalogSpeechAliyun {
			name = "阿里云语音"
		}
		if providerID == CatalogSpeechVolcengine {
			name = "豆包语音"
		}
		return &ClientPipelineEndpoint{
			ProviderID: providerID, ProviderName: name, ModelID: modelID, Source: "speech",
		}, nil
	}
	record, err := store.GetAIByID(ctx, providerID)
	if err != nil {
		return nil, err
	}
	apiKey, _ := store.DecryptAPIKey(record)
	return &ClientPipelineEndpoint{
		ProviderID: providerID, ProviderName: record.Name, ModelID: modelID,
		BaseURL: record.BaseURL, APIKey: apiKey, Source: "ai",
	}, nil
}
