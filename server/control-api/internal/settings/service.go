package settings

import (
	"context"
	"errors"
	"strings"
	"time"

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
			TargetID:    singletonID,
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
	_, volcErr := store.DecryptSecret(record)
	_, livekitErr := store.DecryptLiveKitSecret(record)
	return PublicRTCFrom(record, volcErr, livekitErr), nil
}

func (s *Service) PutRTC(ctx context.Context, actor users.User, requestID string, input RTCInput) (PublicRTC, error) {
	var public PublicRTC
	err := pgx.BeginFunc(ctx, s.db, func(tx pgx.Tx) error {
		store := NewStore(tx, s.box)
		record, err := store.PutRTC(ctx, actor, input)
		if err != nil {
			return err
		}
		_, volcErr := store.DecryptSecret(record)
		_, livekitErr := store.DecryptLiveKitSecret(record)
		public = PublicRTCFrom(record, volcErr, livekitErr)
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
		if strings.TrimSpace(input.TestProvider) != "" {
			input.ActiveProvider = strings.TrimSpace(input.TestProvider)
		}
		normalized, normErr := normalizeRTCInput(mergeRTCInput(*input, record, stored))
		if normErr != nil {
			return RTCTestResult{}, normErr
		}
		record.AppID = normalized.AppID
		record.Language = normalized.Language
		record.Mode = normalized.Mode
		record.TokenServiceURL = normalized.TokenServiceURL
		record.TrialRoomID = normalized.TrialRoomID
		record.TrialUserID = normalized.TrialUserID
		record.Enabled = true
		record.ActiveProvider = normalized.ActiveProvider
		record.LiveKitURL = normalized.LiveKitURL
		record.LiveKitAPIKey = normalized.LiveKitAPIKey
		record.LiveKitASRBaseURL = normalized.ASRBaseURL
		record.LiveKitASRModel = normalized.ASRModel
		if strings.TrimSpace(normalized.Secret) != "" {
			record.EncryptedSecret = []byte("pending")
		} else if stored {
			_, decryptErr = store.DecryptSecret(record)
		}
		if strings.TrimSpace(normalized.LiveKitAPISecret) != "" {
			record.EncryptedLiveKitAPISecret = []byte("pending")
		} else if stored {
			if _, livekitErr := store.DecryptLiveKitSecret(record); livekitErr != nil {
				decryptErr = livekitErr
			}
		}
		if normalized.TrialExpiresAt != "" {
			parsed, parseErr := time.Parse(time.RFC3339, normalized.TrialExpiresAt)
			if parseErr == nil {
				utc := parsed.UTC()
				record.TrialExpiresAt = &utc
			}
		}
		if strings.TrimSpace(normalized.TestProvider) == ProviderLiveKit || strings.TrimSpace(normalized.TestProvider) == ProviderVolcengine {
			record.ActiveProvider = strings.TrimSpace(normalized.TestProvider)
		}
	} else if !stored {
		return RTCTestResult{Message: "尚未配置 RTC"}, nil
	} else {
		_, decryptErr = store.DecryptSecret(record)
		if decryptErr == nil {
			_, decryptErr = store.DecryptLiveKitSecret(record)
		}
	}
	provider := record.ActiveProvider
	if provider == "" {
		provider = ProviderVolcengine
	}
	var result RTCTestResult
	if provider == ProviderLiveKit {
		if record.LiveKitURL == "" || record.LiveKitAPIKey == "" || len(record.EncryptedLiveKitAPISecret) == 0 || decryptErr != nil {
			result = ProbeRTC(record, decryptErr)
		} else {
			result = ProbeLiveKit(ctx, s.client, record.LiveKitURL)
		}
	} else {
		result = ProbeRTC(record, decryptErr)
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
