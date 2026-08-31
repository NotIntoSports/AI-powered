package settings

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"html"
	"io"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const TokenPlanPersonalCatalogURL = "https://help.aliyun.com/zh/model-studio/token-plan-personal-overview"
const TokenPlanPersonalBaseURL = "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"

var (
	tokenPlanModelPattern   = regexp.MustCompile(`(?i)\b(?:qwen[\w.-]+|wan[\w.-]+|deepseek[\w.-]+|glm-[\w.-]+|happyhorse-[\w.-]+)\b`)
	tokenPlanTagPattern     = regexp.MustCompile(`<[^>]+>`)
	tokenPlanUpdatedPattern = regexp.MustCompile(`(?i)(?:更新时间|更新日期|last\s+updated)[^0-9]{0,30}([0-9]{4}[-/.年][0-9]{1,2}[-/.月][0-9]{1,2}日?)`)
)

type OfficialTokenPlanModel struct {
	ModelID    string `json:"modelId"`
	Capability string `json:"capability"`
	Protocol   string `json:"protocol"`
}

type OfficialCatalogSyncResult struct {
	Models          int        `json:"models"`
	SourceURL       string     `json:"sourceUrl"`
	SourceUpdatedAt string     `json:"sourceUpdatedAt,omitempty"`
	ContentHash     string     `json:"contentHash"`
	LastSuccessAt   *time.Time `json:"lastSuccessAt,omitempty"`
	Warning         string     `json:"warning,omitempty"`
}

type ModelVerificationResult struct {
	ModelID    string `json:"modelId"`
	Capability string `json:"capability"`
	Protocol   string `json:"protocol"`
	Status     string `json:"status"`
	Message    string `json:"message"`
}

func tokenPlanCapability(id string) (string, string) {
	lower := strings.ToLower(id)
	switch {
	case strings.Contains(lower, "realtime"):
		return CapabilityE2E, "realtime"
	case strings.Contains(lower, "-asr-"):
		return CapabilityASR, "asr"
	case strings.Contains(lower, "-tts-"):
		return CapabilityTTS, "tts"
	case strings.Contains(lower, "image"):
		return "image", "image-generation"
	case strings.Contains(lower, "t2v"), strings.Contains(lower, "i2v"), strings.Contains(lower, "r2v"):
		return "video", "video-generation"
	default:
		return CapabilityLLM, "chat-completions"
	}
}

func ParseTokenPlanPersonalCatalog(reader io.Reader) ([]OfficialTokenPlanModel, string, error) {
	raw, err := io.ReadAll(io.LimitReader(reader, 4<<20))
	if err != nil {
		return nil, "", err
	}
	content := html.UnescapeString(string(raw))
	start := strings.Index(content, "支持的模型")
	if start < 0 {
		return nil, "", errors.New("token plan supported-model section not found")
	}
	section := content[start:]
	if end := strings.Index(section, "</table>"); end >= 0 {
		section = section[:end+len("</table>")]
	} else {
		return nil, "", errors.New("token plan supported-model table not found")
	}
	plain := tokenPlanTagPattern.ReplaceAllString(section, " ")
	seen := map[string]OfficialTokenPlanModel{}
	for _, match := range tokenPlanModelPattern.FindAllString(plain, -1) {
		id := strings.ToLower(strings.TrimSpace(match))
		capability, protocol := tokenPlanCapability(id)
		seen[id] = OfficialTokenPlanModel{ModelID: id, Capability: capability, Protocol: protocol}
	}
	if len(seen) == 0 {
		return nil, "", errors.New("token plan supported-model table is empty")
	}
	models := make([]OfficialTokenPlanModel, 0, len(seen))
	for _, model := range seen {
		models = append(models, model)
	}
	sort.Slice(models, func(i, j int) bool { return models[i].ModelID < models[j].ModelID })
	updated := ""
	if match := tokenPlanUpdatedPattern.FindStringSubmatch(content); len(match) > 1 {
		updated = match[1]
	}
	return models, updated, nil
}

