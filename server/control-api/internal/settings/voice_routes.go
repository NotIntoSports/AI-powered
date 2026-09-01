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

type VoiceRoute struct {
	ID                string    `json:"id"`
	Name              string    `json:"name"`
	Mode              string    `json:"mode"`
	ASRProviderID     string    `json:"asrProviderId"`
	ASRModelID        string    `json:"asrModelId"`
	LLMProviderID     string    `json:"llmProviderId"`
	LLMModelID        string    `json:"llmModelId"`
	TTSProviderID     string    `json:"ttsProviderId"`
	TTSModelID        string    `json:"ttsModelId"`
	VoiceID           string    `json:"voiceId"`
	E2EProviderID     string    `json:"e2eProviderId"`
	E2EModelID        string    `json:"e2eModelId"`
	Active            bool      `json:"active"`
	Ready             bool      `json:"ready"`
	Status            string    `json:"status"`
	ConfigVersion     int       `json:"configVersion"`
	UpdatedAt         time.Time `json:"updatedAt"`
	UpdatedByUsername string    `json:"updatedByUsername,omitempty"`
}

type VoiceRouteInput struct {
	Name          string `json:"name"`
	Mode          string `json:"mode"`
	ASRProviderID string `json:"asrProviderId"`
	ASRModelID    string `json:"asrModelId"`
	LLMProviderID string `json:"llmProviderId"`
	LLMModelID    string `json:"llmModelId"`
	TTSProviderID string `json:"ttsProviderId"`
	TTSModelID    string `json:"ttsModelId"`
	VoiceID       string `json:"voiceId"`
	E2EProviderID string `json:"e2eProviderId"`
	E2EModelID    string `json:"e2eModelId"`
}

type AgentVoiceRoute struct {
	VoiceRoute
	Language string                  `json:"language"`
	ASR      *ClientPipelineEndpoint `json:"asr,omitempty"`
	LLM      *ClientPipelineEndpoint `json:"llm,omitempty"`
	TTS      *ClientPipelineEndpoint `json:"tts,omitempty"`
	E2E      *ClientPipelineEndpoint `json:"e2e,omitempty"`
	Speech   *AgentSpeechSettings    `json:"speech,omitempty"`
}

func normalizeVoiceRouteInput(input VoiceRouteInput) (VoiceRouteInput, error) {
	input.Name = strings.TrimSpace(input.Name)
	input.Mode = strings.TrimSpace(input.Mode)
	if input.Mode == "" {
		input.Mode = PipelineModeCascaded
	}
	if input.Name == "" || utf8.RuneCountInString(input.Name) > 100 {
		return VoiceRouteInput{}, ErrInvalidInput
	}
	fields := []*string{&input.ASRProviderID, &input.ASRModelID, &input.LLMProviderID, &input.LLMModelID, &input.TTSProviderID, &input.TTSModelID, &input.VoiceID, &input.E2EProviderID, &input.E2EModelID}
	for _, field := range fields {
		*field = strings.TrimSpace(*field)
		if utf8.RuneCountInString(*field) > 200 {
			return VoiceRouteInput{}, ErrInvalidInput
		}
	}
	switch input.Mode {
	case PipelineModeCascaded:
		if input.ASRProviderID == "" || input.ASRModelID == "" || input.LLMProviderID == "" || input.LLMModelID == "" || input.TTSProviderID == "" || input.TTSModelID == "" {
			return VoiceRouteInput{}, ErrInvalidInput
		}
		input.E2EProviderID, input.E2EModelID = "", ""
	case PipelineModeE2E:
		if input.E2EProviderID == "" || input.E2EModelID == "" {
			return VoiceRouteInput{}, ErrInvalidInput
		}
		input.ASRProviderID, input.ASRModelID, input.LLMProviderID, input.LLMModelID, input.TTSProviderID, input.TTSModelID = "", "", "", "", "", ""
	default:
		return VoiceRouteInput{}, ErrInvalidInput
	}
	return input, nil
}

func scanVoiceRoute(row pgx.Row) (VoiceRoute, error) {
	var route VoiceRoute
	err := row.Scan(&route.ID, &route.Name, &route.Mode, &route.ASRProviderID, &route.ASRModelID, &route.LLMProviderID, &route.LLMModelID, &route.TTSProviderID, &route.TTSModelID, &route.VoiceID, &route.E2EProviderID, &route.E2EModelID, &route.Active, &route.ConfigVersion, &route.UpdatedAt, &route.UpdatedByUsername)
	if errors.Is(err, pgx.ErrNoRows) {
		return VoiceRoute{}, ErrNotConfigured
	}
	if err != nil {
		return VoiceRoute{}, wrapStore(err)
	}
	return route, nil
}

