package settings

import (
	"context"
	"errors"
	"strings"

	"github.com/ai-interviewer/ai-powered/control-api/internal/audit"
	"github.com/ai-interviewer/ai-powered/control-api/internal/database"
	"github.com/ai-interviewer/ai-powered/control-api/internal/objectstore"
	"github.com/ai-interviewer/ai-powered/control-api/internal/secretbox"
	"github.com/ai-interviewer/ai-powered/control-api/internal/users"
	"github.com/jackc/pgx/v5"
)

type ObjectClient interface {
	ListBuckets(ctx context.Context, creds objectstore.Credentials) ([]objectstore.Bucket, error)
	HeadBucket(ctx context.Context, creds objectstore.Credentials) error
}

type Service struct {
	db      database.DBTX
	box     *secretbox.Box
	client  HTTPDoer
	objects ObjectClient
}

func NewService(db database.DBTX, box *secretbox.Box, client HTTPDoer) *Service {
	return &Service{db: db, box: box, client: client, objects: objectstore.NewCOS()}
}

func (s *Service) GetAI(ctx context.Context) (PublicAI, error) {
	store := NewStore(s.db, s.box)
	record, err := store.GetAI(ctx)
	if errors.Is(err, ErrNotConfigured) {
		return EmptyPublicAI(), nil
	}
	if err != nil {
		return PublicAI{}, err
	}
	_, decryptErr := store.DecryptAPIKey(record)
	return PublicAIFrom(record, decryptErr), nil
}