func (s *Service) SyncOfficialTokenPlanCatalog(ctx context.Context) (OfficialCatalogSyncResult, error) {
	store := NewStore(s.db, s.box)
	fail := func(message string) (OfficialCatalogSyncResult, error) {
		_ = store.RecordOfficialTokenPlanCatalogFailure(ctx, message, time.Now().UTC())
		return OfficialCatalogSyncResult{}, ErrOfficialCatalogUnavailable
	}
	client := s.client
	if client == nil {
		client = &http.Client{Timeout: 15 * time.Second}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, TokenPlanPersonalCatalogURL, nil)
	if err != nil {
		return fail("无法创建官方目录请求")
	}
	resp, err := client.Do(req)
	if err != nil {
		return fail("官方页面请求失败或超时")
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fail("官方页面返回非成功状态")
	}
	models, updated, err := ParseTokenPlanPersonalCatalog(resp.Body)
	if err != nil {
		return fail("官方页面结构变化或支持模型表为空")
	}
	hashInput := make([]string, 0, len(models))
	for _, model := range models {
		hashInput = append(hashInput, model.ModelID+":"+model.Capability+":"+model.Protocol)
	}
	sum := sha256.Sum256([]byte(strings.Join(hashInput, "\n")))
	hash := hex.EncodeToString(sum[:])
	now := time.Now().UTC()
	if err := store.ReplaceOfficialTokenPlanCatalog(ctx, models, updated, hash, now); err != nil {
		return OfficialCatalogSyncResult{}, err
	}
	return OfficialCatalogSyncResult{Models: len(models), SourceURL: TokenPlanPersonalCatalogURL, SourceUpdatedAt: updated, ContentHash: hash, LastSuccessAt: &now}, nil
}

func (s *Store) RecordOfficialTokenPlanCatalogFailure(ctx context.Context, warning string, attemptedAt time.Time) error {
	_, err := s.db.Exec(ctx, `insert into token_plan_catalog_sync(id,source_url,last_attempt_at,warning) values('personal',$1,$2,$3) on conflict(id) do update set last_attempt_at=excluded.last_attempt_at, warning=excluded.warning`, TokenPlanPersonalCatalogURL, attemptedAt, warning)
	if err != nil {
		return ErrStore
	}
	return nil
}

func (s *Store) GetOfficialTokenPlanModel(ctx context.Context, modelID string) (OfficialTokenPlanModel, error) {
	modelID = strings.TrimSpace(modelID)
	if modelID == "" {
		return OfficialTokenPlanModel{}, ErrInvalidInput
	}
	var model OfficialTokenPlanModel
	err := s.db.QueryRow(ctx, `select model_id, capability, protocol from token_plan_official_models where model_id=$1`, modelID).Scan(&model.ModelID, &model.Capability, &model.Protocol)
	if errors.Is(err, pgx.ErrNoRows) {
		return OfficialTokenPlanModel{}, ErrNotConfigured
	}
	if err != nil {
		return OfficialTokenPlanModel{}, wrapStore(err)
	}
	return model, nil
}

func IsTokenPlanPersonalBaseURL(baseURL string) bool {
	return strings.EqualFold(strings.TrimRight(strings.TrimSpace(baseURL), "/"), TokenPlanPersonalBaseURL)
}