const voiceRouteSelect = `select r.id,r.name,r.mode,r.asr_provider_id,r.asr_model_id,r.llm_provider_id,r.llm_model_id,r.tts_provider_id,r.tts_model_id,r.voice_id,r.e2e_provider_id,r.e2e_model_id,r.active,r.config_version,r.updated_at,coalesce(u.username,'') from voice_routes r left join users u on u.id=r.updated_by_user_id`

func (s *Service) ListVoiceRoutes(ctx context.Context) ([]VoiceRoute, error) {
	rows, err := s.db.Query(ctx, voiceRouteSelect+` order by r.active desc, lower(r.name)`)
	if err != nil {
		return nil, wrapStore(err)
	}
	defer rows.Close()
	routes := []VoiceRoute{}
	for rows.Next() {
		route, e := scanVoiceRoute(rows)
		if e != nil {
			return nil, e
		}
		s.markVoiceRouteReady(ctx, &route)
		routes = append(routes, route)
	}
	if rows.Err() != nil {
		return nil, wrapStore(rows.Err())
	}
	return routes, nil
}

func (s *Service) GetVoiceRoute(ctx context.Context, id string) (VoiceRoute, error) {
	route, err := scanVoiceRoute(s.db.QueryRow(ctx, voiceRouteSelect+` where r.id=$1`, strings.TrimSpace(id)))
	if err == nil {
		s.markVoiceRouteReady(ctx, &route)
	}
	return route, err
}

func (s *Service) CreateVoiceRoute(ctx context.Context, actor users.User, input VoiceRouteInput) (VoiceRoute, error) {
	n, err := normalizeVoiceRouteInput(input)
	if err != nil {
		return VoiceRoute{}, err
	}
	if err = s.validateVoiceRouteModels(ctx, n); err != nil {
		return VoiceRoute{}, err
	}
	now := time.Now().UTC().Truncate(time.Microsecond)
	id := uuid.NewString()
	_, err = s.db.Exec(ctx, `insert into voice_routes(id,name,mode,asr_provider_id,asr_model_id,llm_provider_id,llm_model_id,tts_provider_id,tts_model_id,voice_id,e2e_provider_id,e2e_model_id,active,config_version,updated_by_user_id,created_at,updated_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,false,1,$13,$14,$14)`, id, n.Name, n.Mode, n.ASRProviderID, n.ASRModelID, n.LLMProviderID, n.LLMModelID, n.TTSProviderID, n.TTSModelID, n.VoiceID, n.E2EProviderID, n.E2EModelID, actor.ID, now)
	if err != nil {
		return VoiceRoute{}, ErrStore
	}
	return s.GetVoiceRoute(ctx, id)
}

func (s *Service) UpdateVoiceRoute(ctx context.Context, actor users.User, id string, input VoiceRouteInput) (VoiceRoute, error) {
	n, err := normalizeVoiceRouteInput(input)
	if err != nil {
		return VoiceRoute{}, err
	}
	if err = s.validateVoiceRouteModels(ctx, n); err != nil {
		return VoiceRoute{}, err
	}
	tag, err := s.db.Exec(ctx, `update voice_routes set name=$1,mode=$2,asr_provider_id=$3,asr_model_id=$4,llm_provider_id=$5,llm_model_id=$6,tts_provider_id=$7,tts_model_id=$8,voice_id=$9,e2e_provider_id=$10,e2e_model_id=$11,config_version=config_version+1,updated_by_user_id=$12,updated_at=now() where id=$13`, n.Name, n.Mode, n.ASRProviderID, n.ASRModelID, n.LLMProviderID, n.LLMModelID, n.TTSProviderID, n.TTSModelID, n.VoiceID, n.E2EProviderID, n.E2EModelID, actor.ID, id)
	if err != nil {
		return VoiceRoute{}, ErrStore
	}
	if tag.RowsAffected() == 0 {
		return VoiceRoute{}, ErrNotConfigured
	}
	return s.GetVoiceRoute(ctx, id)
}

func (s *Service) DeleteVoiceRoute(ctx context.Context, id string) error {
	tag, err := s.db.Exec(ctx, `delete from voice_routes where id=$1 and not active`, strings.TrimSpace(id))
	if err != nil {
		return ErrStore
	}
	if tag.RowsAffected() == 0 {
		return ErrInvalidInput
	}
	return nil
}

