package settings

import (
	"context"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/ai-interviewer/ai-powered/control-api/internal/users"
	"github.com/jackc/pgx/v5"
)

const (
	PipelineModeCascaded = "cascaded"
	PipelineModeE2E      = "e2e"
	CascadedASRLiveKit   = "livekit-agent"
	CascadedTTSAliyun    = "speech:aliyun"
	CascadedTTSVolc      = "speech:volcengine"
)

type PipelineRecord struct {
	Mode              string
	E2EProvider       string
	CascadedASR       string
	CascadedTTS       string
	Enabled           bool
	ConfigVersion     int
	UpdatedByUserID   string
	UpdatedByUsername string
	CreatedAt         time.Time
	UpdatedAt         time.Time
}

type PipelineInput struct {
	Mode        string
	E2EProvider string
	CascadedTTS string
	Enabled     *bool
}

type PublicPipeline struct {
	Configured        bool       `json:"configured"`
	Mode              string     `json:"mode"`
	E2EProvider       string     `json:"e2eProvider"`
	CascadedASR       string     `json:"cascadedAsr"`
	CascadedTTS       string     `json:"cascadedTts"`
	Enabled           bool       `json:"enabled"`
	ConfigVersion     int        `json:"configVersion"`
	UpdatedAt         *time.Time `json:"updatedAt,omitempty"`
	UpdatedByUsername string     `json:"updatedByUsername,omitempty"`
}

type AgentPipeline struct {
	Mode        string `json:"mode"`
	E2EProvider string `json:"e2eProvider"`
	CascadedASR string `json:"cascadedAsr"`
	CascadedTTS string `json:"cascadedTts"`
	Enabled     bool   `json:"enabled"`
}

func (s *Store) GetPipeline(ctx context.Context) (PipelineRecord, error) {
	record := PipelineRecord{}
	err := s.db.QueryRow(ctx, `
		select
			c.mode, c.e2e_provider, c.cascaded_asr, c.cascaded_tts, c.enabled,
			c.config_version, coalesce(c.updated_by_user_id, ''), coalesce(u.username, ''),
			c.created_at, c.updated_at
		from pipeline_configs as c
		left join users as u on u.id = c.updated_by_user_id
		where c.id = $1
	`, singletonID).Scan(
		&record.Mode,
		&record.E2EProvider,
		&record.CascadedASR,
		&record.CascadedTTS,
		&record.Enabled,
		&record.ConfigVersion,
		&record.UpdatedByUserID,
		&record.UpdatedByUsername,
		&record.CreatedAt,
		&record.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return PipelineRecord{}, ErrNotConfigured
	}
	if err != nil {
		return PipelineRecord{}, ErrStore
	}
	return record, nil
}

func (s *Store) PutPipeline(ctx context.Context, actor users.User, input PipelineInput) (PipelineRecord, error) {
	normalized, err := normalizePipelineInput(input)
	if err != nil {
		return PipelineRecord{}, err
	}
	current, currentErr := s.GetPipeline(ctx)
	if currentErr != nil && !errors.Is(currentErr, ErrNotConfigured) {
		return PipelineRecord{}, currentErr
	}
	enabled := true
	if normalized.Enabled != nil {
		enabled = *normalized.Enabled
	} else if currentErr == nil {
		enabled = current.Enabled
	}
	now := time.Now().UTC().Truncate(time.Microsecond)
	configVersion := 1
	if currentErr == nil {
		configVersion = current.ConfigVersion + 1
	}
	_, err = s.db.Exec(ctx, `
		insert into pipeline_configs (
			id, mode, e2e_provider, cascaded_asr, cascaded_tts, enabled,
			config_version, updated_by_user_id, created_at, updated_at
		) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
		on conflict (id) do update set
			mode = excluded.mode,
			e2e_provider = excluded.e2e_provider,
			cascaded_asr = excluded.cascaded_asr,
			cascaded_tts = excluded.cascaded_tts,
			enabled = excluded.enabled,
			config_version = excluded.config_version,
			updated_by_user_id = excluded.updated_by_user_id,
			updated_at = excluded.updated_at
	`, singletonID, normalized.Mode, normalized.E2EProvider, CascadedASRLiveKit,
		normalized.CascadedTTS, enabled, configVersion, actor.ID, now)
	if err != nil {
		return PipelineRecord{}, ErrStore
	}
	return s.GetPipeline(ctx)
}

func PublicPipelineFrom(record PipelineRecord) PublicPipeline {
	updated := record.UpdatedAt
	return PublicPipeline{
		Configured:        true,
		Mode:              record.Mode,
		E2EProvider:       record.E2EProvider,
		CascadedASR:       record.CascadedASR,
		CascadedTTS:       record.CascadedTTS,
		Enabled:           record.Enabled,
		ConfigVersion:     record.ConfigVersion,
		UpdatedAt:         &updated,
		UpdatedByUsername: record.UpdatedByUsername,
	}
}

func EmptyPublicPipeline() PublicPipeline {
	return PublicPipeline{
		Mode:        PipelineModeCascaded,
		E2EProvider: "tokenplan",
		CascadedASR: CascadedASRLiveKit,
		CascadedTTS: CascadedTTSAliyun,
		Enabled:     true,
	}
}

func AgentPipelineFrom(record PipelineRecord) AgentPipeline {
	return AgentPipeline{
		Mode:        record.Mode,
		E2EProvider: record.E2EProvider,
		CascadedASR: record.CascadedASR,
		CascadedTTS: record.CascadedTTS,
		Enabled:     record.Enabled,
	}
}

func normalizePipelineInput(input PipelineInput) (PipelineInput, error) {
	mode := strings.TrimSpace(input.Mode)
	if mode == "" {
		mode = PipelineModeCascaded
	}
	if mode != PipelineModeCascaded && mode != PipelineModeE2E {
		return PipelineInput{}, ErrInvalidInput
	}
	e2eProvider := strings.TrimSpace(input.E2EProvider)
	if e2eProvider == "" {
		e2eProvider = "tokenplan"
	}
	if utf8.RuneCountInString(e2eProvider) > 64 {
		return PipelineInput{}, ErrInvalidInput
	}
	cascadedTTS := strings.TrimSpace(input.CascadedTTS)
	if cascadedTTS == "" {
		cascadedTTS = CascadedTTSAliyun
	}
	if cascadedTTS != CascadedTTSAliyun && cascadedTTS != CascadedTTSVolc {
		return PipelineInput{}, ErrInvalidInput
	}
	input.Mode = mode
	input.E2EProvider = e2eProvider
	input.CascadedTTS = cascadedTTS
	return input, nil
}