func (s *Store) ReplaceOfficialTokenPlanCatalog(ctx context.Context, models []OfficialTokenPlanModel, sourceUpdated, hash string, syncedAt time.Time) error {
	return pgx.BeginFunc(ctx, s.db, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `delete from token_plan_official_models`); err != nil {
			return ErrStore
		}
		for _, model := range models {
			if _, err := tx.Exec(ctx, `insert into token_plan_official_models (model_id, capability, protocol, source_url, source_updated_at, content_hash, synced_at) values ($1,$2,$3,$4,$5,$6,$7)`, model.ModelID, model.Capability, model.Protocol, TokenPlanPersonalCatalogURL, sourceUpdated, hash, syncedAt); err != nil {
				return ErrStore
			}
		}
		if _, err := tx.Exec(ctx, `insert into token_plan_catalog_sync (id, source_url, source_updated_at, content_hash, last_attempt_at, last_success_at, warning) values ('personal',$1,$2,$3,$4,$4,'') on conflict (id) do update set source_url=excluded.source_url, source_updated_at=excluded.source_updated_at, content_hash=excluded.content_hash, last_attempt_at=excluded.last_attempt_at, last_success_at=excluded.last_success_at, warning=''`, TokenPlanPersonalCatalogURL, sourceUpdated, hash, syncedAt); err != nil {
			return ErrStore
		}
		return nil
	})
}

func (s *Store) ListTokenPlanProviderModels(ctx context.Context, providerID, baseURL string) ([]DiscoveredModel, error) {
	discovered, err := s.ListDiscoveredModels(ctx, baseURL)
	if err != nil {
		return nil, err
	}
	byID := make(map[string]DiscoveredModel, len(discovered))
	for _, model := range discovered {
		model.KeyDiscovered = true
		if model.VerificationStatus == "" {
			model.VerificationStatus = "untested"
		}
		byID[model.ModelID] = model
	}
	rows, err := s.db.Query(ctx, `select o.model_id, o.capability, o.protocol, o.synced_at, coalesce(st.key_discovered,false), coalesce(st.verification_status,'untested'), coalesce(st.verification_message,''), st.verified_at from token_plan_official_models o left join token_plan_model_status st on st.provider_id=$1 and st.model_id=o.model_id order by o.model_id`, providerID)
	if err != nil {
		return nil, wrapStore(err)
	}
	defer rows.Close()
	for rows.Next() {
		var id, capability, protocol, verification, message string
		var synced time.Time
		var keyDiscovered bool
		var verifiedAt *time.Time
		if err := rows.Scan(&id, &capability, &protocol, &synced, &keyDiscovered, &verification, &message, &verifiedAt); err != nil {
			return nil, wrapStore(err)
		}
		model, ok := byID[id]
		if !ok {
			model = DiscoveredModel{ID: "official:" + id, ProviderID: providerID, ModelID: id, BaseURL: baseURL, Enabled: false, DiscoveredAt: synced, UpdatedAt: synced}
		}
		model.OfficialSupported, model.Capability, model.Protocol, model.OfficialSyncedAt = true, capability, protocol, &synced
		model.KeyDiscovered, model.VerificationStatus, model.VerificationMessage, model.VerifiedAt = keyDiscovered, verification, message, verifiedAt
		byID[id] = model
	}
	if err := rows.Err(); err != nil {
		return nil, wrapStore(err)
	}
	out := make([]DiscoveredModel, 0, len(byID))
	for _, model := range byID {
		out = append(out, model)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ModelID < out[j].ModelID })
	return out, nil
}

func (s *Store) MarkTokenPlanKeyDiscovery(ctx context.Context, providerID string, modelIDs []string) error {
	if _, err := s.db.Exec(ctx, `update token_plan_model_status set key_discovered=false where provider_id=$1`, providerID); err != nil {
		return ErrStore
	}
	for _, id := range modelIDs {
		if _, err := s.db.Exec(ctx, `insert into token_plan_model_status(provider_id,model_id,key_discovered) values($1,$2,true) on conflict(provider_id,model_id) do update set key_discovered=true`, providerID, id); err != nil {
			return ErrStore
		}
	}
	return nil
}