func (s *Service) ActivateVoiceRoute(ctx context.Context, actor users.User, id string) (VoiceRoute, error) {
	route, err := s.GetVoiceRoute(ctx, id)
	if err != nil {
		return VoiceRoute{}, err
	}
	input := VoiceRouteInput{Name: route.Name, Mode: route.Mode, ASRProviderID: route.ASRProviderID, ASRModelID: route.ASRModelID, LLMProviderID: route.LLMProviderID, LLMModelID: route.LLMModelID, TTSProviderID: route.TTSProviderID, TTSModelID: route.TTSModelID, VoiceID: route.VoiceID, E2EProviderID: route.E2EProviderID, E2EModelID: route.E2EModelID}
	if err = s.validateVoiceRouteModels(ctx, input); err != nil {
		return VoiceRoute{}, err
	}
	err = pgx.BeginFunc(ctx, s.db, func(tx pgx.Tx) error {
		if _, e := tx.Exec(ctx, `lock table voice_routes in exclusive mode`); e != nil {
			return e
		}
		if _, e := tx.Exec(ctx, `update voice_routes set active=false where active`); e != nil {
			return e
		}
		tag, e := tx.Exec(ctx, `update voice_routes set active=true,config_version=config_version+1,updated_by_user_id=$1,updated_at=now() where id=$2`, actor.ID, id)
		if e != nil {
			return e
		}
		if tag.RowsAffected() != 1 {
			return ErrNotConfigured
		}
		return nil
	})
	if err != nil {
		return VoiceRoute{}, ErrStore
	}
	return s.GetVoiceRoute(ctx, id)
}

func (s *Service) GetAgentVoiceRoute(ctx context.Context) (AgentVoiceRoute, error) {
	route, err := scanVoiceRoute(s.db.QueryRow(ctx, voiceRouteSelect+` where r.active`))
	if err != nil {
		return AgentVoiceRoute{}, err
	}
	s.markVoiceRouteReady(ctx, &route)
	if !route.Ready {
		return AgentVoiceRoute{}, ErrModelNotVerified
	}
	out := AgentVoiceRoute{VoiceRoute: route}
	store := NewStore(s.db, s.box)
	if rtc, rtcErr := store.GetRTC(ctx); rtcErr == nil {
		out.Language = rtc.Language
	}
	if out.Language == "" {
		out.Language = "zh"
	}
	if route.Mode == PipelineModeE2E {
		out.E2E, err = s.resolvePipelineEndpoint(ctx, route.E2EProviderID, route.E2EModelID)
	} else {
		out.ASR, err = s.resolvePipelineEndpoint(ctx, route.ASRProviderID, route.ASRModelID)
		if err == nil {
			out.LLM, err = s.resolvePipelineEndpoint(ctx, route.LLMProviderID, route.LLMModelID)
		}
		if err == nil {
			out.TTS, err = s.resolvePipelineEndpoint(ctx, route.TTSProviderID, route.TTSModelID)
		}
		if err == nil && (strings.HasPrefix(route.ASRProviderID, "speech:") || strings.HasPrefix(route.TTSProviderID, "speech:")) {
			var speech AgentSpeechSettings
			speech, err = s.GetAgentSpeech(ctx)
			if err == nil {
				out.Speech = &speech
			}
		}
	}
	return out, err
}

func (s *Service) validateVoiceRouteModels(ctx context.Context, input VoiceRouteInput) error {
	checks := [][3]string{}
	if input.Mode == PipelineModeE2E {
		checks = append(checks, [3]string{input.E2EProviderID, input.E2EModelID, CapabilityE2E})
	} else {
		checks = append(checks, [3]string{input.ASRProviderID, input.ASRModelID, CapabilityASR}, [3]string{input.LLMProviderID, input.LLMModelID, CapabilityLLM}, [3]string{input.TTSProviderID, input.TTSModelID, CapabilityTTS})
	}
	store := NewStore(s.db, s.box)
	for _, c := range checks {
		model, err := store.GetCatalogModel(ctx, c[0], c[1])
		capabilityMatches := model.Capability == c[2]
		if c[2] == CapabilityE2E && model.RealtimeEnabled && model.RealtimeSupported {
			capabilityMatches = true
		}
		if err != nil || !model.Enabled || !capabilityMatches {
			return ErrModelNotVerified
		}
		if !strings.HasPrefix(c[0], "speech:") {
			provider, e := store.GetAIByID(ctx, c[0])
			if e != nil || !provider.Enabled {
				return ErrModelNotVerified
			}
			if IsTokenPlanPersonalBaseURL(provider.BaseURL) {
				ok, e := store.TokenPlanModelVerified(ctx, c[0], c[1])
				if e != nil || !ok {
					return ErrModelNotVerified
				}
			}
		}
	}
	return nil
}

func (s *Service) markVoiceRouteReady(ctx context.Context, route *VoiceRoute) {
	input := VoiceRouteInput{Name: route.Name, Mode: route.Mode, ASRProviderID: route.ASRProviderID, ASRModelID: route.ASRModelID, LLMProviderID: route.LLMProviderID, LLMModelID: route.LLMModelID, TTSProviderID: route.TTSProviderID, TTSModelID: route.TTSModelID, VoiceID: route.VoiceID, E2EProviderID: route.E2EProviderID, E2EModelID: route.E2EModelID}
	if s.validateVoiceRouteModels(ctx, input) == nil {
		route.Ready = true
		route.Status = "ready"
	} else {
		route.Status = "model_not_ready"
	}
}
