package settings

import (
	"context"
	"errors"

	"github.com/ai-interviewer/ai-powered/control-api/internal/audit"
	"github.com/ai-interviewer/ai-powered/control-api/internal/users"
	"github.com/jackc/pgx/v5"
)

type AgentSpeechSettings struct {
	Language                         string `json:"language"`
	AliyunAppKey                     string `json:"aliyunAppKey"`
	AliyunGateway                    string `json:"aliyunGateway"`
	AliyunAccessKeyID                string `json:"aliyunAccessKeyId,omitempty"`
	AliyunAccessKeySecret            string `json:"aliyunAccessKeySecret,omitempty"`
	AliyunToken                      string `json:"aliyunToken,omitempty"`
	AliyunASRCustomizationID         string `json:"aliyunAsrCustomizationId"`
	AliyunASRVocabularyID            string `json:"aliyunAsrVocabularyId"`
	AliyunASREnableITN               bool   `json:"aliyunAsrEnableItn"`
	AliyunASREnablePunc              bool   `json:"aliyunAsrEnablePunc"`
	AliyunASREnableDisfluency        bool   `json:"aliyunAsrEnableDisfluency"`
	AliyunASREnableIntermediate      bool   `json:"aliyunAsrEnableIntermediate"`
	AliyunASREnableSemanticBreak     bool   `json:"aliyunAsrEnableSemanticBreak"`
	AliyunASRMaxSentenceSilence      int    `json:"aliyunAsrMaxSentenceSilence"`
	AliyunASREnableVoiceDetection    bool   `json:"aliyunAsrEnableVoiceDetection"`
	AliyunASRMaxStartSilence         *int   `json:"aliyunAsrMaxStartSilence,omitempty"`
	AliyunASRMaxEndSilence           *int   `json:"aliyunAsrMaxEndSilence,omitempty"`
	ASRResourceID                    string `json:"asrResourceId"`
	ASREnableITN                     bool   `json:"asrEnableItn"`
	ASREnablePunc                    bool   `json:"asrEnablePunc"`
	ASRModelName                     string `json:"asrModelName"`
}

func AgentSpeechFrom(record SpeechRecord, rtcLanguage string, accessKeyID, accessKeySecret, token string) AgentSpeechSettings {
	language := rtcLanguage
	if language == "" {
		language = "zh"
	}
	return AgentSpeechSettings{
		Language:                      language,
		AliyunAppKey:                  record.AliyunAppKey,
		AliyunGateway:                 record.AliyunGateway,
		AliyunAccessKeyID:             accessKeyID,
		AliyunAccessKeySecret:         accessKeySecret,
		AliyunToken:                   token,
		AliyunASRCustomizationID:      record.AliyunASRCustomizationID,
		AliyunASRVocabularyID:         record.AliyunASRVocabularyID,
		AliyunASREnableITN:            record.AliyunASREnableITN,
		AliyunASREnablePunc:           record.AliyunASREnablePunc,
		AliyunASREnableDisfluency:     record.AliyunASREnableDisfluency,
		AliyunASREnableIntermediate:   record.AliyunASREnableIntermediate,
		AliyunASREnableSemanticBreak:  record.AliyunASREnableSemanticBreak,
		AliyunASRMaxSentenceSilence:   record.AliyunASRMaxSentenceSilence,
		AliyunASREnableVoiceDetection: record.AliyunASREnableVoiceDetection,
		AliyunASRMaxStartSilence:      record.AliyunASRMaxStartSilence,
		AliyunASRMaxEndSilence:        record.AliyunASRMaxEndSilence,
		ASRResourceID:                 record.ASRResourceID,
		ASREnableITN:                  record.ASREnableITN,
		ASREnablePunc:                 record.ASREnablePunc,
		ASRModelName:                  record.ASRModelName,
	}
}

func (s *Service) GetPipeline(ctx context.Context) (PublicPipeline, error) {
	store := NewStore(s.db, s.box)
	record, err := store.GetPipeline(ctx)
	if errors.Is(err, ErrNotConfigured) {
		return EmptyPublicPipeline(), nil
	}
	if err != nil {
		return PublicPipeline{}, err
	}
	return PublicPipelineFrom(record), nil
}

func (s *Service) PutPipeline(ctx context.Context, actor users.User, requestID string, input PipelineInput) (PublicPipeline, error) {
	var public PublicPipeline
	err := pgx.BeginFunc(ctx, s.db, func(tx pgx.Tx) error {
		store := NewStore(tx, s.box)
		record, err := store.PutPipeline(ctx, actor, input)
		if err != nil {
			return err
		}
		public = PublicPipelineFrom(record)
		return audit.NewStore(tx).Append(ctx, audit.Event{
			ActorUserID: actor.ID,
			Action:      audit.ActionPipelineSettingsUpdated,
			TargetType:  "pipeline_config",
			TargetID:    singletonID,
			Result:      audit.ResultSuccess,
			RequestID:   requestID,
			Metadata:    AuditMetadata(record.ConfigVersion, record.Enabled),
		})
	})
	return public, err
}

func (s *Service) GetAgentSpeech(ctx context.Context) (AgentSpeechSettings, error) {
	store := NewStore(s.db, s.box)
	record, err := store.GetSpeech(ctx)
	if errors.Is(err, ErrNotConfigured) {
		return AgentSpeechSettings{}, ErrNotConfigured
	}
	if err != nil {
		return AgentSpeechSettings{}, err
	}
	accessKeyID, idErr := store.DecryptAliyunAccessKeyID(record)
	accessKeySecret, secretErr := store.DecryptAliyunAccessKeySecret(record)
	token, tokenErr := store.DecryptAliyunToken(record)
	if err := firstDecryptErr(idErr, secretErr, tokenErr); err != nil {
		return AgentSpeechSettings{}, err
	}
	language := "zh"
	rtc, rtcErr := store.GetRTC(ctx)
	if rtcErr == nil && rtc.Language != "" {
		language = rtc.Language
	}
	return AgentSpeechFrom(record, language, accessKeyID, accessKeySecret, token), nil
}

func (s *Service) GetAgentPipeline(ctx context.Context) (AgentPipeline, error) {
	store := NewStore(s.db, s.box)
	record, err := store.GetPipeline(ctx)
	if errors.Is(err, ErrNotConfigured) {
		return AgentPipeline{
			Mode:        PipelineModeCascaded,
			E2EProvider: "tokenplan",
			CascadedASR: CascadedASRLiveKit,
			CascadedTTS: CascadedTTSAliyun,
			Enabled:     true,
		}, nil
	}
	if err != nil {
		return AgentPipeline{}, err
	}
	return AgentPipelineFrom(record), nil
}

func (s *Service) DeleteUserVoice(ctx context.Context, userID string) error {
	return NewStore(s.db, s.box).DeleteUserSpeechVoice(ctx, userID)
}