func (s *Service) GetClientAI(ctx context.Context) (ClientAI, error) {
	store := NewStore(s.db, s.box)
	record, err := store.GetAI(ctx)
	if errors.Is(err, ErrNotConfigured) {
		return ClientAI{PublicAI: EmptyPublicAI()}, nil
	}
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

func (s *Service) PutAI(ctx context.Context, actor users.User, requestID string, input AIInput) (PublicAI, error) {
	var public PublicAI
	err := pgx.BeginFunc(ctx, s.db, func(tx pgx.Tx) error {
		store := NewStore(tx, s.box)
		record, err := store.PutAI(ctx, actor, input)
		if err != nil {
			return err
		}
		_, decryptErr := store.DecryptAPIKey(record)
		public = PublicAIFrom(record, decryptErr)
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

func (s *Service) TestAI(ctx context.Context, actor users.User, requestID string, input *AIInput) (AITestResult, error) {
	store := NewStore(s.db, s.box)
	baseURL := ""
	model := ""
	apiKey := ""
	if input != nil {
		normalized, err := normalizeAIInput(*input)
		if err != nil {
			return AITestResult{}, err
		}
		baseURL = normalized.BaseURL
		model = normalized.Model
		apiKey = strings.TrimSpace(normalized.APIKey)
	}
	record, err := store.GetAI(ctx)
	if err != nil && !errors.Is(err, ErrNotConfigured) {
		return AITestResult{}, err
	}
	stored := err == nil
	if baseURL == "" {
		if !stored {
			return AITestResult{Message: "尚未配置模型"}, nil
		}
		baseURL = record.BaseURL
		model = record.Model
	}
	if apiKey == "" && stored {
		decrypted, decryptErr := store.DecryptAPIKey(record)
		if decryptErr != nil {
			return AITestResult{Message: "模型密钥无法解密"}, nil
		}
		apiKey = decrypted
	}
	result := ProbeAI(ctx, s.client, baseURL, apiKey, model)
	_ = audit.NewStore(s.db).Append(ctx, audit.Event{
		ActorUserID: actor.ID,
		Action:      audit.ActionAISettingsTested,
		TargetType:  "ai_provider_config",
		TargetID:    singletonID,
		Result:      audit.ResultSuccess,
		RequestID:   requestID,
		Metadata: map[string]any{
			"reachable":  result.Reachable,
			"modelFound": result.ModelFound,
		},
	})
	return result, nil
}

func (s *Service) GetClientASR(ctx context.Context) (ClientASR, error) {
	store := NewStore(s.db, s.box)
	language := "zh"
	rtc, rtcErr := store.GetRTC(ctx)
	if rtcErr != nil && !errors.Is(rtcErr, ErrNotConfigured) {
		return ClientASR{}, rtcErr
	}
	if rtcErr == nil && strings.TrimSpace(rtc.Language) != "" {
		language = strings.TrimSpace(rtc.Language)
	}
	if rtcErr == nil && strings.TrimSpace(rtc.LiveKitASRBaseURL) != "" {
		apiKey, decryptErr := store.DecryptASRAPIKey(rtc)
		baseURL := strings.TrimRight(strings.TrimSpace(rtc.LiveKitASRBaseURL), "/")
		model := strings.TrimSpace(rtc.LiveKitASRModel)
		if model == "" {
			model = "whisper-1"
		}
		available := isSecureEndpoint(baseURL) && decryptErr == nil && (apiKey != "" || isLocalEndpoint(baseURL))
		result := ClientASR{
			Configured: true,
			Available:  available,
			BaseURL:    baseURL,
			Model:      model,
			Language:   language,
			APIKey:     apiKey,
			Source:     "asr",
		}
		if decryptErr != nil {
			result.APIKey = ""
			result.Available = false
			return result, decryptErr
		}
		return result, nil
	}
	ai, err := s.GetClientAI(ctx)
	if err != nil {
		return ClientASR{}, err
	}
	if !ai.Configured {
		return ClientASR{Language: language}, nil
	}
	return ClientASR{
		Configured: ai.Configured,
		Available:  ai.Available,
		BaseURL:    ai.BaseURL,
		Model:      "whisper-1",
		Language:   language,
		APIKey:     ai.APIKey,
		Source:     "ai",
	}, nil
}

func (s *Service) GetRTC(ctx context.Context) (PublicRTC, error) {
	store := NewStore(s.db, s.box)
	record, err := store.GetRTC(ctx)
	if errors.Is(err, ErrNotConfigured) {
		return EmptyPublicRTC(), nil
	}
	if err != nil {
		return PublicRTC{}, err
	}
	_, livekitErr := store.DecryptLiveKitSecret(record)
	return PublicRTCFrom(record, livekitErr), nil
}

func (s *Service) PutRTC(ctx context.Context, actor users.User, requestID string, input RTCInput) (PublicRTC, error) {
	var public PublicRTC
	err := pgx.BeginFunc(ctx, s.db, func(tx pgx.Tx) error {
		store := NewStore(tx, s.box)
		record, err := store.PutRTC(ctx, actor, input)
		if err != nil {
			return err
		}
		_, livekitErr := store.DecryptLiveKitSecret(record)
		public = PublicRTCFrom(record, livekitErr)
		return audit.NewStore(tx).Append(ctx, audit.Event{
			ActorUserID: actor.ID,
			Action:      audit.ActionRTCSettingsUpdated,
			TargetType:  "rtc_config",
			TargetID:    singletonID,
			Result:      audit.ResultSuccess,
			RequestID:   requestID,
			Metadata:    AuditMetadata(record.ConfigVersion, public.Available),
		})
	})
	return public, err
}

func (s *Service) TestRTC(ctx context.Context, actor users.User, requestID string, input *RTCInput) (RTCTestResult, error) {
	store := NewStore(s.db, s.box)
	record, err := store.GetRTC(ctx)
	if err != nil && !errors.Is(err, ErrNotConfigured) {
		return RTCTestResult{}, err
	}
	stored := err == nil
	var decryptErr error
	if input != nil {
		normalized, normErr := normalizeRTCInput(mergeRTCInput(*input, record, stored))
		if normErr != nil {
			return RTCTestResult{}, normErr
		}
		record.Language = normalized.Language
		record.Enabled = true
		record.LiveKitURL = normalized.LiveKitURL
		record.LiveKitAPIKey = normalized.LiveKitAPIKey
		record.LiveKitASRBaseURL = normalized.ASRBaseURL
		record.LiveKitASRModel = normalized.ASRModel
		if strings.TrimSpace(normalized.LiveKitAPISecret) != "" {
			record.EncryptedLiveKitAPISecret = []byte("pending")
		} else if stored {
			_, decryptErr = store.DecryptLiveKitSecret(record)
		}
	} else if !stored {
		return RTCTestResult{Message: "尚未配置 LiveKit"}, nil
	} else {
		_, decryptErr = store.DecryptLiveKitSecret(record)
	}
	var result RTCTestResult
	if record.LiveKitURL == "" || record.LiveKitAPIKey == "" || len(record.EncryptedLiveKitAPISecret) == 0 || decryptErr != nil {
		result = ProbeRTC(record, decryptErr)
	} else {
		result = ProbeLiveKit(ctx, s.client, record.LiveKitURL)
	}
	_ = audit.NewStore(s.db).Append(ctx, audit.Event{
		ActorUserID: actor.ID,
		Action:      audit.ActionRTCSettingsTested,
		TargetType:  "rtc_config",
		TargetID:    singletonID,
		Result:      audit.ResultSuccess,
		RequestID:   requestID,
		Metadata: map[string]any{
			"reachable": result.Reachable,
			"provider":  result.Provider,
		},
	})
	return result, nil
}

func (s *Service) GetSpeech(ctx context.Context) (PublicSpeech, error) {
	store := NewStore(s.db, s.box)
	record, err := store.GetSpeech(ctx)
	if errors.Is(err, ErrNotConfigured) {
		return EmptyPublicSpeech(), nil
	}
	if err != nil {
		return PublicSpeech{}, err
	}
	_, apiErr := store.DecryptSpeechAPIKey(record)
	_, tokenErr := store.DecryptSpeechAccessToken(record)
	_, aliyunIDErr := store.DecryptAliyunAccessKeyID(record)
	_, aliyunSecretErr := store.DecryptAliyunAccessKeySecret(record)
	_, aliyunTokenErr := store.DecryptAliyunToken(record)
	return PublicSpeechFromErrs(record, firstDecryptErr(apiErr, tokenErr), firstDecryptErr(aliyunIDErr, aliyunSecretErr, aliyunTokenErr)), nil
}

func (s *Service) GetClientSpeech(ctx context.Context, userID string) (ClientSpeech, error) {
	store := NewStore(s.db, s.box)
	record, err := store.GetSpeech(ctx)
	if errors.Is(err, ErrNotConfigured) {
		return ClientSpeech{PublicSpeech: EmptyPublicSpeech()}, nil
	}
	if err != nil {
		return ClientSpeech{}, err
	}
	apiKey, apiErr := store.DecryptSpeechAPIKey(record)
	accessToken, tokenErr := store.DecryptSpeechAccessToken(record)
	accessKeyID, aliyunIDErr := store.DecryptAliyunAccessKeyID(record)
	accessKeySecret, aliyunSecretErr := store.DecryptAliyunAccessKeySecret(record)
	aliyunToken, aliyunTokenErr := store.DecryptAliyunToken(record)
	volcErr := firstDecryptErr(apiErr, tokenErr)
	aliyunErr := firstDecryptErr(aliyunIDErr, aliyunSecretErr, aliyunTokenErr)
	public := PublicSpeechFromErrs(record, volcErr, aliyunErr)
	allocation, allocationErr := store.GetUserSpeechAllocation(ctx, userID)
	if allocationErr != nil {
		return ClientSpeech{}, allocationErr
	}
	public.VoiceAllocationStatus = allocation.Status
	if userSpeaker, speakerErr := store.GetUserSpeechSpeakerID(ctx, userID); speakerErr != nil {
		return ClientSpeech{}, speakerErr
	} else if userSpeaker != "" {
		public.SpeakerID = userSpeaker
		if public.VolcengineAvailable {
			public.TTSAvailable = true
			if public.ActiveProvider == SpeechProviderVolcengine || public.ActiveProvider == "" {
				public.Available = true
				public.ASRAvailable = true
			}
		}
	}
	if volcErr != nil && aliyunErr != nil {
		return ClientSpeech{PublicSpeech: public}, firstDecryptErr(volcErr, aliyunErr)
	}
	client := ClientSpeech{PublicSpeech: public}
	if volcErr == nil {
		client.APIKey = apiKey
		client.AccessToken = accessToken
	}
	if aliyunErr == nil {
		client.AccessKeyID = accessKeyID
		client.AccessKeySecret = accessKeySecret
		client.AliyunToken = aliyunToken
	}
	return client, nil
}

func (s *Service) PutSpeech(ctx context.Context, actor users.User, requestID string, input SpeechInput) (PublicSpeech, error) {
	var public PublicSpeech
	err := pgx.BeginFunc(ctx, s.db, func(tx pgx.Tx) error {
		store := NewStore(tx, s.box)
		record, err := store.PutSpeech(ctx, actor, input)
		if err != nil {
			return err
		}
		_, apiErr := store.DecryptSpeechAPIKey(record)
		_, tokenErr := store.DecryptSpeechAccessToken(record)
		_, aliyunIDErr := store.DecryptAliyunAccessKeyID(record)
		_, aliyunSecretErr := store.DecryptAliyunAccessKeySecret(record)
		_, aliyunTokenErr := store.DecryptAliyunToken(record)
		public = PublicSpeechFromErrs(record, firstDecryptErr(apiErr, tokenErr), firstDecryptErr(aliyunIDErr, aliyunSecretErr, aliyunTokenErr))
		return audit.NewStore(tx).Append(ctx, audit.Event{
			ActorUserID: actor.ID,
			Action:      audit.ActionSpeechSettingsUpdated,
			TargetType:  "speech_config",
			TargetID:    singletonID,
			Result:      audit.ResultSuccess,
			RequestID:   requestID,
			Metadata:    AuditMetadata(record.ConfigVersion, public.Available),
		})
	})
	if err == nil {
		_ = s.SyncSpeechCatalog(ctx)
	}
	return public, err
}

func (s *Service) PutClientSpeechSpeakerID(ctx context.Context, userID, speakerID string) (PublicSpeech, error) {
	store := NewStore(s.db, s.box)
	if err := store.PutUserSpeechSpeakerID(ctx, userID, speakerID); err != nil {
		return PublicSpeech{}, err
	}
	client, err := s.GetClientSpeech(ctx, userID)
	if err != nil {
		return PublicSpeech{}, err
	}
	return client.PublicSpeech, nil
}

func (s *Service) ReserveClientSpeechVoice(ctx context.Context, userID string) (VoiceAllocation, error) {
	return NewStore(s.db, s.box).ReserveUserSpeechVoice(ctx, userID)
}

func (s *Service) CompleteClientSpeechVoice(ctx context.Context, userID, token, speakerID string) (PublicSpeech, error) {
	store := NewStore(s.db, s.box)
	if err := store.CompleteUserSpeechVoice(ctx, userID, token, speakerID); err != nil {
		return PublicSpeech{}, err
	}
	client, err := s.GetClientSpeech(ctx, userID)
	if err != nil {
		return PublicSpeech{}, err
	}
	return client.PublicSpeech, nil
}

func (s *Service) ReleaseClientSpeechVoice(ctx context.Context, userID, token string) (VoiceAllocation, error) {
	store := NewStore(s.db, s.box)
	if err := store.ReleaseUserSpeechVoice(ctx, userID, token); err != nil {
		return VoiceAllocation{}, err
	}
	return VoiceAllocation{Status: VoiceAllocationUnallocated}, nil
}

func (s *Service) ListUserSpeechVoices(ctx context.Context) (map[string]UserSpeechVoice, error) {
	return NewStore(s.db, s.box).ListUserSpeechVoices(ctx)
}

type speechCredentials struct {
	record       SpeechRecord
	stored       bool
	provider     string
	apiKey       string
	accessToken  string
	aliyunID     string
	aliyunSecret string
	aliyunToken  string
	volcErr      error
	aliyunErr    error
}

func (s *Service) resolveSpeechCredentials(ctx context.Context, input *SpeechInput) (speechCredentials, error) {
	store := NewStore(s.db, s.box)
	record, err := store.GetSpeech(ctx)
	out := speechCredentials{record: record, stored: err == nil, provider: record.ActiveProvider}
	if err != nil && !errors.Is(err, ErrNotConfigured) {
		return out, err
	}
	if out.stored {
		out.apiKey, out.volcErr = store.DecryptSpeechAPIKey(record)
		if out.volcErr == nil {
			out.accessToken, out.volcErr = store.DecryptSpeechAccessToken(record)
		}
		out.aliyunID, out.aliyunErr = store.DecryptAliyunAccessKeyID(record)
		if out.aliyunErr == nil {
			out.aliyunSecret, out.aliyunErr = store.DecryptAliyunAccessKeySecret(record)
		}
		if out.aliyunErr == nil {
			out.aliyunToken, out.aliyunErr = store.DecryptAliyunToken(record)
		}
	}
	if input == nil {
		return out, nil
	}
	normalized, normErr := normalizeSpeechInput(*input)
	if normErr != nil {
		return out, normErr
	}
	if normalized.AppID != "" {
		out.record.AppID = normalized.AppID
	}
	if normalized.SpeakerID != "" {
		out.record.SpeakerID = normalized.SpeakerID
	}
	if normalized.TTSResourceID != "" {
		out.record.TTSResourceID = normalized.TTSResourceID
	}
	if normalized.ASRResourceID != "" {
		out.record.ASRResourceID = normalized.ASRResourceID
	}
	if normalized.Enabled != nil {
		out.record.Enabled = *normalized.Enabled
	} else {
		out.record.Enabled = true
	}
	if normalized.ActiveProvider != "" {
		out.record.ActiveProvider = normalized.ActiveProvider
		out.provider = normalized.ActiveProvider
	}
	if normalized.AliyunAppKey != "" {
		out.record.AliyunAppKey = normalized.AliyunAppKey
	}
	if normalized.AliyunVoice != "" {
		out.record.AliyunVoice = normalized.AliyunVoice
	}
	if normalized.AliyunGateway != "" {
		out.record.AliyunGateway = normalized.AliyunGateway
	}
	if normalized.AliyunEnabled != nil {
		out.record.AliyunEnabled = *normalized.AliyunEnabled
	} else {
		out.record.AliyunEnabled = true
	}
	if strings.TrimSpace(normalized.APIKey) != "" {
		out.apiKey = strings.TrimSpace(normalized.APIKey)
		out.record.EncryptedAPIKey = []byte("pending")
		out.volcErr = nil
	}
	if strings.TrimSpace(normalized.AccessToken) != "" {
		out.accessToken = strings.TrimSpace(normalized.AccessToken)
		out.record.EncryptedAccessToken = []byte("pending")
		out.volcErr = nil
	}
	if strings.TrimSpace(normalized.AliyunAccessKeyID) != "" {
		out.aliyunID = strings.TrimSpace(normalized.AliyunAccessKeyID)
		out.record.EncryptedAliyunAccessKeyID = []byte("pending")
		out.aliyunErr = nil
	}
	if strings.TrimSpace(normalized.AliyunAccessKeySecret) != "" {
		out.aliyunSecret = strings.TrimSpace(normalized.AliyunAccessKeySecret)
		out.record.EncryptedAliyunAccessKeySecret = []byte("pending")
		out.aliyunErr = nil
	}
	if strings.TrimSpace(normalized.AliyunToken) != "" {
		out.aliyunToken = strings.TrimSpace(normalized.AliyunToken)
		out.record.EncryptedAliyunToken = []byte("pending")
		out.aliyunErr = nil
	}
	if normalized.TestProvider != "" {
		out.provider = normalized.TestProvider
	} else if normalized.ActiveProvider != "" {
		out.provider = normalized.ActiveProvider
	}
	return out, nil
}

func (s *Service) TestSpeech(ctx context.Context, actor users.User, requestID string, input *SpeechInput) (SpeechTestResult, error) {
	creds, err := s.resolveSpeechCredentials(ctx, input)
	if err != nil {
		return SpeechTestResult{}, err
	}
	if !creds.stored && input == nil {
		return SpeechTestResult{Message: "尚未配置语音"}, nil
	}
	result := ProbeSpeechLine(ctx, s.client, creds.record, creds.provider, creds.apiKey, creds.accessToken, creds.aliyunID, creds.aliyunSecret, creds.aliyunToken, creds.volcErr, creds.aliyunErr)
	_ = audit.NewStore(s.db).Append(ctx, audit.Event{
		ActorUserID: actor.ID,
		Action:      audit.ActionSpeechSettingsTested,
		TargetType:  "speech_config",
		TargetID:    singletonID,
		Result:      audit.ResultSuccess,
		RequestID:   requestID,
		Metadata:    map[string]any{"reachable": result.Reachable, "provider": result.Provider},
	})
	return result, nil
}

func (s *Service) DiscoverModels(ctx context.Context, baseURL, apiKey string) ([]DiscoveredModel, error) {
	baseURL = strings.TrimRight(baseURL, "/")
	providerID := ""
	store := NewStore(s.db, s.box)
	providers, _ := store.ListAIProviders(ctx)
	for _, p := range providers {
		if strings.TrimRight(p.BaseURL, "/") == baseURL {
			providerID = p.ID
			break
		}
	}
	return s.DiscoverModelsForProvider(ctx, providerID, baseURL, apiKey)
}

func (s *Service) ListDiscoveredModels(ctx context.Context, baseURL string) ([]DiscoveredModel, error) {
	return NewStore(s.db, s.box).ListDiscoveredModels(ctx, baseURL)
}

func (s *Service) SetModelEnabled(ctx context.Context, baseURL, modelID string, enabled bool) error {
	return NewStore(s.db, s.box).SetModelEnabled(ctx, baseURL, modelID, enabled)
}

func (s *Service) GetEnabledModels(ctx context.Context, baseURL string) ([]string, error) {
	return NewStore(s.db, s.box).GetEnabledModels(ctx, baseURL)
}

func firstDecryptErr(errs ...error) error {
	for _, err := range errs {
		if err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) GetStorage(ctx context.Context) (PublicStorage, error) {
	store := NewStore(s.db, s.box)
	record, err := store.GetStorage(ctx)
	if errors.Is(err, ErrNotConfigured) {
		return EmptyPublicStorage(), nil
	}
	if err != nil {
		return PublicStorage{}, err
	}
	_, decryptErr := store.DecryptSecretKey(record)
	return PublicStorageFrom(record, decryptErr), nil
}

func (s *Service) PutStorage(ctx context.Context, actor users.User, requestID string, input StorageInput) (PublicStorage, error) {
	var public PublicStorage
	err := pgx.BeginFunc(ctx, s.db, func(tx pgx.Tx) error {
		store := NewStore(tx, s.box)
		record, err := store.PutStorage(ctx, actor, input)
		if err != nil {
			return err
		}
		_, decryptErr := store.DecryptSecretKey(record)
		public = PublicStorageFrom(record, decryptErr)
		return audit.NewStore(tx).Append(ctx, audit.Event{
			ActorUserID: actor.ID,
			Action:      audit.ActionStorageSettingsUpdated,
			TargetType:  "object_storage_config",
			TargetID:    singletonID,
			Result:      audit.ResultSuccess,
			RequestID:   requestID,
			Metadata:    AuditMetadata(record.ConfigVersion, public.Available),
		})
	})
	return public, err
}

func (s *Service) TestStorage(ctx context.Context, actor users.User, requestID string, input *StorageInput) (StorageTestResult, error) {
	store := NewStore(s.db, s.box)
	creds, message := s.storageCredentials(ctx, store, input)
	if creds.SecretID == "" {
		return StorageTestResult{Message: message}, nil
	}
	objects := s.objects
	if objects == nil {
		objects = objectstore.NewCOS()
	}
	buckets, err := objects.ListBuckets(ctx, creds)
	if err != nil {
		_ = audit.NewStore(s.db).Append(ctx, audit.Event{
			ActorUserID: actor.ID,
			Action:      audit.ActionStorageSettingsTested,
			TargetType:  "object_storage_config",
			TargetID:    singletonID,
			Result:      audit.ResultSuccess,
			RequestID:   requestID,
			Metadata:    map[string]any{"reachable": false},
		})
		return StorageTestResult{Message: "无法连接腾讯云 COS"}, nil
	}
	publicBuckets := make([]Bucket, 0, len(buckets))
	for _, bucket := range buckets {
		publicBuckets = append(publicBuckets, Bucket{Name: bucket.Name, Region: bucket.Region})
	}
	result := StorageTestResult{
		Reachable: true,
		Message:   "已连接腾讯云 COS",
		Buckets:   publicBuckets,
	}
	if creds.Bucket != "" && creds.Region != "" {
		if headErr := objects.HeadBucket(ctx, creds); headErr != nil {
			result.Message = "账号可用，但当前 Bucket 无法访问"
		} else {
			result.Message = "Bucket 可访问"
		}
	} else if len(publicBuckets) == 0 {
		result.Message = "账号可用，但还没有存储桶。请在腾讯云创建 COS Bucket 后填入名称和地域。"
	} else {
		result.Message = "账号可用。请选择一个 Bucket 并保存。"
	}
	_ = audit.NewStore(s.db).Append(ctx, audit.Event{
		ActorUserID: actor.ID,
		Action:      audit.ActionStorageSettingsTested,
		TargetType:  "object_storage_config",
		TargetID:    singletonID,
		Result:      audit.ResultSuccess,
		RequestID:   requestID,
		Metadata:    map[string]any{"reachable": result.Reachable, "bucketCount": len(publicBuckets)},
	})
	return result, nil
}

func (s *Service) storageCredentials(ctx context.Context, store *Store, input *StorageInput) (objectstore.Credentials, string) {
	record, err := store.GetStorage(ctx)
	stored := err == nil
	if err != nil && !errors.Is(err, ErrNotConfigured) {
		return objectstore.Credentials{}, "对象存储配置不可用"
	}
	creds := objectstore.Credentials{}
	if stored {
		creds.SecretID = record.SecretID
		creds.Region = record.Region
		creds.Bucket = record.Bucket
		secretKey, decryptErr := store.DecryptSecretKey(record)
		if decryptErr != nil {
			return objectstore.Credentials{}, "对象存储密钥无法解密"
		}
		creds.SecretKey = secretKey
	}
	if input != nil {
		normalized, normErr := normalizeStorageInput(*input)
		if normErr != nil {
			return objectstore.Credentials{}, "对象存储配置无效"
		}
		if normalized.SecretID != "" {
			creds.SecretID = normalized.SecretID
		}
		if normalized.Region != "" {
			creds.Region = normalized.Region
		}
		if normalized.Bucket != "" {
			creds.Bucket = normalized.Bucket
		}
		if strings.TrimSpace(normalized.SecretKey) != "" {
			creds.SecretKey = strings.TrimSpace(normalized.SecretKey)
		}
	}
	if creds.SecretID == "" || creds.SecretKey == "" {
		return objectstore.Credentials{}, "尚未配置腾讯云密钥"
	}
	return creds, ""
}
