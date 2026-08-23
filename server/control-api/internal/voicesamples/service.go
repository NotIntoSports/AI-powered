package voicesamples

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"time"

	"github.com/ai-interviewer/ai-powered/control-api/internal/database"
	"github.com/ai-interviewer/ai-powered/control-api/internal/objectstore"
	"github.com/ai-interviewer/ai-powered/control-api/internal/secretbox"
	"github.com/ai-interviewer/ai-powered/control-api/internal/settings"
)

const (
	// 阿里云复刻要求 5~20 秒音频，桌面端 24kHz/16bit 单声道 WAV 上限约 10MB，与简历上传一致。
	MaxBytes      = 10 << 20
	presignExpiry = 30 * time.Minute
)

var (
	ErrNotConfigured = errors.New("object storage is not configured")
	ErrInvalidInput  = errors.New("invalid voice sample")
	ErrTooLarge      = errors.New("voice sample is too large")
	ErrUnsupported   = errors.New("unsupported voice sample type")
	ErrStore         = errors.New("voice sample store unavailable")
	ErrUpload        = errors.New("voice sample upload failed")
	ErrPresign       = errors.New("voice sample presign failed")
	ErrDelete        = errors.New("voice sample delete failed")
)

type UploadResult struct {
	ID        string `json:"id"`
	URL       string `json:"url"`
	SizeBytes int64  `json:"sizeBytes"`
	ExpiresIn int64  `json:"expiresIn"`
}

type ObjectClient interface {
	PutObject(ctx context.Context, creds objectstore.Credentials, key, contentType string, body io.Reader) error
	PresignGet(ctx context.Context, creds objectstore.Credentials, key string, expiry time.Duration) (string, error)
	DeleteObject(ctx context.Context, creds objectstore.Credentials, key string) error
}

type Service struct {
	box             *secretbox.Box
	db              database.DBTX
	objects         ObjectClient
	loadCredentials func(context.Context) (objectstore.Credentials, error)
}

func NewService(db database.DBTX, box *secretbox.Box, objects ObjectClient) *Service {
	if objects == nil {
		objects = objectstore.NewCOS()
	}
	return &Service{db: db, box: box, objects: objects}
}

// Upload 把声音刻录样本存入 COS（voice-samples/<id>.wav），返回约 30 分钟有效的预签名 GET URL。
// COS 密钥不下发客户端，阿里云复刻服务通过该 URL 拉取音频。
func (s *Service) Upload(ctx context.Context, body io.Reader) (UploadResult, error) {
	creds, err := s.credentials(ctx)
	if err != nil {
		return UploadResult{}, err
	}
	payload, err := readSample(body)
	if err != nil {
		return UploadResult{}, err
	}
	id, err := randomID()
	if err != nil {
		return UploadResult{}, ErrStore
	}
	objectKey := "voice-samples/" + id + ".wav"
	if err := s.objects.PutObject(ctx, creds, objectKey, "audio/wav", bytes.NewReader(payload)); err != nil {
		return UploadResult{}, ErrUpload
	}
	url, err := s.objects.PresignGet(ctx, creds, objectKey, presignExpiry)
	if err != nil {
		_ = s.objects.DeleteObject(ctx, creds, objectKey)
		return UploadResult{}, ErrPresign
	}
	return UploadResult{
		ID:        id,
		URL:       url,
		SizeBytes: int64(len(payload)),
		ExpiresIn: int64(presignExpiry / time.Second),
	}, nil
}

// Delete 复刻完成后立即清理样本。ID 即对象名，仅允许删除 voice-samples 前缀对象。
func (s *Service) Delete(ctx context.Context, id string) error {
	if !validSampleID(id) {
		return ErrInvalidInput
	}
	creds, err := s.credentials(ctx)
	if err != nil {
		return err
	}
	if err := s.objects.DeleteObject(ctx, creds, "voice-samples/"+id+".wav"); err != nil {
		return ErrDelete
	}
	return nil
}

func (s *Service) credentials(ctx context.Context) (objectstore.Credentials, error) {
	if s.loadCredentials != nil {
		return s.loadCredentials(ctx)
	}
	store := settings.NewStore(s.db, s.box)
	record, err := store.GetStorage(ctx)
	if errors.Is(err, settings.ErrNotConfigured) {
		return objectstore.Credentials{}, ErrNotConfigured
	}
	if err != nil {
		return objectstore.Credentials{}, ErrStore
	}
	secretKey, err := store.DecryptSecretKey(record)
	if err != nil {
		return objectstore.Credentials{}, ErrStore
	}
	public := settings.PublicStorageFrom(record, err)
	if !public.Available || secretKey == "" {
		return objectstore.Credentials{}, ErrNotConfigured
	}
	return objectstore.Credentials{
		SecretID:  record.SecretID,
		SecretKey: secretKey,
		Region:    record.Region,
		Bucket:    record.Bucket,
	}, nil
}

func readSample(body io.Reader) ([]byte, error) {
	payload, err := io.ReadAll(io.LimitReader(body, MaxBytes+1))
	if err != nil {
		return nil, ErrInvalidInput
	}
	if len(payload) == 0 {
		return nil, ErrInvalidInput
	}
	if len(payload) > MaxBytes {
		return nil, ErrTooLarge
	}
	if len(payload) < 44 || string(payload[0:4]) != "RIFF" || string(payload[8:12]) != "WAVE" {
		return nil, ErrUnsupported
	}
	return payload, nil
}

func validSampleID(id string) bool {
	if len(id) != 32 {
		return false
	}
	for _, char := range id {
		if !(char >= '0' && char <= '9') && !(char >= 'a' && char <= 'f') {
			return false
		}
	}
	return true
}

func randomID() (string, error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}