func (s *Store) SetTokenPlanVerification(ctx context.Context, providerID, modelID, status, message string) error {
	_, err := s.db.Exec(ctx, `insert into token_plan_model_status(provider_id,model_id,verification_status,verification_message,verified_at) values($1,$2,$3,$4,now()) on conflict(provider_id,model_id) do update set verification_status=excluded.verification_status, verification_message=excluded.verification_message, verified_at=excluded.verified_at`, providerID, modelID, status, message)
	if err != nil {
		return ErrStore
	}
	return nil
}

func (s *Store) TokenPlanModelVerified(ctx context.Context, providerID, modelID string) (bool, error) {
	var official bool
	var protocol, verification string
	err := s.db.QueryRow(ctx, `
		select
			exists(select 1 from token_plan_official_models where model_id=$2),
			coalesce((select protocol from token_plan_official_models where model_id=$2), ''),
			coalesce((select verification_status from token_plan_model_status where provider_id=$1 and model_id=$2), 'untested')
	`, providerID, modelID).Scan(&official, &protocol, &verification)
	if err != nil {
		return false, wrapStore(err)
	}
	if !official {
		return false, nil
	}
	if tokenPlanDedicatedProtocol(protocol) {
		return true, nil
	}
	return verification == "success", nil
}

func (s *Service) VerifyTokenPlanModel(ctx context.Context, providerID, modelID string) (ModelVerificationResult, error) {
	store := NewStore(s.db, s.box)
	provider, err := store.GetAIByID(ctx, providerID)
	if err != nil {
		return ModelVerificationResult{}, err
	}
	if !IsTokenPlanPersonalBaseURL(provider.BaseURL) {
		return ModelVerificationResult{}, ErrInvalidInput
	}
	var capability, protocol string
	if err := s.db.QueryRow(ctx, `select capability, protocol from token_plan_official_models where model_id=$1`, modelID).Scan(&capability, &protocol); err != nil {
		if err == pgx.ErrNoRows {
			return ModelVerificationResult{}, ErrNotConfigured
		}
		return ModelVerificationResult{}, ErrStore
	}
	result := ModelVerificationResult{ModelID: modelID, Capability: capability, Protocol: protocol}
	if protocol != "chat-completions" {
		result.Status = "unsupported"
		result.Message = "该能力需要专用的 " + protocol + " 调用流程，当前管理端不会用 Chat Completions 误测或产生媒体调用费用"
		_ = store.SetTokenPlanVerification(ctx, providerID, modelID, result.Status, result.Message)
		return result, nil
	}
	apiKey, err := store.DecryptAPIKey(provider)
	if err != nil {
		return ModelVerificationResult{}, err
	}
	payload, _ := json.Marshal(map[string]any{"model": modelID, "messages": []map[string]string{{"role": "user", "content": "Reply OK."}}, "max_tokens": 2})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(provider.BaseURL, "/")+"/chat/completions", strings.NewReader(string(payload)))
	if err != nil {
		return ModelVerificationResult{}, ErrInvalidInput
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("Content-Type", "application/json")
	client := s.client
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	resp, callErr := client.Do(req)
	if callErr != nil {
		result.Status, result.Message = "failed", "模型调用失败或超时"
	} else {
		defer resp.Body.Close()
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))
		switch resp.StatusCode {
		case http.StatusOK:
			result.Status, result.Message = "success", "本人实测调用成功"
		case http.StatusUnauthorized:
			result.Status, result.Message = "failed", "401：Token Plan Key 无效或 Base URL 不匹配"
		case http.StatusForbidden:
			result.Status, result.Message = "failed", "403：该 Key 无权调用此模型"
		case http.StatusNotFound:
			result.Status, result.Message = "failed", "404：模型或调用协议不可用"
		case http.StatusTooManyRequests:
			result.Status, result.Message = "failed", "额度不足或请求受限"
		default:
			result.Status, result.Message = "failed", "模型调用失败（HTTP "+resp.Status+"）"
		}
	}
	if err := store.SetTokenPlanVerification(ctx, providerID, modelID, result.Status, result.Message); err != nil {
		return ModelVerificationResult{}, err
	}
	return result, nil
}
